import asyncio
import json
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core import MatchConditions
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError, ServiceRequestError
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import sessions_store  # noqa: E402

OWNER = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
TENANT = "33333333-3333-3333-3333-333333333333"
ABROAD = f"{TENANT}/{OWNER}"
HOME = f"users/{OWNER}"
OPERATIONS = [
    "create_session", "list_sessions", "get_session", "save_session", "create_task", "get_task",
    "list_tasks", "save_task", "save_base", "load_base", "append_event", "read_events",
    "append_apply", "read_applies", "unfinished_tasks",
]
METADATA_LIMIT = 8192


class FakeContainer:
    """The subset of ContainerClient the store uses, with Azure's create-if-absent and append rules."""

    def __init__(self):
        self.blobs = {}
        self.downloads = []
        self.lists = []
        self.list_delay = 0
        self.property_reads = 0
        self.failure = None
        self.append_barrier = None
        self.create_delay = 0
        self._creators = 0
        self._lock = threading.Lock()
        self._last = datetime.now(timezone.utc)

    def _enter(self):
        if self.failure:
            raise self.failure
        self._lock.acquire()
        self._last = max(datetime.now(timezone.utc), self._last + timedelta(microseconds=1))
        return self._last

    @staticmethod
    def checked(metadata):
        """Azure sends metadata as HTTP headers: ASCII only and at most 8 KB in all."""
        metadata = dict(metadata or {})
        for key, value in metadata.items():
            value.encode("ascii")
        if sum(len(key) + len(value) for key, value in metadata.items()) > METADATA_LIMIT:
            raise ValueError("The metadata is too large.")
        return metadata

    def upload_blob(self, name, data, overwrite=False, metadata=None):
        stamp = self._enter()
        try:
            if name in self.blobs and not overwrite:
                raise ResourceExistsError(message="The specified blob already exists.")
            self.blobs[name] = {"data": bytes(data), "append": False, "modified": stamp, "metadata": self.checked(metadata)}
        finally:
            self._lock.release()

    def download_blob(self, name):
        self._enter()
        try:
            self.downloads.append(name)
            if name not in self.blobs:
                raise ResourceNotFoundError(message="The specified blob does not exist.")
            data = self.blobs[name]["data"]
            return SimpleNamespace(readall=lambda: data)
        finally:
            self._lock.release()

    def list_blobs(self, name_starts_with=None, include=None):
        self._enter()
        try:
            self.lists.append((name_starts_with, include))
            with_metadata = "metadata" in (include or [])
            listing = [
                SimpleNamespace(
                    name=name,
                    last_modified=blob["modified"],
                    metadata=dict(blob["metadata"]) if with_metadata else None,
                )
                for name, blob in sorted(self.blobs.items())
                if not name_starts_with or name.startswith(name_starts_with)
            ]
        finally:
            self._lock.release()
        if self.list_delay:
            time.sleep(self.list_delay)
        return listing

    def get_blob_client(self, name):
        container = self

        class Client:
            def get_blob_properties(self):
                container._enter()
                try:
                    container.property_reads += 1
                    if name not in container.blobs:
                        raise ResourceNotFoundError(message="The specified blob does not exist.")
                    blob = container.blobs[name]
                    return SimpleNamespace(metadata=dict(blob["metadata"]), last_modified=blob["modified"])
                finally:
                    container._lock.release()

            def set_blob_metadata(self, metadata=None):
                stamp = container._enter()
                try:
                    if name not in container.blobs:
                        raise ResourceNotFoundError(message="The specified blob does not exist.")
                    container.blobs[name]["metadata"] = container.checked(metadata)
                    container.blobs[name]["modified"] = stamp
                finally:
                    container._lock.release()

            def append_block(self, data):
                stamp = container._enter()
                try:
                    blob = container.blobs.get(name)
                    missing = blob is None or not blob["append"]
                    if not missing:
                        blob["data"] += bytes(data)
                        blob["modified"] = stamp
                finally:
                    container._lock.release()
                if missing:
                    if container.append_barrier:
                        container.append_barrier.wait(5)
                    raise ResourceNotFoundError(message="The specified blob does not exist.")

            def create_append_blob(self, match_condition=None):
                if container.create_delay:
                    with container._lock:
                        turn, container._creators = container._creators, container._creators + 1
                    time.sleep(container.create_delay * turn)
                stamp = container._enter()
                try:
                    if name in container.blobs and match_condition == MatchConditions.IfMissing:
                        raise ResourceExistsError(message="The specified blob already exists.")
                    container.blobs[name] = {"data": b"", "append": True, "modified": stamp, "metadata": {}}
                finally:
                    container._lock.release()

        return Client()


class StoreCase(unittest.IsolatedAsyncioTestCase):
    def make_stores(self):
        container = FakeContainer()
        with mock.patch.object(
            sessions_store.ContainerClient, "from_container_url", return_value=container
        ):
            blob = sessions_store.BlobSessionsStore("https://example.blob.core.windows.net/sessions", object())
        return {"memory": sessions_store.MemorySessionsStore(), "blob": blob}, container


class StoreContractTests(StoreCase):
    async def test_sessions_are_created_listed_most_recent_first_and_updated(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                first = await store.create_session(OWNER, "First")
                await asyncio.sleep(0.002)
                second = await store.create_session(OWNER, "Second")

                self.assertRegex(first["id"], r"^[0-9a-f]{12}$")
                self.assertEqual(
                    {k: first[k] for k in ("title", "conversationId")}, {"title": "First", "conversationId": None}
                )
                listed = await store.list_sessions(OWNER)
                self.assertEqual([s["id"] for s in listed], [second["id"], first["id"]])
                self.assertEqual(set(listed[0]), {"id", "title", "createdAt", "taskCount", "lastTaskAt", "openTask"})
                self.assertEqual((listed[0]["taskCount"], listed[0]["lastTaskAt"]), (0, None))

                await asyncio.sleep(0.002)
                await store.create_task(OWNER, first["id"], {"type": "review"})
                listed = await store.list_sessions(OWNER)
                self.assertEqual([s["id"] for s in listed], [first["id"], second["id"]])
                self.assertEqual(listed[0]["taskCount"], 1)
                self.assertRegex(listed[0]["lastTaskAt"], r"^\d{4}-\d\d-\d\dT.*Z$")

                await store.save_session(OWNER, {**first, "conversationId": "conv-1"})
                self.assertEqual((await store.get_session(OWNER, first["id"]))["conversationId"], "conv-1")
                self.assertIsNone(await store.get_session(OWNER, "nope"))
                with self.assertRaises(sessions_store.SessionNotFound):
                    await store.save_session(OWNER, {**first, "id": "missing"})

    async def test_tasks_are_numbered_per_session_and_round_trip(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                one = await store.create_session(OWNER, "One")
                two = await store.create_session(OWNER, "Two")

                a = await store.create_task(OWNER, one["id"], {"type": "review", "status": "running"})
                b = await store.create_task(OWNER, one["id"], {"type": "explain", "status": "running"})
                c = await store.create_task(OWNER, two["id"], {"type": "design", "status": "running"})

                self.assertEqual([(t["seq"], t["id"]) for t in (a, b, c)], [(1, "1"), (2, "2"), (1, "1")])
                self.assertEqual((a["sessionId"], c["sessionId"]), (one["id"], two["id"]))
                self.assertEqual(await store.get_task(OWNER, one["id"], 2), b)
                self.assertIsNone(await store.get_task(OWNER, one["id"], 3))
                self.assertIsNone(await store.get_task(OWNER, "nope", 1))

                await store.save_task(OWNER, one["id"], {**a, "status": "done", "result": {"kind": "diff", "x": "é"}})
                tasks = await store.list_tasks(OWNER, one["id"])
                self.assertEqual([(t["seq"], t["status"]) for t in tasks], [(1, "done"), (2, "running")])
                self.assertEqual(tasks[0]["result"]["x"], "é")
                self.assertEqual(await store.list_tasks(OWNER, "nope"), [])
                with self.assertRaises(sessions_store.SessionNotFound):
                    await store.create_task(OWNER, "nope", {"type": "review"})

    async def test_concurrent_task_creation_never_reuses_a_number(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                session = await store.create_session(OWNER, "Busy")

                tasks = await asyncio.gather(*[store.create_task(OWNER, session["id"], {"n": n}) for n in range(8)])

                self.assertEqual(sorted(t["seq"] for t in tasks), list(range(1, 9)))
                self.assertEqual(len(await store.list_tasks(OWNER, session["id"])), 8)

    async def test_base_events_and_applies_round_trip_per_task(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                session = (await store.create_session(OWNER, "S"))["id"]
                await store.create_task(OWNER, session, {})
                await store.create_task(OWNER, session, {})
                raw = {"entities": [{"name": "é-entity", "properties": {"a": [1, 2.5, None]}}], "signalDefinitions": [], "relationships": []}

                await store.save_base(OWNER, session, 1, raw)
                for seq in range(1, 6):
                    await store.append_event(OWNER, session, 1, {"seq": seq, "kind": "text", "summary": f"e{seq}", "payload": {}})
                await store.append_event(OWNER, session, 2, {"seq": 1, "kind": "status", "summary": "other", "payload": {}})
                await store.append_apply(OWNER, session, 1, {"outcome": "applied", "written": ["c1"]})
                await store.append_apply(OWNER, session, 1, {"outcome": "partial", "written": []})

                self.assertEqual(await store.load_base(OWNER, session, 1), raw)
                self.assertIsNone(await store.load_base(OWNER, session, 2))
                self.assertEqual([e["seq"] for e in await store.read_events(OWNER, session, 1)], [1, 2, 3, 4, 5])
                self.assertEqual([e["seq"] for e in await store.read_events(OWNER, session, 1, 3)], [4, 5])
                self.assertEqual(await store.read_events(OWNER, session, 1, 5), [])
                self.assertEqual([e["summary"] for e in await store.read_events(OWNER, session, 2)], ["other"])
                self.assertEqual(await store.read_events(OWNER, session, 3), [])
                self.assertEqual([a["outcome"] for a in await store.read_applies(OWNER, session, 1)], ["applied", "partial"])
                self.assertEqual(await store.read_applies(OWNER, session, 2), [])

    async def test_the_session_and_task_caps_are_enforced(self):
        stores, _ = self.make_stores()
        with mock.patch.object(sessions_store, "MAX_SESSIONS", 3), mock.patch.object(sessions_store, "MAX_TASKS_PER_SESSION", 2):
            for label, store in stores.items():
                with self.subTest(store=label):
                    first, second, third = [await store.create_session(OWNER, name) for name in ("A", "B", "C")]

                    with self.assertRaises(sessions_store.SessionLimit):
                        await store.create_session(OWNER, "D")
                    self.assertEqual(len(await store.list_sessions(OWNER)), 3)

                    await store.create_task(OWNER, first["id"], {"n": 1})
                    await store.create_task(OWNER, first["id"], {"n": 2})
                    with self.assertRaises(sessions_store.TaskLimit):
                        await store.create_task(OWNER, first["id"], {"n": 3})
                    other = await store.create_task(OWNER, second["id"], {"n": 1})

                    self.assertEqual(len(await store.list_tasks(OWNER, first["id"])), 2)
                    self.assertEqual(other["seq"], 1)
                    self.assertEqual({s["id"]: s["taskCount"] for s in await store.list_sessions(OWNER)}, {first["id"]: 2, second["id"]: 1, third["id"]: 0})

    async def test_concurrent_session_creation_cannot_pass_the_cap(self):
        stores, container = self.make_stores()
        container.list_delay = 0.02
        with mock.patch.object(sessions_store, "MAX_SESSIONS", 3):
            for label, store in stores.items():
                with self.subTest(store=label):
                    results = await asyncio.gather(*[store.create_session(OWNER, f"S{n}") for n in range(8)], return_exceptions=True)

                    self.assertEqual(len([r for r in results if isinstance(r, dict)]), 3)
                    self.assertEqual(len([r for r in results if isinstance(r, sessions_store.SessionLimit)]), 5)
                    self.assertEqual(len(await store.list_sessions(OWNER)), 3)

    async def test_summaries_follow_task_creation_and_completion(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                title = "Prüfung 日本語 \U0001F680 " + "é" * 100
                session = await store.create_session(OWNER, title)
                (empty,) = await store.list_sessions(OWNER)
                task = await store.create_task(OWNER, session["id"], {"status": "running"})
                await asyncio.sleep(0.002)
                (created,) = await store.list_sessions(OWNER)
                await store.save_task(OWNER, session["id"], {**task, "base": {"fingerprint": "f"}})
                (midway,) = await store.list_sessions(OWNER)
                await asyncio.sleep(0.002)
                await store.save_task(OWNER, session["id"], {**task, "status": "done"})
                (finished,) = await store.list_sessions(OWNER)
                await store.create_task(OWNER, session["id"], {"status": "running"})
                (second,) = await store.list_sessions(OWNER)

                self.assertEqual(empty, {"id": session["id"], "title": title, "createdAt": session["createdAt"], "taskCount": 0, "lastTaskAt": None, "openTask": None})
                self.assertEqual((created["taskCount"], created["title"]), (1, title))
                self.assertGreaterEqual(created["lastTaskAt"], session["createdAt"])
                self.assertEqual(midway, created)
                self.assertGreater(finished["lastTaskAt"], created["lastTaskAt"])
                self.assertEqual((finished["taskCount"], second["taskCount"]), (1, 2))
                self.assertGreater(second["lastTaskAt"], finished["lastTaskAt"])
                self.assertEqual(set(second), {"id", "title", "createdAt", "taskCount", "lastTaskAt", "openTask"})
                # The running Task of a Session is named in its summary: nothing before it starts, its seq while it runs, nothing once it is done.
                self.assertEqual((empty["openTask"], created["openTask"], finished["openTask"], second["openTask"]), (None, 1, None, 2))

    async def test_unfinished_tasks_are_found_across_sessions_and_only_those(self):
        stores, container = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                one, two, three, _ = [await store.create_session(OWNER, name) for name in "ABCD"]
                first = await store.create_task(OWNER, one["id"], {"status": "running"})
                await store.save_task(OWNER, one["id"], {**first, "status": "done"})
                await store.create_task(OWNER, one["id"], {"status": "running"})
                await store.create_task(OWNER, two["id"], {"status": "queued"})
                finished = await store.create_task(OWNER, three["id"], {"status": "running"})
                await store.save_task(OWNER, three["id"], {**finished, "status": "failed"})
                container.downloads.clear()

                found = await store.unfinished_tasks()

                self.assertEqual(sorted((o, t["sessionId"], t["seq"], t["status"]) for o, t in found),
                                 sorted([(OWNER, one["id"], 2, "running"), (OWNER, two["id"], 1, "queued")]))
                if label == "blob":
                    self.assertEqual(sorted(container.downloads), sorted([f"{HOME}/{one['id']}/tasks/2/task.json", f"{HOME}/{two['id']}/tasks/1/task.json"]))
                for owner, task in found:
                    await store.save_task(owner, task["sessionId"], {**task, "status": "failed"})
                self.assertEqual(await store.unfinished_tasks(), [])
                self.assertEqual(len(await store.list_sessions(OWNER)), 4)

    async def test_nothing_of_one_owner_is_visible_to_another(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                session = await store.create_session(OWNER, "Mine")
                sid = session["id"]
                task = await store.create_task(OWNER, sid, {"status": "done"})
                await store.save_base(OWNER, sid, 1, {"entities": []})
                await store.append_event(OWNER, sid, 1, {"seq": 1})
                await store.append_apply(OWNER, sid, 1, {"outcome": "applied"})
                await store.create_session(OTHER, "Theirs")

                self.assertEqual([s["title"] for s in await store.list_sessions(OTHER)], ["Theirs"])
                self.assertEqual([s["title"] for s in await store.list_sessions(OWNER)], ["Mine"])
                self.assertIsNone(await store.get_session(OTHER, sid))
                self.assertIsNone(await store.get_task(OTHER, sid, 1))
                self.assertIsNone(await store.load_base(OTHER, sid, 1))
                self.assertEqual(await store.list_tasks(OTHER, sid), [])
                self.assertEqual(await store.read_events(OTHER, sid, 1), [])
                self.assertEqual(await store.read_applies(OTHER, sid, 1), [])
                with self.assertRaises(sessions_store.SessionNotFound):
                    await store.create_task(OTHER, sid, {"status": "running"})
                with self.assertRaises(sessions_store.SessionNotFound):
                    await store.save_session(OTHER, {**session, "title": "Taken"})
                self.assertEqual((await store.get_session(OWNER, sid))["title"], "Mine")
                self.assertEqual(await store.get_task(OWNER, sid, 1), task)

    async def test_the_limits_count_per_owner(self):
        stores, _ = self.make_stores()
        with mock.patch.object(sessions_store, "MAX_SESSIONS", 2), mock.patch.object(sessions_store, "MAX_TASKS_PER_SESSION", 2):
            for label, store in stores.items():
                with self.subTest(store=label):
                    for _ in range(2):
                        await store.create_session(OWNER, "x")
                    with self.assertRaises(sessions_store.SessionLimit):
                        await store.create_session(OWNER, "x")
                    theirs = await store.create_session(OTHER, "y")
                    await store.create_task(OTHER, theirs["id"], {})
                    await store.create_task(OTHER, theirs["id"], {})
                    with self.assertRaises(sessions_store.TaskLimit):
                        await store.create_task(OTHER, theirs["id"], {})
                    mine = (await store.list_sessions(OWNER))[0]["id"]

                    again = await store.create_task(OWNER, mine, {})

                    self.assertEqual(again["seq"], 1)
                    self.assertEqual(len(await store.list_sessions(OTHER)), 1)

    async def test_unfinished_tasks_are_found_for_every_owner_with_their_owner(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                mine = await store.create_session(OWNER, "A")
                theirs = await store.create_session(OTHER, "B")
                await store.create_task(OWNER, mine["id"], {"status": "running"})
                await store.create_task(OTHER, theirs["id"], {"status": "running"})

                found = await store.unfinished_tasks()

                self.assertEqual(sorted((owner, task["sessionId"]) for owner, task in found), sorted([(OWNER, mine["id"]), (OTHER, theirs["id"])]))

    async def test_returned_documents_are_copies(self):
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                session = await store.create_session(OWNER, "S")
                task = await store.create_task(OWNER, session["id"], {"status": "running", "target": {"name": "m"}})

                task["target"]["name"] = "changed"
                session["title"] = "changed"

                self.assertEqual((await store.get_task(OWNER, session["id"], 1))["target"]["name"], "m")
                self.assertEqual((await store.get_session(OWNER, session["id"]))["title"], "S")

    async def test_nothing_can_be_deleted(self):
        words = ("delete", "remove", "clear", "drop", "purge", "reset")
        for cls in (sessions_store.MemorySessionsStore, sessions_store.BlobSessionsStore):
            with self.subTest(store=cls.__name__):
                self.assertEqual([n for n in dir(cls) if any(w in n.lower() for w in words)], [])
        self.assertEqual(
            [n for n in dir(FakeContainer) if "delete" in n], [], "the fake would reveal any delete call by AttributeError"
        )

    async def test_spans_name_every_operation(self):
        exporter = InMemorySpanExporter()
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        stores, _ = self.make_stores()
        for label, store in stores.items():
            with self.subTest(store=label):
                exporter.clear()
                session = (await store.create_session(OWNER, "S"))["id"]
                await store.list_sessions(OWNER)
                await store.get_session(OWNER, session)
                await store.save_session(OWNER, await store.get_session(OWNER, session))
                task = await store.create_task(OWNER, session, {})
                await store.get_task(OWNER, session, 1)
                await store.list_tasks(OWNER, session)
                await store.save_task(OWNER, session, task)
                await store.unfinished_tasks()
                await store.save_base(OWNER, session, 1, {})
                await store.load_base(OWNER, session, 1)
                await store.append_event(OWNER, session, 1, {"seq": 1})
                await store.read_events(OWNER, session, 1)
                await store.append_apply(OWNER, session, 1, {})
                await store.read_applies(OWNER, session, 1)

                spans = exporter.get_finished_spans()

                self.assertEqual(sorted(s.name for s in spans), sorted(f"sessions.store.{op}" for op in OPERATIONS + ["get_session"]))
                self.assertTrue(all(s.kind == SpanKind.CLIENT for s in spans))


class BlobStoreTests(StoreCase):
    async def test_blob_layout_matches_the_plan(self):
        (stores, container) = self.make_stores()
        store = stores["blob"]
        session = (await store.create_session(OWNER, "S"))["id"]
        await store.create_task(OWNER, session, {"type": "review"})
        await store.save_base(OWNER, session, 1, {"entities": []})
        for seq in (1, 2, 3):
            await store.append_event(OWNER, session, 1, {"seq": seq})
        await store.append_apply(OWNER, session, 1, {"outcome": "applied"})

        self.assertEqual(
            sorted(container.blobs),
            sorted(
                f"{HOME}/{session}/{path}"
                for path in (
                    "session.json",
                    "tasks/1/task.json",
                    "tasks/1/base.json",
                    "tasks/1/events.jsonl",
                    "tasks/1/applies.jsonl",
                )
            ),
        )
        events = container.blobs[f"{HOME}/{session}/tasks/1/events.jsonl"]
        self.assertTrue(events["append"])
        self.assertEqual([json.loads(line) for line in events["data"].decode().splitlines()], [{"seq": 1}, {"seq": 2}, {"seq": 3}])
        self.assertFalse(container.blobs[f"{HOME}/{session}/tasks/1/task.json"]["append"])
        self.assertEqual(json.loads(container.blobs[f"{HOME}/{session}/session.json"]["data"])["title"], "S")

    async def test_listing_sessions_is_one_list_call_and_downloads_nothing(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        for title in ("A", "B", "C"):
            session = await store.create_session(OWNER, title)
            for _ in range(2):
                task = await store.create_task(OWNER, session["id"], {"status": "running"})
                await store.save_task(OWNER, session["id"], {**task, "status": "done"})
            await store.save_base(OWNER, session["id"], 1, {})
            await store.append_event(OWNER, session["id"], 1, {"seq": 1})
        container.downloads.clear()
        container.lists.clear()
        container.property_reads = 0

        listed = await store.list_sessions(OWNER)

        self.assertEqual(container.lists, [(f"{HOME}/", ["metadata"])])
        self.assertEqual((container.downloads, container.property_reads), ([], 0))
        self.assertEqual([(s["title"], s["taskCount"]) for s in sorted(listed, key=lambda s: s["title"])], [("A", 2), ("B", 2), ("C", 2)])

    async def test_saving_a_session_keeps_its_summary(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = await store.create_session(OWNER, "Kept")
        task = await store.create_task(OWNER, session["id"], {"status": "running"})
        await store.save_task(OWNER, session["id"], {**task, "status": "done"})
        (before,) = await store.list_sessions(OWNER)

        await store.save_session(OWNER, {**session, "conversationId": "conv-1"})

        (after,) = await store.list_sessions(OWNER)
        self.assertEqual(after, before)
        self.assertEqual(after["taskCount"], 1)
        self.assertEqual((await store.get_session(OWNER, session["id"]))["conversationId"], "conv-1")
        self.assertEqual(list(container.blobs[f"{HOME}/{session['id']}/session.json"]["metadata"]), ["summary"])

    async def test_summaries_live_in_ascii_metadata_on_the_session_blob_only(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = await store.create_session(OWNER, "é")
        await store.create_task(OWNER, session["id"], {"status": "running"})

        carriers = {name for name, blob in container.blobs.items() if blob["metadata"]}

        self.assertEqual(carriers, {f"{HOME}/{session['id']}/session.json"})
        value = container.blobs[f"{HOME}/{session['id']}/session.json"]["metadata"]["summary"]
        self.assertTrue(value.isascii())
        self.assertEqual(json.loads(value)["openTask"], 1)

    async def test_a_stale_open_marker_does_not_make_a_finished_task_unfinished(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = await store.create_session(OWNER, "S")
        task = await store.create_task(OWNER, session["id"], {"status": "running"})
        container.blobs[f"{HOME}/{session['id']}/tasks/1/task.json"]["data"] = json.dumps({**task, "status": "done"}).encode()

        self.assertEqual(await store.unfinished_tasks(), [])

    async def test_blobs_from_before_owners_existed_are_ignored(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        legacy = {"title": "Old", "createdAt": "2026-11-01T00:00:00Z", "taskCount": 1, "lastTaskAt": None, "openTask": 1}
        container.blobs["abc123abc123/session.json"] = {"data": b"{}", "append": False, "modified": datetime.now(timezone.utc), "metadata": sessions_store.encode_summary(legacy)}
        container.blobs["abc123abc123/tasks/1/task.json"] = {"data": b'{"status":"running","seq":1}', "append": False, "modified": datetime.now(timezone.utc), "metadata": {}}

        self.assertEqual(await store.list_sessions(OWNER), [])
        self.assertEqual(await store.unfinished_tasks(), [])
        self.assertIsNone(await store.get_session(OWNER, "abc123abc123"))
        with mock.patch.object(sessions_store, "MAX_SESSIONS", 1):
            await store.create_session(OWNER, "New")

    async def test_the_owner_is_checked_before_it_becomes_part_of_a_blob_name(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        for owner in ("", "../x", "/a", "a/", "a//b", "a/b/c", "a/../b", "a b", "x" * 65, "ü", f"{OWNER}/{OWNER}/{OWNER}"):
            with self.subTest(owner=owner):
                with self.assertRaises(ValueError):
                    await store.list_sessions(owner)
                with self.assertRaises(ValueError):
                    await store.create_session(owner, "x")
        self.assertEqual(container.blobs, {})

    async def test_a_user_of_another_directory_is_a_different_owner_with_the_same_object_id(self):
        for kind, store in (("memory", self.make_stores()[0]["memory"]), ("blob", self.make_stores()[0]["blob"])):
            with self.subTest(store=kind):
                home = await store.create_session(OWNER, "Home")
                abroad = await store.create_session(ABROAD, "Abroad")
                await store.create_task(ABROAD, abroad["id"], {"status": "running", "type": "review"})

                self.assertEqual([s["title"] for s in await store.list_sessions(OWNER)], ["Home"])
                self.assertEqual([s["title"] for s in await store.list_sessions(ABROAD)], ["Abroad"])
                self.assertIsNone(await store.get_session(OWNER, abroad["id"]))
                self.assertIsNone(await store.get_session(ABROAD, home["id"]))
                self.assertEqual(await store.list_tasks(OWNER, abroad["id"]), [])
                self.assertEqual([(owner, task["sessionId"]) for owner, task in await store.unfinished_tasks()], [(ABROAD, abroad["id"])])

    async def test_the_blobs_of_another_directory_live_under_its_tenant_id_and_the_home_ones_stay_where_they_were(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        home = await store.create_session(OWNER, "Home")
        abroad = await store.create_session(ABROAD, "Abroad")
        await store.create_task(ABROAD, abroad["id"], {"status": "running"})
        await store.append_event(ABROAD, abroad["id"], 1, {"seq": 1, "kind": "text", "summary": "e", "payload": {}})

        self.assertEqual(
            sorted(container.blobs),
            sorted(
                [
                    f"users/{OWNER}/{home['id']}/session.json",
                    f"users/{TENANT}/{OWNER}/{abroad['id']}/session.json",
                    f"users/{TENANT}/{OWNER}/{abroad['id']}/tasks/1/task.json",
                    f"users/{TENANT}/{OWNER}/{abroad['id']}/tasks/1/events.jsonl",
                ]
            ),
        )

    async def test_listing_one_owner_never_reads_another_owners_blobs(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        theirs = await store.create_session(OTHER, "Theirs")
        await store.create_task(OTHER, theirs["id"], {"status": "running"})
        container.lists.clear()
        container.downloads.clear()

        listed = await store.list_sessions(OWNER)

        self.assertEqual(listed, [])
        self.assertEqual(container.lists, [(f"{HOME}/", ["metadata"])])
        self.assertEqual(container.downloads, [])

    async def test_a_session_whose_summary_is_missing_is_left_out_of_the_listing(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        kept = await store.create_session(OWNER, "Kept")
        container.blobs[f"{HOME}/stray/session.json"] = {"data": b"{}", "append": False, "modified": datetime.now(timezone.utc), "metadata": {}}

        listed = await store.list_sessions(OWNER)

        self.assertEqual([s["id"] for s in listed], [kept["id"]])

    async def test_task_numbers_skip_numbers_another_writer_took(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = (await store.create_session(OWNER, "S"))["id"]
        await store.create_task(OWNER, session, {})
        store._seqs = lambda owner, sid: []

        task = await store.create_task(OWNER, session, {})

        self.assertEqual(task["seq"], 2)
        self.assertIn(f"{HOME}/{session}/tasks/2/task.json", container.blobs)

    async def test_azure_failures_become_a_domain_error_naming_the_operation(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = (await store.create_session(OWNER, "S"))["id"]
        container.failure = ServiceRequestError("boom: SECRET")
        calls = [
            ("list_sessions", (OWNER,)),
            ("get_session", (OWNER, session)),
            ("create_task", (OWNER, session, {})),
            ("append_event", (OWNER, session, 1, {"seq": 1})),
            ("read_events", (OWNER, session, 1)),
            ("load_base", (OWNER, session, 1)),
        ]
        for operation, arguments in calls:
            with self.subTest(operation=operation):
                with self.assertRaises(sessions_store.StoreUnavailable) as caught:
                    await getattr(store, operation)(*arguments)

                self.assertEqual(caught.exception.operation, operation)
                self.assertNotIn("SECRET", str(caught.exception))

    async def test_appending_to_a_missing_blob_creates_it_once_and_keeps_existing_events(self):
        stores, container = self.make_stores()
        store = stores["blob"]
        session = (await store.create_session(OWNER, "S"))["id"]
        container.append_barrier = threading.Barrier(6)
        container.create_delay = 0.02

        await asyncio.gather(*[store.append_event(OWNER, session, 1, {"seq": n}) for n in range(1, 7)])

        lines = container.blobs[f"{HOME}/{session}/tasks/1/events.jsonl"]["data"].decode().splitlines()
        self.assertEqual(sorted(json.loads(line)["seq"] for line in lines), [1, 2, 3, 4, 5, 6])


if __name__ == "__main__":
    unittest.main()
