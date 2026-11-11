import asyncio
import hashlib
import json
import logging
import secrets
from collections import deque
from datetime import datetime, timezone

from azure.core.exceptions import HttpResponseError
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

import activity
import model_diff
from config import (
    BROKER_CALLS_PER_MINUTE,
    BUSY_RETRY_SECONDS,
    FINAL_SAVE_DELAYS,
    INTERRUPTED_GRACE_SECONDS,
    MAX_CONCURRENT_RUNS,
    MAX_SUBSCRIBERS_PER_TASK,
    NONCE_BYTES,
    TASK_TIMEOUT_SECONDS,
)
from foundry_agent import AgentError, ConversationNotFound
from obo import ConsentRequired, InteractionRequired
from sessions_store import UNFINISHED, StoreUnavailable, utc_now


logger = logging.getLogger("ahm-demo")
tracer = trace.get_tracer("ahm-demo")

HEADLINES = {
    "review": "Review this health model and submit the result with submit_result.",
    "explain": "Explain why this entity has its health state and submit the result with submit_result.",
    "design": "Design a health model for this workload and submit the result with submit_result.",
}
INTERRUPTED_MESSAGE = "The task was interrupted before it finished."
SIGN_IN_AGAIN = "Your sign-in no longer allows this task to reach Azure. Sign in again and start the task again."
CONSENT_MISSING = "The app has not been approved to reach Azure for you yet. An administrator of your directory has to approve it for the organization."


class TaskRunning(Exception):
    pass


class UserBusy(TaskRunning):
    pass


class AgentsBusy(Exception):
    pass


class TooManySubscribers(Exception):
    pass


class TaskFailure(Exception):
    def __init__(self, code, message, reported=False, problems=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.reported = reported
        self.problems = problems


class Run:
    def __init__(self, caller):
        self.owner = caller.owner
        self.caller = caller
        self.nonce = secrets.token_urlsafe(NONCE_BYTES)
        self.health = None
        self.task = None
        self.seq = 0
        self.subscribers = set()
        self.handle = None
        self.token_calls = deque()

    def allows_token(self, now):
        while self.token_calls and now - self.token_calls[0] >= 60:
            self.token_calls.popleft()
        if len(self.token_calls) >= BROKER_CALLS_PER_MINUTE:
            return False
        self.token_calls.append(now)
        return True

    def close(self):
        self.caller = None
        self.nonce = None
        self.health = None


def agent_message(task, base, nonce):
    envelope = {
        "task": {
            **{name: task.get(name) for name in ("id", "type", "target", "workload", "instruction")},
            "nonce": nonce,
        }
    }
    if base is not None:
        envelope["relationships"] = model_diff.relationship_summaries(base)
    return f"{HEADLINES[task['type']]}\n{json.dumps(envelope, ensure_ascii=False)}"


def hold_failures(state, held, drafts):
    """Splits new events into those to show now and those kept back, from the first failure on, while the run can be retried."""
    if not activity.is_busy(state):
        return [], [*held, *drafts]
    kept, ready = list(held), []
    for draft in drafts:
        (kept if kept or draft["kind"] == "error" else ready).append(draft)
    return kept, ready


def rejected_message(rejection):
    more = rejection["count"] - 1
    return (
        "The agent got no result accepted. The last one was rejected: "
        f"{activity.clip(rejection['problems'][0], 120)}" + (f" (and {more} more)" if more > 0 else "")
    )


def age_seconds(task):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(task["createdAt"])).total_seconds()
    except (KeyError, TypeError, ValueError):
        return float("inf")


def interrupted(task, message):
    return {
        **task,
        "status": "failed",
        "error": {"code": "interrupted", "message": message},
        "finishedAt": utc_now(),
    }


class TaskRunner:
    def __init__(self, store, agent, health, timeout=TASK_TIMEOUT_SECONDS):
        self._store = store
        self._agent = agent
        self._health = health
        self._timeout = timeout
        self._running = {}
        self._settling = set()

    def is_running(self, owner, sid):
        return (owner, sid) in self._running

    async def start(self, caller, sid, fields):
        key = (caller.owner, sid)
        if key in self._running:
            raise TaskRunning(sid)
        if any(run.owner == caller.owner for run in self._running.values()):
            raise UserBusy(sid)
        if len(self._running) >= MAX_CONCURRENT_RUNS:
            raise AgentsBusy()
        run = Run(caller)
        run.health = self._health.as_user(caller)
        self._running[key] = run
        try:
            run.task = await self._store.create_task(caller.owner, sid, {**fields, "status": "running"})
        except BaseException:
            self._running.pop(key, None)
            run.close()
            raise
        run.handle = asyncio.create_task(self._run(sid, run))
        return run.task

    def attach(self, owner, sid, seq):
        run = self._running.get((owner, sid))
        if run is None or run.task is None or run.task["seq"] != seq:
            return None
        if len(run.subscribers) >= MAX_SUBSCRIBERS_PER_TASK:
            raise TooManySubscribers()
        queue = asyncio.Queue()
        run.subscribers.add(queue)
        return queue

    def detach(self, owner, sid, queue):
        run = self._running.get((owner, sid))
        if run is not None:
            run.subscribers.discard(queue)

    def run_for_nonce(self, nonce):
        found = None
        for run in list(self._running.values()):
            if run.nonce is not None and secrets.compare_digest(run.nonce.encode(), nonce.encode()):
                found = run
        return found

    def _owns(self, owner, sid, seq):
        run = self._running.get((owner, sid))
        return run is not None and (run.task is None or run.task["seq"] == seq)

    def _orphaned(self, owner, sid, task, grace):
        return (
            task["status"] in UNFINISHED
            and not self._owns(owner, sid, task["seq"])
            and (grace is None or age_seconds(task) > grace)
        )

    async def settled(self, owner, sid, task):
        if not self._orphaned(owner, sid, task, INTERRUPTED_GRACE_SECONDS):
            return task
        return await self._settle(owner, sid, task, INTERRUPTED_GRACE_SECONDS)

    async def _settle(self, owner, sid, task, grace):
        key = (owner, sid, task["seq"])
        if key in self._settling:
            return interrupted(task, INTERRUPTED_MESSAGE)
        self._settling.add(key)
        try:
            current = await self._store.get_task(owner, sid, task["seq"]) or task
            if not self._orphaned(owner, sid, current, grace):
                return current
            settled = interrupted(current, INTERRUPTED_MESSAGE)
            try:
                events = await self._store.read_events(owner, sid, current["seq"])
                await self._store.append_event(
                    owner,
                    sid,
                    current["seq"],
                    {
                        "seq": max((e["seq"] for e in events), default=0) + 1,
                        "ts": utc_now(),
                        **activity.draft(
                            "error",
                            INTERRUPTED_MESSAGE,
                            {"code": "interrupted", "message": INTERRUPTED_MESSAGE},
                        ),
                    },
                )
                await self._store.save_task(owner, sid, settled)
            except StoreUnavailable:
                logger.warning(
                    "interrupted task could not be recorded session=%s task=%s", sid, current["seq"]
                )
            return settled
        finally:
            self._settling.discard(key)

    async def recover(self):
        for owner, task in await self._store.unfinished_tasks():
            await self._settle(owner, task["sessionId"], task, None)

    async def shutdown(self):
        handles = [run.handle for run in self._running.values() if run.handle]
        for handle in handles:
            handle.cancel()
        await asyncio.gather(*handles, return_exceptions=True)

    async def _emit(self, sid, run, draft):
        run.seq += 1
        event = {"seq": run.seq, "ts": utc_now(), **draft}
        await self._store.append_event(run.owner, sid, run.task["seq"], event)
        for queue in list(run.subscribers):
            queue.put_nowait(event)

    async def _run(self, sid, run):
        with tracer.start_as_current_span("foundry.agent.respond", kind=SpanKind.CLIENT) as span:
            span.set_attribute("task.type", run.task["type"])
            span.set_attribute("session.id", sid)
            span.set_attribute("task.seq", run.task["seq"])
            span.set_attribute("caller.id", hashlib.sha256(run.owner.encode("utf-8")).hexdigest()[:16])
            try:
                async with asyncio.timeout(self._timeout):
                    await self._execute(sid, run)
            except TaskFailure as failure:
                await self._fail(
                    sid, run, span, failure.code, failure.message, failure.reported, failure.problems
                )
            except asyncio.CancelledError:
                await self._fail(
                    sid, run, span, "interrupted", "The web app stopped while the task was running."
                )
                raise
            except StoreUnavailable:
                await self._fail(
                    sid, run, span, "store_unavailable", "Session storage is unavailable."
                )
            except TimeoutError:
                await self._fail(
                    sid, run, span, "timeout", f"The task did not finish within {self._timeout // 60} minutes."
                )
            except InteractionRequired:
                await self._fail(sid, run, span, "interaction_required", SIGN_IN_AGAIN)
            except ConsentRequired:
                await self._fail(sid, run, span, "consent_required", CONSENT_MISSING)
            except Exception as error:
                logger.error(
                    "task failed unexpectedly error_type=%s", type(error).__name__, exc_info=error
                )
                await self._fail(sid, run, span, "internal_error", "The task failed unexpectedly.")
            finally:
                self._running.pop((run.owner, sid), None)
                for queue in run.subscribers:
                    queue.put_nowait(None)
                run.close()

    async def _save_final(self, sid, run):
        for delay in (*FINAL_SAVE_DELAYS, None):
            try:
                await self._store.save_task(run.owner, sid, run.task)
                return
            except StoreUnavailable:
                if delay is None:
                    raise
                await asyncio.sleep(delay)

    async def _fail(self, sid, run, span, code, message, reported=False, problems=None):
        span.set_status(Status(StatusCode.ERROR, code))
        shown = activity.safe_message(message)
        if shown != message:
            logger.warning("task failure message shortened code=%s message=%s", code, activity.redact(message))
        message = shown
        error = {"code": code, "message": message, **({"problems": problems} if problems else {})}
        try:
            if not reported:
                await self._emit(sid, run, activity.draft("error", message, error))
            run.task = {**run.task, "status": "failed", "error": error, "finishedAt": utc_now()}
            await self._save_final(sid, run)
        except Exception as error:
            logger.error("could not record task failure error_type=%s", type(error).__name__)

    async def _execute(self, sid, run):
        task = run.task
        await self._emit(sid, run, activity.draft("status", f"{task['type'].capitalize()} task started"))
        base = await self._snapshot(sid, run) if task["type"] in ("review", "design") else None
        conversation_id = await self._conversation(run.owner, sid)
        state = await self._respond(sid, run, conversation_id, agent_message(run.task, base, run.nonce))
        await self._conclude(sid, run, state, base)

    async def _snapshot(self, sid, run):
        target = run.task["target"]
        try:
            raw = await asyncio.to_thread(
                run.health.read_model,
                target["subscriptionId"],
                target["resourceGroup"],
                target["name"],
            )
        except HttpResponseError as error:
            logger.warning("base model read failed status=%s", getattr(error, "status_code", None))
            raise TaskFailure("base_unavailable", "The target model could not be read.") from error
        base = {
            "modelId": model_diff.model_id(target),
            "fingerprint": model_diff.fingerprint(raw),
            "capturedAt": utc_now(),
        }
        await self._store.save_base(run.owner, sid, run.task["seq"], raw)
        run.task = {**run.task, "base": base}
        await self._store.save_task(run.owner, sid, run.task)
        await self._emit(
            sid,
            run,
            activity.draft(
                "status",
                f"Base model captured ({len(raw['entities'])} entities)",
                {"fingerprint": base["fingerprint"]},
            ),
        )
        return raw

    async def _conversation(self, owner, sid):
        session = await self._store.get_session(owner, sid)
        return session.get("conversationId") or await self._new_conversation(owner, sid, session)

    async def _new_conversation(self, owner, sid, session=None):
        session = session or await self._store.get_session(owner, sid)
        try:
            conversation_id = await self._agent.create_conversation()
        except AgentError as error:
            raise TaskFailure(error.code, error.message) from error
        await self._store.save_session(owner, {**session, "conversationId": conversation_id})
        return conversation_id

    async def _flush(self, sid, run, state):
        state, drafts = activity.finish(state)
        for draft in drafts:
            await self._emit(sid, run, draft)
        return state

    async def _wait_out_busy(self, sid, run, attempt):
        delay = BUSY_RETRY_SECONDS[attempt]
        logger.warning("agent service busy before any event, trying again attempt=%s wait=%s", attempt + 1, delay)
        await self._emit(
            sid,
            run,
            activity.draft(
                "status",
                "The assistant is busy, trying again",
                {"attempt": attempt + 1, "of": len(BUSY_RETRY_SECONDS), "waitSeconds": delay},
            ),
        )
        await asyncio.sleep(delay)

    async def _respond(self, sid, run, conversation_id, message):
        restarted, busy = False, 0
        while True:
            state, held = activity.new_state(), []
            try:
                async for event in self._agent.stream_response(conversation_id, message):
                    state, drafts = activity.reduce_event(state, event.name, event.data)
                    held, ready = hold_failures(state, held, drafts)
                    for draft in ready:
                        await self._emit(sid, run, draft)
                if held and busy < len(BUSY_RETRY_SECONDS):
                    await self._wait_out_busy(sid, run, busy)
                    busy += 1
                    continue
                for draft in held:
                    await self._emit(sid, run, draft)
                return await self._flush(sid, run, state)
            except (ConversationNotFound, AgentError) as error:
                for draft in held:
                    await self._emit(sid, run, draft)
                if activity.accepted_result(state) is not None:
                    code = getattr(error, "code", "conversation_not_found")
                    detail = getattr(error, "message", "The agent conversation was not found.")
                    await self._emit(
                        sid,
                        run,
                        activity.draft(
                            "status",
                            f"Agent stream failed after the result was accepted ({code})",
                            {"code": code, "message": detail},
                        ),
                    )
                    return await self._flush(sid, run, state)
                if isinstance(error, AgentError):
                    raise TaskFailure(error.code, error.message) from error
                if restarted:
                    raise TaskFailure(
                        "conversation_lost", "The agent conversation could not be restored."
                    ) from error
                restarted = True
                conversation_id = await self._new_conversation(run.owner, sid)
                await self._emit(
                    sid, run, activity.draft("status", "Conversation expired; started a new one")
                )

    async def _conclude(self, sid, run, state, base):
        failure = activity.failure(state)
        result = activity.accepted_result(state)
        if failure:
            logger.warning("agent reported failure code=%s detail=%s", failure["code"], failure["detail"])
        if result is None:
            if failure:
                raise TaskFailure("agent_failed", failure["message"], reported=True)
            rejection = activity.last_rejection(state)
            if rejection and rejection["problems"]:
                raise TaskFailure("no_result", rejected_message(rejection), problems=rejection["problems"])
            raise TaskFailure(
                "no_result", "The agent finished without submitting an accepted result."
            )
        expected = "explain" if run.task["type"] == "explain" else "diff"
        if result.get("kind") != expected:
            raise TaskFailure(
                "invalid_result", f"A {run.task['type']} task needs a {expected} result."
            )
        problems = model_diff.validate_result(result, base, run.task["target"])
        if problems:
            shown = activity.clip_problems(problems, each=None)
            more = f" (and {len(problems) - 1} more)" if len(problems) > 1 else ""
            message = f"The result is not valid: {problems[0]}{more}"
            await self._emit(
                sid,
                run,
                activity.draft("error", message, {"code": "invalid_result", "problems": shown}),
            )
            raise TaskFailure("invalid_result", message, reported=True, problems=shown)
        await self._emit(sid, run, activity.draft("status", "Result verified"))
        run.task = {**run.task, "status": "done", "result": result, "finishedAt": utc_now()}
        await self._save_final(sid, run)
