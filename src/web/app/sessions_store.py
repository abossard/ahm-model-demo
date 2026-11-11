import asyncio
import functools
import inspect
import json
import re
import threading
import uuid
from datetime import datetime, timezone

from azure.core import MatchConditions
from azure.core.exceptions import AzureError, ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import ContainerClient
from opentelemetry import trace
from opentelemetry.trace import SpanKind

from config import MAX_SESSIONS, MAX_TASKS_PER_SESSION
from dto import iso


tracer = trace.get_tracer("ahm-demo")

UNFINISHED = ("queued", "running")
SUMMARY_KEY = "summary"
OWNER = re.compile(r"[A-Za-z0-9-]{1,64}")


class SessionNotFound(Exception):
    pass


class SessionLimit(Exception):
    pass


class TaskLimit(Exception):
    pass


class StoreUnavailable(Exception):
    def __init__(self, operation):
        super().__init__(operation)
        self.operation = operation


def utc_now():
    return iso(datetime.now(timezone.utc))


def dumps(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def traced(cls):
    def wrap(operation, method):
        @functools.wraps(method)
        async def wrapper(self, *args, **kwargs):
            with tracer.start_as_current_span(
                f"sessions.store.{operation}", kind=SpanKind.CLIENT
            ):
                try:
                    return await method(self, *args, **kwargs)
                except AzureError as error:
                    raise StoreUnavailable(operation) from error

        return wrapper

    for name, method in list(vars(cls).items()):
        if not name.startswith("_") and inspect.iscoroutinefunction(method):
            setattr(cls, name, wrap(name, method))
    return cls


def home(owner):
    if not OWNER.fullmatch(owner):
        raise ValueError("The owner is not a valid user id.")
    return f"users/{owner}"


def encode_summary(summary):
    return {SUMMARY_KEY: json.dumps(summary, separators=(",", ":"))}


def decode_summary(metadata):
    text = (metadata or {}).get(SUMMARY_KEY)
    return json.loads(text) if text else None


def session_summary(session, count, last_task_at):
    return {
        "id": session["id"],
        "title": session["title"],
        "createdAt": session["createdAt"],
        "taskCount": count,
        "lastTaskAt": last_task_at,
    }


def most_recent_first(summaries):
    return sorted(
        summaries,
        key=lambda item: datetime.fromisoformat(item["lastTaskAt"] or item["createdAt"]),
        reverse=True,
    )


def new_session(title):
    return {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "createdAt": utc_now(),
        "conversationId": None,
    }


@traced
class MemorySessionsStore:
    def __init__(self):
        self._sessions = {}
        self._tasks = {}
        self._last = {}
        self._bases = {}
        self._events = {}
        self._applies = {}

    def _seqs(self, owner, sid):
        return sorted(seq for (o, s, seq) in self._tasks if (o, s) == (owner, sid))

    async def create_session(self, owner, title):
        if sum(1 for (o, _) in self._sessions if o == owner) >= MAX_SESSIONS:
            raise SessionLimit()
        session = new_session(title)
        self._sessions[(owner, session["id"])] = dumps(session)
        return json.loads(self._sessions[(owner, session["id"])])

    async def list_sessions(self, owner):
        return most_recent_first(
            [
                session_summary(json.loads(text), len(self._seqs(owner, sid)), self._last.get((owner, sid)))
                for (o, sid), text in self._sessions.items()
                if o == owner
            ]
        )

    async def get_session(self, owner, sid):
        text = self._sessions.get((owner, sid))
        return json.loads(text) if text else None

    async def save_session(self, owner, session):
        if (owner, session["id"]) not in self._sessions:
            raise SessionNotFound(session["id"])
        self._sessions[(owner, session["id"])] = dumps(session)

    async def create_task(self, owner, sid, fields):
        if (owner, sid) not in self._sessions:
            raise SessionNotFound(sid)
        seqs = self._seqs(owner, sid)
        if len(seqs) >= MAX_TASKS_PER_SESSION:
            raise TaskLimit(sid)
        seq = max(seqs, default=0) + 1
        task = {"id": str(seq), "sessionId": sid, "seq": seq, **fields}
        self._tasks[(owner, sid, seq)] = dumps(task)
        self._last[(owner, sid)] = utc_now()
        return json.loads(self._tasks[(owner, sid, seq)])

    async def get_task(self, owner, sid, seq):
        text = self._tasks.get((owner, sid, seq))
        return json.loads(text) if text else None

    async def list_tasks(self, owner, sid):
        return [json.loads(self._tasks[(owner, sid, seq)]) for seq in self._seqs(owner, sid)]

    async def unfinished_tasks(self):
        found = [(key[0], json.loads(text)) for key, text in sorted(self._tasks.items())]
        return [(owner, task) for owner, task in found if task.get("status") in UNFINISHED]

    async def save_task(self, owner, sid, task):
        self._tasks[(owner, sid, task["seq"])] = dumps(task)
        if task.get("status") not in UNFINISHED:
            self._last[(owner, sid)] = utc_now()

    async def save_base(self, owner, sid, seq, raw_model):
        self._bases[(owner, sid, seq)] = dumps(raw_model)

    async def load_base(self, owner, sid, seq):
        text = self._bases.get((owner, sid, seq))
        return json.loads(text) if text else None

    async def append_event(self, owner, sid, seq, event):
        self._events.setdefault((owner, sid, seq), []).append(dumps(event))

    async def read_events(self, owner, sid, seq, after=0):
        events = [json.loads(line) for line in self._events.get((owner, sid, seq), [])]
        return [event for event in events if event["seq"] > after]

    async def append_apply(self, owner, sid, seq, outcome):
        self._applies.setdefault((owner, sid, seq), []).append(dumps(outcome))

    async def read_applies(self, owner, sid, seq):
        return [json.loads(line) for line in self._applies.get((owner, sid, seq), [])]


@traced
class BlobSessionsStore:
    def __init__(self, container_url, credential):
        self._container = ContainerClient.from_container_url(
            container_url, credential=credential
        )
        self._creating = threading.Lock()

    def _read(self, name):
        try:
            return self._container.download_blob(name).readall().decode("utf-8")
        except ResourceNotFoundError:
            return None

    def _read_json(self, name):
        text = self._read(name)
        return None if text is None else json.loads(text)

    def _write(self, name, value, overwrite=True, metadata=None):
        self._container.upload_blob(
            name, dumps(value).encode("utf-8"), overwrite=overwrite, metadata=metadata
        )

    def _append(self, name, value):
        blob = self._container.get_blob_client(name)
        data = (dumps(value) + "\n").encode("utf-8")
        try:
            blob.append_block(data)
        except ResourceNotFoundError:
            try:
                blob.create_append_blob(match_condition=MatchConditions.IfMissing)
            except ResourceExistsError:
                pass
            blob.append_block(data)

    def _lines(self, name):
        text = self._read(name)
        return [json.loads(line) for line in (text or "").splitlines() if line.strip()]

    def _seqs(self, owner, sid):
        seqs = []
        for blob in self._container.list_blobs(name_starts_with=f"{home(owner)}/{sid}/tasks/"):
            parts = blob.name.split("/")
            if len(parts) == 6 and parts[5] == "task.json" and parts[4].isdigit():
                seqs.append(int(parts[4]))
        return sorted(seqs)

    def _summaries(self, owner=None):
        found = []
        prefix = "users/" if owner is None else f"{home(owner)}/"
        for blob in self._container.list_blobs(name_starts_with=prefix, include=["metadata"]):
            parts = blob.name.split("/")
            summary = decode_summary(blob.metadata)
            if len(parts) == 4 and parts[3] == "session.json" and summary:
                found.append((parts[1], parts[2], summary))
        return found

    def _summary_of(self, owner, sid):
        try:
            properties = self._container.get_blob_client(
                f"{home(owner)}/{sid}/session.json"
            ).get_blob_properties()
        except ResourceNotFoundError:
            raise SessionNotFound(sid) from None
        return decode_summary(properties.metadata) or {}

    def _set_summary(self, owner, sid, summary):
        self._container.get_blob_client(f"{home(owner)}/{sid}/session.json").set_blob_metadata(
            encode_summary(summary)
        )

    def _create_session(self, owner, title):
        session = new_session(title)
        summary = {
            "title": title,
            "createdAt": session["createdAt"],
            "taskCount": 0,
            "lastTaskAt": None,
            "openTask": None,
        }
        with self._creating:
            if len(self._summaries(owner)) >= MAX_SESSIONS:
                raise SessionLimit()
            self._write(
                f"{home(owner)}/{session['id']}/session.json", session, False, encode_summary(summary)
            )
        return session

    def _list_sessions(self, owner):
        return most_recent_first(
            [
                {"id": sid, **{k: summary[k] for k in ("title", "createdAt", "taskCount", "lastTaskAt")}}
                for _, sid, summary in self._summaries(owner)
            ]
        )

    def _unfinished_tasks(self):
        found = [
            (owner, self._read_json(f"{home(owner)}/{sid}/tasks/{summary['openTask']}/task.json"))
            for owner, sid, summary in self._summaries()
            if summary.get("openTask")
        ]
        return [(owner, task) for owner, task in found if task and task.get("status") in UNFINISHED]

    def _create_task(self, owner, sid, fields):
        summary = self._summary_of(owner, sid)
        seqs = self._seqs(owner, sid)
        if len(seqs) >= MAX_TASKS_PER_SESSION:
            raise TaskLimit(sid)
        seq = max(seqs, default=0) + 1
        while True:
            task = {"id": str(seq), "sessionId": sid, "seq": seq, **fields}
            try:
                self._write(f"{home(owner)}/{sid}/tasks/{seq}/task.json", task, overwrite=False)
                break
            except ResourceExistsError:
                seq += 1
        self._set_summary(
            owner, sid, {**summary, "taskCount": seq, "lastTaskAt": utc_now(), "openTask": seq}
        )
        return task

    def _list_tasks(self, owner, sid):
        return [
            self._read_json(f"{home(owner)}/{sid}/tasks/{seq}/task.json")
            for seq in self._seqs(owner, sid)
        ]

    def _save_task(self, owner, sid, task):
        self._write(f"{home(owner)}/{sid}/tasks/{task['seq']}/task.json", task)
        if task.get("status") in UNFINISHED:
            return
        try:
            summary = self._summary_of(owner, sid)
        except SessionNotFound:
            return
        opened = None if summary.get("openTask") == task["seq"] else summary.get("openTask")
        self._set_summary(owner, sid, {**summary, "lastTaskAt": utc_now(), "openTask": opened})

    def _save_session(self, owner, session):
        summary = self._summary_of(owner, session["id"])
        self._write(
            f"{home(owner)}/{session['id']}/session.json", session, metadata=encode_summary(summary)
        )

    async def create_session(self, owner, title):
        return await asyncio.to_thread(self._create_session, owner, title)

    async def list_sessions(self, owner):
        return await asyncio.to_thread(self._list_sessions, owner)

    async def get_session(self, owner, sid):
        return await asyncio.to_thread(self._read_json, f"{home(owner)}/{sid}/session.json")

    async def save_session(self, owner, session):
        await asyncio.to_thread(self._save_session, owner, session)

    async def create_task(self, owner, sid, fields):
        return await asyncio.to_thread(self._create_task, owner, sid, fields)

    async def get_task(self, owner, sid, seq):
        return await asyncio.to_thread(self._read_json, f"{home(owner)}/{sid}/tasks/{seq}/task.json")

    async def list_tasks(self, owner, sid):
        return await asyncio.to_thread(self._list_tasks, owner, sid)

    async def unfinished_tasks(self):
        return await asyncio.to_thread(self._unfinished_tasks)

    async def save_task(self, owner, sid, task):
        await asyncio.to_thread(self._save_task, owner, sid, task)

    async def save_base(self, owner, sid, seq, raw_model):
        await asyncio.to_thread(self._write, f"{home(owner)}/{sid}/tasks/{seq}/base.json", raw_model)

    async def load_base(self, owner, sid, seq):
        return await asyncio.to_thread(self._read_json, f"{home(owner)}/{sid}/tasks/{seq}/base.json")

    async def append_event(self, owner, sid, seq, event):
        await asyncio.to_thread(self._append, f"{home(owner)}/{sid}/tasks/{seq}/events.jsonl", event)

    async def read_events(self, owner, sid, seq, after=0):
        lines = await asyncio.to_thread(self._lines, f"{home(owner)}/{sid}/tasks/{seq}/events.jsonl")
        return [event for event in lines if event["seq"] > after]

    async def append_apply(self, owner, sid, seq, outcome):
        await asyncio.to_thread(self._append, f"{home(owner)}/{sid}/tasks/{seq}/applies.jsonl", outcome)

    async def read_applies(self, owner, sid, seq):
        return await asyncio.to_thread(self._lines, f"{home(owner)}/{sid}/tasks/{seq}/applies.jsonl")
