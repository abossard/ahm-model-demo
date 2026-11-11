import asyncio
import copy
import hashlib
import inspect
import json
import secrets
import sys
import threading
import unittest
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, StatusCode

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import activity  # noqa: E402
import config  # noqa: E402
import dto  # noqa: E402
import fake_agent  # noqa: E402
import fixture_models  # noqa: E402
import foundry_agent  # noqa: E402
import model_diff  # noqa: E402
import obo  # noqa: E402
import sessions_store  # noqa: E402
import task_runner  # noqa: E402
from auth import Caller  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-fixture"
MODEL = "hm-fixture"
DESIGN = "hm-fixture-design"
TARGET = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
BASE = fixture_models.fixture_model(SUB, GROUP, MODEL)
REVIEW = fake_agent.review_result({"type": "review", "target": TARGET}, model_diff.relationship_summaries(BASE))
EXPLAIN = fake_agent.explain_result({"type": "explain", "target": {**TARGET, "entity": "orders-api"}})
OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CALLER = Caller(OWNER, "Ada", "assertion-one")
NONCE = "n" * 43
CLAIMS = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}'
ACCEPTED = json.dumps({"status": "accepted"})
REJECTED = json.dumps({"status": "rejected", "problems": ["nope"]})


def person(number):
    return Caller(f"{number:08d}-0000-0000-0000-000000000000", f"User {number}", f"assertion-{number}")


def stream(*tuples):
    return [foundry_agent.StreamEvent(name, data) for name, data in tuples]


def script(result, output=ACCEPTED):
    return stream(
        ("response.created", {"response": {"id": "r"}}),
        *fake_agent.message(1, "Working on it."),
        *fake_agent.call(1, "submit_result", {"result": result}, output),
        ("response.completed", {"response": {"id": "r"}}),
    )


class ScriptedAgent:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.created = 0
        self.calls = []
        self.create_error = None

    async def create_conversation(self):
        if self.create_error:
            raise self.create_error
        self.created += 1
        return f"conv-{self.created}"

    async def stream_response(self, conversation_id, text):
        self.calls.append((conversation_id, text))
        for item in self.responses.pop(0):
            if isinstance(item, BaseException):
                raise item
            if isinstance(item, asyncio.Event):
                await item.wait()
                continue
            yield item


class Env:
    def __init__(self, *responses, timeout=10):
        self.store = sessions_store.MemorySessionsStore()
        self.health = fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, DESIGN))
        self.agent = ScriptedAgent(*responses)
        self.runner = task_runner.TaskRunner(self.store, self.agent, self.health, timeout=timeout)
        self.caller = CALLER

    async def session(self, caller=None):
        return (await self.store.create_session((caller or self.caller).oid, "S"))["id"]

    def fields(self, kind="review", **target):
        extra = {"entity": "orders-api"} if kind == "explain" else {}
        fields = {"type": kind, "target": {**TARGET, **extra, **target}, "instruction": "", "createdAt": sessions_store.utc_now()}
        if kind == "design":
            fields["target"] = {**TARGET, "name": DESIGN}
            fields["workload"] = {"resourceGroup": GROUP}
        return fields

    async def run(self, sid, fields):
        task = await self.runner.start(self.caller, sid, fields)
        queue = self.runner.attach(self.caller.oid, sid, task["seq"])
        while await queue.get() is not None:
            pass
        return await self.store.get_task(OWNER, sid, task["seq"]), await self.store.read_events(OWNER, sid, task["seq"])


def kinds(events):
    return [event["kind"] for event in events]


def sent_nonce(env):
    return json.loads(env.agent.calls[-1][1].split("\n", 1)[1])["task"]["nonce"]


class SuccessTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_review_task_snapshots_the_base_streams_and_finishes_done(self):
        env = Env(script(REVIEW))
        sid = await env.session()

        task, events = await env.run(sid, env.fields())

        self.assertEqual(task["status"], "done")
        self.assertEqual(task["result"], REVIEW)
        self.assertNotIn("error", task)
        self.assertRegex(task["finishedAt"], r"Z$")
        self.assertEqual(
            task["base"],
            {
                "modelId": f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/Microsoft.CloudHealth/healthmodels/{MODEL}",
                "fingerprint": model_diff.fingerprint(BASE),
                "capturedAt": task["base"]["capturedAt"],
            },
        )
        saved = await env.store.load_base(OWNER, sid, 1)
        self.assertEqual(model_diff.normalize(saved), model_diff.normalize(BASE))
        self.assertEqual(
            {e["name"]: e["properties"]["healthState"] for e in saved["entities"]}["orders-db"], "Unhealthy"
        )
        self.assertEqual(set(saved), {"entities", "signalDefinitions", "relationships"})
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual(
            [(e["kind"], e["summary"]) for e in events][:2],
            [("status", "Review task started"), ("status", "Base model captured (5 entities)")],
        )
        self.assertEqual(kinds(events)[2:], ["status", "text", "tool_call", "tool_result", "result", "status", "status"])
        self.assertEqual(events[-1]["summary"], "Result verified")
        self.assertTrue(all(set(e) == {"seq", "ts", "kind", "summary", "payload"} for e in events))
        self.assertEqual((await env.store.get_session(OWNER, sid))["conversationId"], "conv-1")
        self.assertFalse(env.runner.is_running(OWNER, sid))

    async def test_an_explain_task_has_no_base_and_the_agent_gets_no_relationships(self):
        env = Env(script(EXPLAIN))
        sid = await env.session()

        task, events = await env.run(sid, env.fields("explain"))

        self.assertEqual(task["status"], "done")
        self.assertNotIn("base", task)
        self.assertIsNone(await env.store.load_base(OWNER, sid, 1))
        self.assertNotIn("Base model captured", " ".join(e["summary"] for e in events))
        (conversation, message), = env.agent.calls
        self.assertEqual(conversation, "conv-1")
        self.assertNotIn("relationships", json.loads(message.split("\n", 1)[1]))

    async def test_a_design_task_snapshots_the_design_model(self):
        design_result = fake_agent.design_result({"type": "design", "target": {**TARGET, "name": DESIGN}})
        env = Env(script(design_result))
        sid = await env.session()

        task, events = await env.run(sid, env.fields("design"))

        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual((await env.store.load_base(OWNER, sid, 1))["entities"][0]["name"], DESIGN)
        self.assertIn("Base model captured (1 entities)", [e["summary"] for e in events])

    async def test_the_agent_input_is_a_headline_plus_the_task_envelope(self):
        task = {"id": "3", "type": "review", "target": TARGET, "workload": None, "instruction": "be brief", "status": "running"}
        cases = [
            ("review", task, BASE, True),
            ("design", {**task, "type": "design", "workload": {"resourceGroup": GROUP}}, BASE, True),
            ("explain", {**task, "type": "explain", "target": {**TARGET, "entity": "api"}}, None, False),
        ]
        for kind, current, base, relationships in cases:
            with self.subTest(kind=kind):
                headline, body = task_runner.agent_message(current, base, NONCE).split("\n", 1)
                envelope = json.loads(body)

                self.assertIn("submit_result", headline)
                self.assertEqual(
                    set(envelope["task"]), {"id", "type", "target", "workload", "instruction", "nonce"}
                )
                self.assertEqual(envelope["task"]["id"], "3")
                self.assertEqual(envelope["task"]["nonce"], NONCE)
                self.assertEqual(envelope["task"]["instruction"], "be brief")
                self.assertEqual(envelope["task"]["workload"], current["workload"])
                self.assertEqual("relationships" in envelope, relationships)
                if relationships:
                    self.assertEqual(envelope["relationships"], model_diff.relationship_summaries(BASE))
                    self.assertEqual(set(envelope["relationships"][0]), {"name", "parent", "child"})

    async def test_later_tasks_reuse_the_sessions_conversation(self):
        env = Env(script(REVIEW), script(EXPLAIN))
        sid = await env.session()

        await env.run(sid, env.fields())
        second, _ = await env.run(sid, env.fields("explain"))

        self.assertEqual(second["seq"], 2)
        self.assertEqual(env.agent.created, 1)
        self.assertEqual([conversation for conversation, _ in env.agent.calls], ["conv-1", "conv-1"])

    async def test_blocking_model_reads_run_off_the_event_loop(self):
        env = Env(script(REVIEW))
        sid = await env.session()
        seen = []
        original = env.health.read_model

        def spy(*args):
            seen.append(threading.current_thread() is threading.main_thread())
            return original(*args)

        env.health.read_model = spy

        await env.run(sid, env.fields())

        self.assertEqual(seen, [False])

    async def test_events_are_stored_before_subscribers_see_them(self):
        env = Env(script(REVIEW))
        sid = await env.session()
        original = env.store.append_event

        async def slow(*args):
            await asyncio.sleep(0.005)
            await original(*args)

        env.store.append_event = slow
        task = await env.runner.start(env.caller, sid, env.fields())
        queue = env.runner.attach(OWNER, sid, task["seq"])
        order = []

        while (event := await queue.get()) is not None:
            stored = [e["seq"] for e in await env.store.read_events(OWNER, sid, 1)]
            order.append(event["seq"] in stored)

        self.assertTrue(order and all(order))


class FailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_failure_marks_the_task_failed_with_a_code_and_one_error_event(self):
        schema_invalid = {**REVIEW, "changes": [{**REVIEW["changes"][0], "name": "ab"}]}
        missing_entity = {**REVIEW, "changes": [{**REVIEW["changes"][0], "name": "ghost-entity"}], "findings": []}
        twin = {**REVIEW, "changes": [*REVIEW["changes"], {"id": "c9", "op": "add", "kind": "relationship", "name": "other-name", "after": {"parentEntityName": "web-frontend", "childEntityName": "orders-api"}, "reason": "r"}]}
        failed = lambda code, message: stream(("response.failed", {"response": {"error": {"code": code, "message": message}}}))
        cases = [
            ("response.failed", [failed("tool_start_failed", "The MCP child exited.")], "agent_failed", "The MCP child exited."),
            ("error event", [stream(("error", {"code": "invalid_prompt", "message": "Boom."}))], "agent_failed", "Boom."),
            ("no submission", [stream(("response.completed", {"response": {}}))], "no_result", "without submitting"),
            ("only a rejected submission", [script(REVIEW, REJECTED)], "no_result", "The last one was rejected: nope"),
            ("wrong kind", [script(EXPLAIN)], "invalid_result", "needs a diff result"),
            ("schema invalid", [script(schema_invalid)], "invalid_result", "changes[0].name"),
            ("change of a missing entity", [script(missing_entity)], "invalid_result", "does not exist in the model"),
            ("relationship under a new name", [script(twin)], "invalid_result", "use the existing name 'web-frontend-orders-api'"),
            ("agent error", [[foundry_agent.AgentError("agent_unavailable", "The agent is unavailable.")]], "agent_unavailable", "unavailable"),
            ("unexpected exception", [[RuntimeError("SECRET detail")]], "internal_error", "failed unexpectedly"),
        ]
        for label, responses, code, fragment in cases:
            with self.subTest(label=label):
                env = Env(*responses)
                sid = await env.session()
                logs = {
                    "internal_error": self.assertLogs("ahm-demo", level="ERROR"),
                    "agent_failed": self.assertLogs("ahm-demo", level="WARNING"),
                }.get(code, nullcontext())

                with logs:
                    task, events = await env.run(sid, env.fields())

                self.assertEqual(task["status"], "failed")
                self.assertEqual(task["error"]["code"], code)
                self.assertIn(fragment, task["error"]["message"])
                self.assertNotIn("SECRET", json.dumps(task))
                self.assertNotIn("result", task)
                self.assertRegex(task["finishedAt"], r"Z$")
                errors = [e for e in events if e["kind"] == "error"]
                self.assertEqual(len(errors), 1)
                self.assertTrue(task["error"]["message"].startswith(errors[0]["summary"][:80]))
                if code != "agent_failed":
                    self.assertEqual(errors[0]["payload"]["code"], code)
                self.assertFalse(env.runner.is_running(OWNER, sid))

    async def test_an_invalid_result_lists_its_problems_in_the_error_event(self):
        env = Env([*script({**REVIEW, "changes": [{**REVIEW["changes"][0], "name": "ghost-entity"}, {**REVIEW["changes"][0], "id": "c2", "name": "ghost-two"}], "findings": []})])
        sid = await env.session()

        _, events = await env.run(sid, env.fields())

        (error,) = [e for e in events if e["kind"] == "error"]
        self.assertEqual(error["payload"]["code"], "invalid_result")
        self.assertEqual(len(error["payload"]["problems"]), 2)
        self.assertIn("(and 1 more)", error["summary"] + " (and 1 more)")

    async def test_failures_before_the_agent_runs(self):
        cases = [
            ("target model cannot be read", "review", {"name": "no-such-model"}, "base_unavailable", "could not be read"),
        ]
        for label, kind, target, code, fragment in cases:
            with self.subTest(label=label):
                env = Env(script(REVIEW))
                sid = await env.session()

                with self.assertLogs("ahm-demo", level="WARNING"):
                    task, events = await env.run(sid, env.fields(kind, **target))

                self.assertEqual((task["status"], task["error"]["code"]), ("failed", code))
                self.assertIn(fragment, task["error"]["message"])
                self.assertEqual(env.agent.calls, [])
                self.assertNotIn("base", task)

        env = Env(script(REVIEW))
        env.agent.create_error = foundry_agent.AgentError("agent_forbidden", "The web app is not allowed to call the agent.")
        sid = await env.session()
        task, _ = await env.run(sid, env.fields())
        self.assertEqual(task["error"]["code"], "agent_forbidden")

    async def test_a_lost_conversation_is_recreated_exactly_once(self):
        env = Env([foundry_agent.ConversationNotFound("gone")], script(REVIEW))
        sid = await env.session()

        task, events = await env.run(sid, env.fields())

        self.assertEqual(task["status"], "done")
        self.assertEqual([c for c, _ in env.agent.calls], ["conv-1", "conv-2"])
        self.assertEqual((await env.store.get_session(OWNER, sid))["conversationId"], "conv-2")
        self.assertIn("Conversation expired; started a new one", [e["summary"] for e in events])

    async def test_a_conversation_stored_in_the_session_that_has_expired_is_replaced(self):
        env = Env([foundry_agent.ConversationNotFound("gone")], script(REVIEW))
        sid = await env.session()
        await env.store.save_session(OWNER, {**await env.store.get_session(OWNER, sid), "conversationId": "expired"})

        task, _ = await env.run(sid, env.fields())

        self.assertEqual(task["status"], "done")
        self.assertEqual([c for c, _ in env.agent.calls], ["expired", "conv-1"])

    async def test_losing_the_conversation_twice_fails_the_task(self):
        env = Env([foundry_agent.ConversationNotFound("gone")], [foundry_agent.ConversationNotFound("gone")])
        sid = await env.session()

        task, events = await env.run(sid, env.fields())

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "conversation_lost"))
        self.assertEqual(env.agent.created, 2)
        self.assertEqual(len([e for e in events if e["kind"] == "error"]), 1)

    async def test_a_task_that_never_finishes_times_out(self):
        env = Env([asyncio.Event()], timeout=0.05)
        sid = await env.session()

        task, events = await env.run(sid, env.fields())

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "timeout"))
        self.assertEqual(kinds(events)[-1], "error")

    async def test_a_failing_store_becomes_a_store_error_once_it_recovers(self):
        env = Env(script(REVIEW))
        sid = await env.session()
        original = env.store.append_event
        calls = []

        async def flaky(*args):
            calls.append(1)
            if len(calls) == 3:
                raise sessions_store.StoreUnavailable("append_event")
            return await original(*args)

        env.store.append_event = flaky

        task, _ = await env.run(sid, env.fields())

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "store_unavailable"))


TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.c2lnbmF0dXJl"
OTHER_GROUP_ID = f"/subscriptions/{SUB}/resourceGroups/rg-elsewhere/providers/Microsoft.App/containerApps/api"


def edited(result, edit):
    result = copy.deepcopy(result)
    edit(result)
    return result


class SafetyRuleTests(unittest.IsolatedAsyncioTestCase):
    async def test_results_that_break_a_safety_rule_fail_the_task_instead_of_finishing_it(self):
        def outside(result):
            result["changes"][0]["after"]["signalGroups"]["azureResource"]["azureResourceId"] = OTHER_GROUP_ID

        def new_action_group(result):
            result["changes"][0]["after"]["alerts"] = {"unhealthy": {"actionGroupIds": [f"/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/microsoft.insights/actionGroups/new"]}}

        def too_many(result):
            result["changes"] += [
                {"id": f"x{n}", "op": "add", "kind": "signalDefinition", "name": f"sd-extra-{n:03d}", "after": fixture_models.metric_definition("x", "y", 1, 2), "reason": "r"}
                for n in range(200)
            ]

        def huge(result):
            result["changes"][1]["after"]["padding"] = "x" * 70_000

        def newline(result):
            result["changes"][1]["name"] = "sd-queue-depth\n"

        def discovered(env):
            env.health._model(SUB, GROUP, MODEL)["entities"]["orders-api"]["properties"]["discoveredBy"] = "rule-1"

        cases = [
            ("a resource id in another group", edited(REVIEW, outside), None, "outside the target's subscription and resource group"),
            ("a new action group", edited(REVIEW, new_action_group), None, "is not already used in the model"),
            ("more than 200 changes", edited(REVIEW, too_many), None, "204 changes is more than the 200 allowed"),
            ("a huge after", edited(REVIEW, huge), None, "after is"),
            ("a name with a trailing newline", edited(REVIEW, newline), None, "changes[1].name"),
            ("a change to a discovered entity", REVIEW, discovered, "was discovered automatically and cannot be changed"),
        ]
        for label, result, prepare, fragment in cases:
            with self.subTest(label=label):
                env = Env(script(result))
                if prepare:
                    prepare(env)
                sid = await env.session()

                task, events = await env.run(sid, env.fields())

                self.assertEqual((task["status"], task["error"]["code"]), ("failed", "invalid_result"))
                self.assertIn(fragment, task["error"]["message"] + json.dumps([e["payload"] for e in events]))
                self.assertNotIn("result", task)
                self.assertEqual(len([e for e in events if e["kind"] == "error"]), 1)

    async def test_a_resource_id_of_another_group_may_be_kept_when_the_model_already_uses_it(self):
        def keep(result):
            result["changes"][0]["after"]["signalGroups"]["azureResource"]["azureResourceId"] = OTHER_GROUP_ID

        def the_model_uses_it(env):
            env.health._model(SUB, GROUP, MODEL)["entities"]["orders-api"]["properties"]["signalGroups"]["azureResource"]["azureResourceId"] = OTHER_GROUP_ID

        cases = [("the model already uses it", the_model_uses_it, "done"), ("the model does not use it", None, "failed")]
        for label, prepare, status in cases:
            with self.subTest(label=label):
                env = Env(script(edited(REVIEW, keep)))
                if prepare:
                    prepare(env)
                sid = await env.session()

                task, _ = await env.run(sid, env.fields())

                self.assertEqual(task["status"], status, task.get("error"))
                if status == "failed":
                    self.assertEqual(task["error"]["code"], "invalid_result")
                    self.assertIn("is not used in the model", task["error"]["message"])

    async def test_a_design_task_may_only_reference_resources_of_its_own_group(self):
        design = fake_agent.design_result({"type": "design", "target": {**TARGET, "name": DESIGN}})
        elsewhere = edited(design, lambda r: r["changes"][2]["after"]["signalGroups"]["azureResource"].update(azureResourceId=OTHER_GROUP_ID))
        cases = [("its own group", design, "done"), ("another group", elsewhere, "failed")]
        for label, result, status in cases:
            with self.subTest(label=label):
                env = Env(script(result))
                sid = await env.session()

                task, _ = await env.run(sid, env.fields("design"))

                self.assertEqual(task["status"], status, task.get("error"))


class LimitTests(unittest.IsolatedAsyncioTestCase):
    async def slow_creates(self, env):
        original = env.store.create_task

        async def slow(*args):
            await asyncio.sleep(0.01)
            return await original(*args)

        env.store.create_task = slow

    async def test_requests_arriving_together_cannot_start_more_runs_than_the_cap(self):
        gate = asyncio.Event()
        env = Env(*[[gate, *script(REVIEW)] for _ in range(6)])
        await self.slow_creates(env)
        callers = [person(number) for number in range(1, 7)]
        sids = [await env.session(caller) for caller in callers]

        with mock.patch.object(task_runner, "MAX_CONCURRENT_RUNS", 3):
            results = await asyncio.gather(
                *[env.runner.start(caller, sid, env.fields()) for caller, sid in zip(callers, sids)],
                return_exceptions=True,
            )

        self.assertEqual(len([r for r in results if isinstance(r, dict)]), 3)
        self.assertEqual(len([r for r in results if isinstance(r, task_runner.AgentsBusy)]), 3)
        busy = [(caller, sid) for caller, sid, result in zip(callers, sids, results) if isinstance(result, task_runner.AgentsBusy)]
        for caller, sid in busy:
            self.assertEqual(await env.store.list_tasks(caller.oid, sid), [])
            self.assertFalse(env.runner.is_running(caller.oid, sid))
        gate.set()
        await env.runner.shutdown()

    async def test_requests_of_one_user_arriving_together_cannot_start_two_runs(self):
        gate = asyncio.Event()
        env = Env(*[[gate, *script(REVIEW)] for _ in range(4)])
        await self.slow_creates(env)
        sids = [await env.session() for _ in range(4)]

        results = await asyncio.gather(*[env.runner.start(env.caller, sid, env.fields()) for sid in sids], return_exceptions=True)

        self.assertEqual([type(r) for r in results].count(dict), 1)
        self.assertEqual([type(r) for r in results].count(task_runner.UserBusy), 3)
        gate.set()
        await env.runner.shutdown()

    async def test_a_slot_is_free_again_however_the_run_or_its_start_ends(self):
        def failing_agent(env):
            env.agent.responses[:] = [[foundry_agent.AgentError("agent_unavailable", "down")]]

        def hanging_agent(env):
            env.agent.responses[:] = [[asyncio.Event()]]

        def broken_store(env):
            original = env.store.create_task

            async def broken(*args):
                raise sessions_store.StoreUnavailable("create_task")

            env.store.create_task = broken
            return lambda: setattr(env.store, "create_task", original)

        cases = [
            ("done", lambda env: None, "done"),
            ("agent error", failing_agent, "failed"),
            ("timeout", hanging_agent, "failed"),
            ("the task could not be created", broken_store, None),
        ]
        for label, prepare, status in cases:
            with self.subTest(label=label), mock.patch.object(task_runner, "MAX_CONCURRENT_RUNS", 1):
                env = Env(script(REVIEW), script(REVIEW), timeout=0.05)
                first, second = await env.session(), await env.session()
                restore = prepare(env)

                try:
                    started = await env.runner.start(env.caller, first, env.fields())
                except sessions_store.StoreUnavailable:
                    started = None
                if started:
                    queue = env.runner.attach(OWNER, first, started["seq"])
                    while await queue.get() is not None:
                        pass
                    await asyncio.sleep(0)
                if restore:
                    restore()

                self.assertEqual((await env.store.get_task(OWNER, first, 1) or {}).get("status"), status)
                self.assertFalse(env.runner.is_running(OWNER, first))
                env.agent.responses[:] = [script(REVIEW)]
                later = await env.runner.start(env.caller, second, env.fields())
                self.assertEqual(later["status"], "running")
                await env.runner.shutdown()

    async def test_a_session_that_already_runs_a_task_gets_that_answer_even_when_everything_is_busy(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)], [gate, *script(REVIEW)])
        first, second = await env.session(), await env.session()
        stranger = person(2)
        other = await env.session(stranger)

        with mock.patch.object(task_runner, "MAX_CONCURRENT_RUNS", 1):
            await env.runner.start(env.caller, first, env.fields())
            again = await asyncio.gather(
                env.runner.start(env.caller, first, env.fields()),
                env.runner.start(env.caller, second, env.fields()),
                env.runner.start(stranger, other, env.fields()),
                return_exceptions=True,
            )

        self.assertEqual([type(r) for r in again], [task_runner.TaskRunning, task_runner.UserBusy, task_runner.AgentsBusy])
        gate.set()
        await env.runner.shutdown()

    async def test_a_user_runs_one_task_at_a_time_across_sessions_and_others_are_not_blocked(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)], [gate, *script(REVIEW)], script(REVIEW))
        first, second = await env.session(), await env.session()
        stranger = person(2)
        elsewhere = await env.session(stranger)
        await env.runner.start(env.caller, first, env.fields())

        with self.assertRaises(task_runner.UserBusy) as busy:
            await env.runner.start(env.caller, second, env.fields())
        started = await env.runner.start(stranger, elsewhere, env.fields())

        self.assertIsInstance(busy.exception, task_runner.TaskRunning)
        self.assertEqual(await env.store.list_tasks(OWNER, second), [])
        self.assertFalse(env.runner.is_running(OWNER, second))
        self.assertEqual(started["status"], "running")
        queue = env.runner.attach(OWNER, first, 1)
        gate.set()
        while await queue.get() is not None:
            pass
        await asyncio.sleep(0)
        later = await env.runner.start(env.caller, second, env.fields())
        self.assertEqual(later["status"], "running")
        await env.runner.shutdown()

    async def test_the_number_of_followers_per_task_is_capped_and_detaching_frees_a_slot(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        sid = await env.session()
        task = await env.runner.start(env.caller, sid, env.fields())

        with mock.patch.object(task_runner, "MAX_SUBSCRIBERS_PER_TASK", 2):
            first = env.runner.attach(OWNER, sid, task["seq"])
            second = env.runner.attach(OWNER, sid, task["seq"])
            with self.assertRaises(task_runner.TooManySubscribers):
                env.runner.attach(OWNER, sid, task["seq"])
            env.runner.detach(OWNER, sid, first)
            third = env.runner.attach(OWNER, sid, task["seq"])
            env.runner.detach(OWNER, sid, first)
            with self.assertRaises(task_runner.TooManySubscribers):
                env.runner.attach(OWNER, sid, task["seq"])
            self.assertIsNone(env.runner.attach(OWNER, sid, task["seq"] + 1))
            self.assertIsNone(env.runner.attach(OWNER, "nope", 1))

        self.assertIsNotNone(second)
        self.assertIsNotNone(third)
        gate.set()
        await env.runner.shutdown()


SERVER_ERROR = {"code": "server_error", "message": "An internal server error occurred."}
CREATED = ("response.created", {"response": {"id": "r"}})
BUSY = stream(CREATED, ("response.failed", {"response": {"error": SERVER_ERROR}}))
BUSY_AS_ERROR = stream(CREATED, ("error", SERVER_ERROR))


def rejections(*problem_lists):
    calls = [
        event
        for number, problems in enumerate(problem_lists, 1)
        for event in fake_agent.call(number, "submit_result", {"result": REVIEW}, json.dumps({"status": "rejected", "problems": problems}))
    ]
    return stream(CREATED, *calls, ("response.completed", {"response": {"id": "r"}}))


class BusyTests(unittest.IsolatedAsyncioTestCase):
    async def run_without_waiting(self, responses, logged=True):
        env = Env(*responses)
        sid = await env.session()
        sleeps, real_sleep = [], asyncio.sleep

        async def recording(delay, *args):
            sleeps.append(delay)
            await real_sleep(0)

        logs = self.assertLogs("ahm-demo", level="WARNING") if logged else nullcontext()
        with logs, mock.patch.object(task_runner.asyncio, "sleep", recording):
            task, events = await env.run(sid, env.fields())
        return env, task, events, [delay for delay in sleeps if delay in config.BUSY_RETRY_SECONDS]

    async def test_a_busy_model_before_any_event_is_retried_with_growing_pauses_and_then_gives_up(self):
        ok = script(REVIEW)
        cases = [
            ("busy once", [BUSY, ok], "done", [5], 2),
            ("busy twice", [BUSY, BUSY, ok], "done", [5, 15], 3),
            ("busy three times", [BUSY, BUSY, BUSY, ok], "done", [5, 15, 30], 4),
            ("busy four times", [BUSY, BUSY, BUSY, BUSY], "failed", [5, 15, 30], 4),
            ("busy as an error event", [BUSY_AS_ERROR, ok], "done", [5], 2),
            ("busy as a failure and as an error event", [BUSY_AS_ERROR, BUSY, ok], "done", [5, 15], 3),
        ]
        for label, responses, status, pauses, calls in cases:
            with self.subTest(label=label):
                env, task, events, slept = await self.run_without_waiting(responses)

                self.assertEqual(task["status"], status, task.get("error"))
                self.assertEqual(slept, pauses)
                self.assertEqual(len(env.agent.calls), calls)
                self.assertEqual({conversation for conversation, _ in env.agent.calls}, {"conv-1"})
                self.assertEqual(len({text for _, text in env.agent.calls}), 1)
                waits = [e for e in events if e["summary"] == "The assistant is busy, trying again"]
                self.assertEqual([(e["kind"], e["payload"]) for e in waits], [("status", {"attempt": n, "of": 3, "waitSeconds": p}) for n, p in enumerate(pauses, 1)])
                errors = [e for e in events if e["kind"] == "error"]
                if status == "done":
                    self.assertEqual(errors, [])
                else:
                    self.assertEqual(task["error"], {"code": "agent_failed", "message": activity.SERVER_ERROR_MESSAGE})
                    self.assertEqual([e["payload"]["code"] for e in errors], ["server_error"])
                    self.assertEqual(events[-1]["kind"], "error")
                self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))

    async def test_a_retried_run_reads_in_the_timeline_as_a_wait_and_a_fresh_start(self):
        env, task, events, _ = await self.run_without_waiting([BUSY, script(REVIEW)])

        self.assertEqual(task["status"], "done")
        self.assertEqual(
            [(e["kind"], e["summary"]) for e in events][:6],
            [
                ("status", "Review task started"),
                ("status", "Base model captured (5 entities)"),
                ("status", "Agent started"),
                ("status", "The assistant is busy, trying again"),
                ("status", "Agent started"),
                ("text", "Working on it."),
            ],
        )

    async def test_what_follows_a_held_back_failure_is_held_back_with_it_and_keeps_its_order(self):
        failing = stream(CREATED, ("response.failed", {"response": {"error": SERVER_ERROR}}), CREATED)
        cases = [
            ("retried and then fine", [failing, script(REVIEW)], "done", 2),
            ("never fine", [failing] * 4, "failed", 5),
        ]
        for label, responses, status, starts in cases:
            with self.subTest(label=label):
                env, task, events, _ = await self.run_without_waiting(responses)

                self.assertEqual(task["status"], status)
                self.assertEqual([e["summary"] for e in events].count("Agent started"), starts)
                if status == "failed":
                    tail = [(e["kind"], e["summary"]) for e in events][-2:]
                    self.assertEqual(tail, [("error", activity.SERVER_ERROR_MESSAGE), ("status", "Agent started")])
                else:
                    self.assertEqual([e["kind"] for e in events if e["kind"] == "error"], [])

    async def test_nothing_is_retried_once_anything_has_arrived_or_when_the_failure_is_another_one(self):
        failure = ("response.failed", {"response": {"error": SERVER_ERROR}})
        denied = ("response.failed", {"response": {"error": {"code": "denied", "message": "No."}}})
        cases = [
            ("a text arrived", stream(CREATED, *fake_agent.message(1, "Looking."), failure)),
            ("a text delta arrived", stream(CREATED, ("response.output_text.delta", {"item_id": "m", "delta": "Lo"}), failure)),
            ("a tool call arrived", stream(CREATED, *fake_agent.call(1, "monitor_healthmodels_get", {"model": "m"}, "ok"), failure)),
            ("a tool call started", stream(CREATED, ("response.output_item.added", {"item": {"id": "f", "type": "function_call", "call_id": "c", "name": "x", "arguments": ""}}), failure)),
            ("an event nobody maps arrived", stream(CREATED, ("response.content_part.added", {"part": {}}), failure)),
            ("a rejected result arrived", stream(CREATED, *fake_agent.call(1, "submit_result", {"result": REVIEW}, REJECTED), failure)),
            ("another failure code", stream(CREATED, denied)),
        ]
        for label, response in cases:
            with self.subTest(label=label):
                env, task, events, slept = await self.run_without_waiting([response, script(REVIEW)])

                self.assertEqual((task["status"], task["error"]["code"]), ("failed", "agent_failed"))
                self.assertEqual(slept, [])
                self.assertEqual(len(env.agent.calls), 1)
                self.assertEqual(len([e for e in events if e["kind"] == "error"]), 1)
                self.assertNotIn("The assistant is busy, trying again", [e["summary"] for e in events])

    async def test_other_ways_for_the_agent_to_fail_are_not_retried(self):
        cases = [
            ("the service is unavailable", [foundry_agent.AgentError("agent_unavailable", "down")], "agent_unavailable"),
            ("an unexpected error", [RuntimeError("SECRET")], "internal_error"),
        ]
        for label, response, code in cases:
            with self.subTest(label=label):
                logs = self.assertLogs("ahm-demo", level="ERROR") if code == "internal_error" else nullcontext()
                with logs:
                    env, task, events, slept = await self.run_without_waiting([response, script(REVIEW)], logged=False)

                self.assertEqual(task["error"]["code"], code)
                self.assertEqual((slept, len(env.agent.calls)), ([], 1))

    async def test_a_busy_model_and_a_lost_conversation_are_each_retried_on_their_own(self):
        lost = [foundry_agent.ConversationNotFound("gone")]
        cases = [
            ("busy, then lost, then fine", [BUSY, lost, script(REVIEW)], "done", [5], 3, 2),
            ("lost, then busy, then fine", [lost, BUSY, script(REVIEW)], "done", [5], 3, 2),
            ("busy, lost, then lost again", [BUSY, lost, lost], "failed", [5], 3, 2),
            ("busy after the new conversation four times", [lost, BUSY, BUSY, BUSY, BUSY], "failed", [5, 15, 30], 5, 2),
        ]
        for label, responses, status, pauses, calls, conversations in cases:
            with self.subTest(label=label):
                env, task, events, slept = await self.run_without_waiting(responses)

                self.assertEqual(task["status"], status, task.get("error"))
                self.assertEqual((slept, len(env.agent.calls), env.agent.created), (pauses, calls, conversations))

    async def test_the_pauses_are_the_configured_ones_and_count_against_the_task_time(self):
        with mock.patch.object(task_runner, "BUSY_RETRY_SECONDS", (0, 0)):
            env, task, events, _ = await self.run_without_waiting([BUSY, BUSY, BUSY])

        self.assertEqual(task["status"], "failed")
        self.assertEqual(len(env.agent.calls), 3)
        self.assertEqual(len([e for e in events if e["summary"] == "The assistant is busy, trying again"]), 2)
        env = Env(BUSY, BUSY, timeout=0.05)
        sid = await env.session()
        with mock.patch.object(task_runner, "BUSY_RETRY_SECONDS", (30,)), self.assertLogs("ahm-demo", level="WARNING"):
            task, events = await env.run(sid, env.fields())

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "timeout"))
        self.assertNotIn("error", [e["kind"] for e in events][:-1])


class ProblemTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_task_without_an_accepted_result_names_the_last_rejection_and_carries_its_problems(self):
        many = [f"changes[{n}]: bad" for n in range(60)]
        said = "The agent got no result accepted. The last one was rejected: "
        cases = [
            ("one rejection, one problem", [["only one"]], said + "only one", ["only one"]),
            ("two rejections", [["old a", "old b"], ["new a", "new b", "new c"]], said + "new a (and 2 more)", ["new a", "new b", "new c"]),
            ("a long list is bounded", [many], said + "changes[0]: bad (and 59 more)", [*many[:50], "10 more problems not shown"]),
            ("a long first problem is clipped", [["z" * 400]], said + "z" * 120 + "... [105 more characters]", ["z" * 200 + "... [200 more characters]"]),
        ]
        for label, lists, message, problems in cases:
            with self.subTest(label=label):
                env = Env(rejections(*lists))
                sid = await env.session()

                task, events = await env.run(sid, env.fields())

                self.assertEqual(task["status"], "failed")
                self.assertEqual(task["error"], {"code": "no_result", "message": message, "problems": problems})
                (error,) = [e for e in events if e["kind"] == "error"]
                self.assertEqual(error["payload"], {"code": "no_result", "message": message, "problems": problems})
                shown = [e["payload"]["problems"] for e in events if e["kind"] == "tool_result"]
                self.assertEqual(len(shown), len(lists))
                self.assertEqual(shown[-1], problems)
                self.assertEqual(shown[0][0], activity.clip_problems(lists[0])[0])
                self.assertEqual(json.loads(json.dumps(task["error"])), task["error"])

    async def test_a_task_that_was_never_rejected_or_failed_for_another_reason_carries_no_problems(self):
        cases = [
            ("nothing submitted", [stream(CREATED, ("response.completed", {"response": {"id": "r"}}))], "no_result"),
            ("a rejection that listed nothing", [rejections([])], "no_result"),
            ("an agent failure", [stream(CREATED, ("response.failed", {"response": {"error": {"code": "denied", "message": "No."}}}))], "agent_failed"),
            ("an agent error", [[foundry_agent.AgentError("agent_unavailable", "down")]], "agent_unavailable"),
        ]
        for label, responses, code in cases:
            with self.subTest(label=label):
                env = Env(*responses)
                sid = await env.session()
                logs = self.assertLogs("ahm-demo", level="WARNING") if code == "agent_failed" else nullcontext()

                with logs:
                    task, events = await env.run(sid, env.fields())

                self.assertEqual(task["error"]["code"], code)
                self.assertNotIn("problems", task["error"])
                self.assertTrue(all("problems" not in e["payload"] for e in events if e["kind"] == "error"))

    async def test_an_invalid_result_carries_every_problem_of_the_web_side_check_too(self):
        def ghosts(count):
            changes = [{**REVIEW["changes"][0], "id": f"c{n}", "name": f"ghost-{n:02d}"} for n in range(count)]
            return {**REVIEW, "changes": changes, "findings": []}

        cases = [("two problems", 2, 2, "(and 1 more)"), ("a capped list", 30, 21, "(and 20 more)")]
        for label, count, listed, more in cases:
            with self.subTest(label=label):
                env = Env(script(ghosts(count)))
                sid = await env.session()

                task, events = await env.run(sid, env.fields())

                (error,) = [e for e in events if e["kind"] == "error"]
                self.assertEqual(task["error"]["code"], "invalid_result")
                self.assertEqual(len(task["error"]["problems"]), listed)
                self.assertEqual(task["error"]["problems"], error["payload"]["problems"])
                self.assertIn("does not exist in the model", task["error"]["problems"][0])
                self.assertTrue(task["error"]["message"].endswith(more), task["error"]["message"])
                if count > 20:
                    self.assertEqual(task["error"]["problems"][-1], f"{count - 20} more problems not shown")


class TimeLimitTests(unittest.IsolatedAsyncioTestCase):
    def test_a_task_gets_ten_minutes_unless_told_otherwise(self):
        self.assertEqual(config.TASK_TIMEOUT_SECONDS, 600)
        self.assertEqual(inspect.signature(task_runner.TaskRunner).parameters["timeout"].default, 600)

    async def test_the_timeout_failure_names_the_limit_in_minutes(self):
        real_timeout = asyncio.timeout
        env = Env([asyncio.Event()], timeout=600)
        sid = await env.session()

        with mock.patch.object(task_runner.asyncio, "timeout", lambda delay: real_timeout(0.05)):
            task, _ = await env.run(sid, env.fields())

        self.assertEqual(task["error"], {"code": "timeout", "message": "The task did not finish within 10 minutes."})


class FinalSaveTests(unittest.IsolatedAsyncioTestCase):
    async def run_with_failing_saves(self, responses, failures):
        env = Env(*responses)
        sid = await env.session()
        attempts, original = [], env.store.save_task

        async def flaky(owner, sid_, task):
            if task["status"] in ("done", "failed"):
                attempts.append(task["status"])
                if len(attempts) <= failures:
                    raise sessions_store.StoreUnavailable("save_task")
            return await original(owner, sid_, task)

        env.store.save_task = flaky
        sleeps, real_sleep = [], asyncio.sleep

        async def recording(delay, *args):
            sleeps.append(delay)
            await real_sleep(0)

        with mock.patch.object(task_runner.asyncio, "sleep", recording):
            task = await env.runner.start(env.caller, sid, env.fields())
            queue = env.runner.attach(OWNER, sid, task["seq"])
            while await queue.get() is not None:
                pass
        return env, sid, attempts, sleeps

    async def test_the_final_save_is_retried_with_growing_pauses(self):
        agent_down = [[foundry_agent.AgentError("agent_unavailable", "down")]]
        cases = [
            ("done, first try", [script(REVIEW)], 0, "done", None, 1, []),
            ("done, after one failure", [script(REVIEW)], 1, "done", None, 2, [0.2]),
            ("done, after three failures", [script(REVIEW)], 3, "done", None, 4, [0.2, 0.5, 1.0]),
            ("done, never saved falls back to a recorded failure", [script(REVIEW)], 4, "failed", "store_unavailable", 5, [0.2, 0.5, 1.0]),
            ("failed, first try", agent_down, 0, "failed", "agent_unavailable", 1, []),
            ("failed, after three failures", agent_down, 3, "failed", "agent_unavailable", 4, [0.2, 0.5, 1.0]),
            ("failed, never saved", agent_down, 4, "running", None, 4, [0.2, 0.5, 1.0]),
        ]
        for label, responses, failures, status, code, attempts_made, pauses in cases:
            with self.subTest(label=label):
                logs = self.assertLogs("ahm-demo", level="ERROR") if status == "running" else nullcontext()
                with logs:
                    env, sid, attempts, sleeps = await self.run_with_failing_saves(responses, failures)

                stored = await env.store.get_task(OWNER, sid, 1)
                self.assertEqual(stored["status"], status)
                self.assertEqual((stored.get("error") or {}).get("code"), code)
                self.assertEqual(len(attempts), attempts_made)
                self.assertEqual([s for s in sleeps if s in (0.2, 0.5, 1.0)], pauses)
                self.assertFalse(env.runner.is_running(OWNER, sid))


class MessageTests(unittest.IsolatedAsyncioTestCase):
    async def test_failure_messages_are_clipped_redacted_stored_and_the_full_text_only_logged(self):
        long = "m" * 1000
        failed = lambda message: stream(("response.failed", {"response": {"error": {"code": "denied", "message": message}}}))
        cases = [
            ("agent reported failure", [failed(f"{long} {TOKEN}")], "agent_failed", "agent reported failure"),
            ("agent error from the service", [[foundry_agent.AgentError("agent_unavailable", f"{long} {TOKEN}")]], "agent_unavailable", "task failure message shortened"),
        ]
        for label, responses, code, logged in cases:
            with self.subTest(label=label):
                env = Env(*responses)
                sid = await env.session()

                with self.assertLogs("ahm-demo", level="WARNING") as captured:
                    task, events = await env.run(sid, env.fields())

                (error,) = [e for e in events if e["kind"] == "error"]
                self.assertEqual(task["error"]["code"], code)
                self.assertLessEqual(len(task["error"]["message"]), 300)
                self.assertLessEqual(len(error["payload"]["message"]), 300)
                self.assertNotIn("eyJ", json.dumps([task, events]))
                logs = "\n".join(captured.output)
                self.assertIn(logged, logs)
                self.assertIn(long, logs)
                self.assertNotIn("eyJ", logs)

    async def test_tokens_in_what_the_agent_says_and_asks_are_never_stored(self):
        env = Env(stream(
            *fake_agent.message(1, f"The bearer is {TOKEN}"),
            *fake_agent.call(1, "run_shell", {"command": f"curl -H 'Authorization: {TOKEN}'"}, "ok"),
            ("response.completed", {"response": {}}),
        ))
        sid = await env.session()

        task, events = await env.run(sid, env.fields())

        self.assertEqual(task["error"]["code"], "no_result")
        self.assertNotIn("eyJ", json.dumps(events))
        self.assertIn("[redacted token]", json.dumps(events))


class RegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_one_task_runs_per_session(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)], script(REVIEW))
        stranger = person(2)
        sid, other = await env.session(), await env.session(stranger)

        first = await env.runner.start(env.caller, sid, env.fields())
        self.assertTrue(env.runner.is_running(OWNER, sid))
        with self.assertRaises(task_runner.TaskRunning) as again:
            await env.runner.start(env.caller, sid, env.fields())
        self.assertIs(type(again.exception), task_runner.TaskRunning)
        self.assertEqual(len(await env.store.list_tasks(OWNER, sid)), 1)
        elsewhere = await env.runner.start(stranger, other, env.fields())
        self.assertEqual(elsewhere["seq"], 1)

        queue = env.runner.attach(OWNER, sid, first["seq"])
        gate.set()
        while await queue.get() is not None:
            pass
        await asyncio.sleep(0)

        self.assertFalse(env.runner.is_running(OWNER, sid))
        env.agent.responses.append(script(REVIEW))
        again = await env.runner.start(env.caller, sid, env.fields())
        self.assertEqual(again["seq"], 2)
        await env.runner.shutdown()

    async def test_concurrent_starts_cannot_both_win(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)], [gate, *script(REVIEW)])
        sid = await env.session()

        results = await asyncio.gather(
            env.runner.start(env.caller, sid, env.fields()), env.runner.start(env.caller, sid, env.fields()), return_exceptions=True
        )

        self.assertEqual(sorted(type(r).__name__ for r in results), ["TaskRunning", "dict"])
        self.assertEqual(len(await env.store.list_tasks(OWNER, sid)), 1)
        await env.runner.shutdown()

    async def test_subscribers_get_live_events_and_a_final_sentinel(self):
        gate = asyncio.Event()
        env = Env([*script(REVIEW)[:2], gate, *script(REVIEW)[2:]])
        sid = await env.session()
        task = await env.runner.start(env.caller, sid, env.fields())
        queue = env.runner.attach(OWNER, sid, task["seq"])

        self.assertIsNone(env.runner.attach(OWNER, sid, task["seq"] + 1))
        self.assertIsNone(env.runner.attach(OWNER, "nope", 1))
        seen = [await asyncio.wait_for(queue.get(), 2) for _ in range(3)]
        await asyncio.sleep(0.05)
        self.assertEqual(
            [e["summary"] for e in seen],
            ["Review task started", "Base model captured (5 entities)", "Agent started"],
        )
        self.assertTrue(queue.empty())
        gate.set()
        while (event := await asyncio.wait_for(queue.get(), 2)) is not None:
            seen.append(event)

        self.assertEqual([e["seq"] for e in seen], list(range(1, len(seen) + 1)))
        self.assertEqual(seen[-1]["summary"], "Result verified")
        self.assertIsNone(env.runner.attach(OWNER, sid, task["seq"]))

    async def test_detached_subscribers_stop_receiving(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        sid = await env.session()
        task = await env.runner.start(env.caller, sid, env.fields())
        queue = env.runner.attach(OWNER, sid, task["seq"])
        await asyncio.sleep(0.05)
        while not queue.empty():
            queue.get_nowait()

        env.runner.detach(OWNER, sid, queue)
        gate.set()
        await asyncio.sleep(0.05)

        self.assertTrue(queue.empty())
        env.runner.detach(OWNER, "nope", queue)
        await env.runner.shutdown()


class CallerTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_run_reads_the_model_as_the_user_who_started_it(self):
        env = Env(script(REVIEW), script(REVIEW))
        seen = []
        original = env.health.as_user
        env.health.as_user = lambda caller: seen.append(caller) or original(caller)

        for user in (CALLER, person(2)):
            env.caller = user
            await env.run(await env.session(), env.fields())

        self.assertEqual(seen, [CALLER, person(2)])

    async def test_failures_that_need_the_user_are_reported_with_their_own_code(self):
        cases = [
            ("sign in again", obo.InteractionRequired(CLAIMS), "interaction_required", task_runner.SIGN_IN_AGAIN),
            ("consent", obo.ConsentRequired(), "consent_required", task_runner.CONSENT_MISSING),
        ]
        for label, error, code, message in cases:
            with self.subTest(label=label):
                env = Env(script(REVIEW))
                sid = await env.session()

                def refuse(*args, _error=error):
                    raise _error

                env.health.read_model = refuse

                task, events = await env.run(sid, env.fields())

                self.assertEqual((task["status"], task["error"]), ("failed", {"code": code, "message": message}))
                (event,) = [e for e in events if e["kind"] == "error"]
                self.assertEqual(event["payload"]["code"], code)
                self.assertNotIn(CLAIMS, json.dumps([task, events]))
                self.assertFalse(env.runner.is_running(OWNER, sid))

    async def test_neither_the_assertion_nor_the_nonce_is_stored(self):
        env = Env(script(REVIEW))
        sid = await env.session()

        await env.run(sid, env.fields())

        stored = repr(vars(env.store))
        self.assertNotIn(CALLER.assertion, stored)
        self.assertNotIn(sent_nonce(env), stored)


class NonceTests(unittest.IsolatedAsyncioTestCase):
    async def running(self, env, caller=None):
        caller = caller or env.caller
        await env.runner.start(caller, await env.session(caller), env.fields())
        await asyncio.sleep(0.05)
        nonce = sent_nonce(env)
        return nonce, env.runner.run_for_nonce(nonce)

    async def test_each_run_gets_its_own_nonce_bound_to_the_user_who_started_it(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)], [gate, *script(REVIEW)])
        stranger = person(2)

        first, run_one = await self.running(env)
        second, run_two = await self.running(env, stranger)

        for nonce in (first, second):
            self.assertRegex(nonce, r"^[A-Za-z0-9_-]{43,}$")
        self.assertNotEqual(first, second)
        self.assertEqual((run_one.owner, run_one.caller), (OWNER, CALLER))
        self.assertEqual((run_two.owner, run_two.caller), (stranger.oid, stranger))
        gate.set()
        await env.runner.shutdown()

    async def test_the_nonce_and_the_assertion_are_gone_when_the_run_ends_however_it_ends(self):
        cases = [
            ("done", lambda gate: [gate, *script(REVIEW)], "release"),
            ("agent error", lambda gate: [gate, foundry_agent.AgentError("agent_unavailable", "down")], "release"),
            ("unexpected error", lambda gate: [gate, RuntimeError("boom")], "release"),
            ("timeout", lambda gate: [asyncio.Event()], "wait"),
            ("shutdown", lambda gate: [asyncio.Event()], "shutdown"),
        ]
        for label, responses, ending in cases:
            with self.subTest(label=label):
                gate = asyncio.Event()
                env = Env(responses(gate), timeout=0.3)
                nonce, run = await self.running(env)
                self.assertIsNotNone(run)
                logs = self.assertLogs("ahm-demo", level="ERROR") if label == "unexpected error" else nullcontext()

                with logs:
                    if ending == "release":
                        gate.set()
                    if ending == "shutdown":
                        await env.runner.shutdown()
                    await asyncio.wait_for(asyncio.gather(run.handle, return_exceptions=True), 2)

                self.assertIsNone(env.runner.run_for_nonce(nonce))
                self.assertEqual((run.nonce, run.caller, run.health), (None, None, None))
                self.assertFalse(env.runner.is_running(OWNER, run.task["sessionId"]))

    async def test_only_the_exact_nonce_of_an_active_run_finds_it(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        nonce, run = await self.running(env)
        cases = [
            ("the nonce", nonce, True),
            ("nothing", "", False),
            ("a prefix", nonce[:-1], False),
            ("one more character", nonce + "a", False),
            ("another case", nonce.swapcase(), False),
            ("a trailing newline", nonce + "\n", False),
            ("another nonce of the same length", "a" * len(nonce), False),
            ("non ascii text", "\u00e9" * len(nonce), False),
        ]
        for label, text, found in cases:
            with self.subTest(label=label):
                self.assertIs(env.runner.run_for_nonce(text), run if found else None)
        gate.set()
        await env.runner.shutdown()

    async def test_the_nonce_is_compared_in_constant_time(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        nonce, run = await self.running(env)

        with mock.patch.object(task_runner.secrets, "compare_digest", wraps=secrets.compare_digest) as compared:
            self.assertIs(env.runner.run_for_nonce(nonce), run)
            self.assertIsNone(env.runner.run_for_nonce("x"))

        self.assertEqual(compared.call_count, 2)
        for call in compared.call_args_list:
            self.assertTrue(all(isinstance(argument, bytes) for argument in call.args))
        gate.set()
        await env.runner.shutdown()

    async def test_the_nonce_of_a_run_never_opens_another_users_run_after_it_ended(self):
        env = Env(script(REVIEW), script(REVIEW))
        sid = await env.session()
        await env.run(sid, env.fields())
        old = sent_nonce(env)
        env.caller = person(2)

        await env.run(await env.session(), env.fields())

        self.assertNotEqual(old, sent_nonce(env))
        self.assertIsNone(env.runner.run_for_nonce(old))


class TokenRateTests(unittest.TestCase):
    def test_a_run_may_ask_for_a_limited_number_of_tokens_per_minute(self):
        limit = task_runner.BROKER_CALLS_PER_MINUTE
        cases = [
            ("up to the limit in one moment", [1000.0] * limit, [True] * limit),
            ("one over the limit", [1000.0] * (limit + 1), [True] * limit + [False]),
            ("still inside the minute", [1000.0] * limit + [1059.9], [True] * limit + [False]),
            ("a new minute", [1000.0] * limit + [1060.0], [True] * (limit + 1)),
            ("a full new allowance", [1000.0] * limit + [1060.0] * limit, [True] * (2 * limit)),
            ("refusals do not count", [1000.0] * limit + [1001.0] * 5 + [1060.0], [True] * limit + [False] * 5 + [True]),
            ("spread calls slide the window", [1000.0 + 2 * n for n in range(limit)] + [1060.0, 1060.5, 1062.0], [True] * limit + [True, False, True]),
        ]
        for label, times, expected in cases:
            with self.subTest(label=label):
                run = task_runner.Run(CALLER)

                self.assertEqual([run.allows_token(now) for now in times], expected)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_unfinished_tasks_are_failed_as_interrupted_on_startup(self):
        env = Env()
        sid = await env.session()
        for status in ("running", "queued", "done", "failed"):
            task = await env.store.create_task(OWNER, sid, {"type": "review", "status": status, "createdAt": "t"})
        running = await env.store.get_task(OWNER, sid, 1)
        await env.store.append_event(OWNER, sid, 1, {"seq": 1, "ts": "t", "kind": "status", "summary": "x", "payload": {}})
        await env.store.append_event(OWNER, sid, 1, {"seq": 2, "ts": "t", "kind": "text", "summary": "y", "payload": {}})
        done_before = await env.store.get_task(OWNER, sid, 3)

        await env.runner.recover()

        tasks = {t["seq"]: t for t in await env.store.list_tasks(OWNER, sid)}
        for seq in (1, 2):
            self.assertEqual(tasks[seq]["status"], "failed")
            self.assertEqual(tasks[seq]["error"]["code"], "interrupted")
            self.assertRegex(tasks[seq]["finishedAt"], r"Z$")
        self.assertEqual(tasks[3], done_before)
        self.assertEqual(tasks[4]["status"], "failed")
        self.assertNotIn("error", tasks[4])
        events = await env.store.read_events(OWNER, sid, 1)
        self.assertEqual([e["seq"] for e in events], [1, 2, 3])
        self.assertEqual((events[-1]["kind"], events[-1]["payload"]["code"]), ("error", "interrupted"))
        self.assertEqual([e["seq"] for e in await env.store.read_events(OWNER, sid, 2)], [1])
        await env.runner.recover()
        self.assertEqual(len(await env.store.read_events(OWNER, sid, 1)), 3)
        self.assertEqual(running["status"], "running")

    async def test_recovery_reads_only_the_tasks_that_are_unfinished(self):
        env = Env()
        busy, quiet = await env.session(), await env.session()
        for status in ("done", "failed", "done"):
            await env.store.create_task(OWNER, quiet, {"type": "review", "status": status, "createdAt": "t"})
        await env.store.create_task(OWNER, busy, {"type": "review", "status": "running", "createdAt": "t"})
        calls = []
        for name in ("list_sessions", "list_tasks", "get_task", "read_events", "append_event", "save_task"):
            original = getattr(env.store, name)

            async def spy(*args, _name=name, _original=original):
                calls.append((_name, *args[:2]))
                return await _original(*args)

            setattr(env.store, name, spy)

        await env.runner.recover()

        self.assertEqual(
            sorted(calls),
            sorted([(name, OWNER, busy) for name in ("get_task", "read_events", "append_event", "save_task")]),
        )
        self.assertEqual((await env.store.get_task(OWNER, busy, 1))["error"]["code"], "interrupted")
        self.assertEqual([t["status"] for t in await env.store.list_tasks(OWNER, quiet)], ["done", "failed", "done"])

    async def test_recovery_interrupts_the_unfinished_tasks_of_every_user_and_keeps_them_apart(self):
        env = Env()
        users = [CALLER, person(2), person(3)]
        sessions = {user.oid: await env.session(user) for user in users}
        for user in users:
            await env.store.create_task(user.oid, sessions[user.oid], {"type": "review", "status": "running", "createdAt": "t"})
        await env.store.create_task(OWNER, sessions[OWNER], {"type": "review", "status": "done", "createdAt": "t"})

        await env.runner.recover()

        for user in users:
            tasks = await env.store.list_tasks(user.oid, sessions[user.oid])
            self.assertEqual(tasks[0]["error"]["code"], "interrupted", user.name)
            self.assertEqual([e["payload"].get("code") for e in await env.store.read_events(user.oid, sessions[user.oid], 1)], ["interrupted"])
        self.assertEqual([t["status"] for t in await env.store.list_tasks(OWNER, sessions[OWNER])], ["failed", "done"])
        self.assertEqual(len(await env.store.list_tasks(users[1].oid, sessions[users[1].oid])), 1)

    async def test_recovery_leaves_tasks_this_process_is_running_alone(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        live, crashed = await env.session(), await env.session()
        await env.store.create_task(OWNER, crashed, {"type": "review", "status": "running", "createdAt": "t"})
        await env.runner.start(env.caller, live, env.fields())

        await env.runner.recover()

        self.assertEqual((await env.store.get_task(OWNER, live, 1))["status"], "running")
        self.assertEqual((await env.store.get_task(OWNER, crashed, 1))["error"]["code"], "interrupted")
        gate.set()
        await env.runner.shutdown()

    async def test_shutdown_cancels_running_tasks_and_records_them_as_interrupted(self):
        env = Env([asyncio.Event()])
        sid = await env.session()
        task = await env.runner.start(env.caller, sid, env.fields())
        await asyncio.sleep(0.05)

        await env.runner.shutdown()

        stored = await env.store.get_task(OWNER, sid, task["seq"])
        self.assertEqual((stored["status"], stored["error"]["code"]), ("failed", "interrupted"))
        self.assertFalse(env.runner.is_running(OWNER, sid))
        self.assertEqual((await env.store.read_events(OWNER, sid, 1))[-1]["payload"]["code"], "interrupted")


class OrphanTests(unittest.IsolatedAsyncioTestCase):
    async def seed(self, env, status="running", age=600, sid=None):
        sid = sid or await env.session()
        created = "t" if age is None else dto.iso(datetime.now(timezone.utc) - timedelta(seconds=age))
        task = await env.store.create_task(OWNER, sid, {"type": "review", "status": status, "createdAt": created, "target": TARGET})
        await env.store.append_event(OWNER, sid, task["seq"], {"seq": 1, "ts": created, "kind": "status", "summary": "x", "payload": {}})
        return sid, task

    async def test_a_running_task_nobody_is_running_reads_as_interrupted_once_it_is_older_than_the_window(self):
        cases = [
            ("old running", "running", 600, True),
            ("old queued", "queued", 600, True),
            ("just over the window", "running", 121, True),
            ("just under the window", "running", 119, False),
            ("brand new", "running", 1, False),
            ("unreadable creation time", "running", None, True),
            ("done", "done", 600, False),
            ("failed", "failed", 600, False),
        ]
        for label, status, age, orphaned in cases:
            with self.subTest(label=label):
                env = Env()
                sid, task = await self.seed(env, status, age)

                seen = await env.runner.settled(OWNER, sid, task)
                stored = await env.store.get_task(OWNER, sid, 1)
                events = await env.store.read_events(OWNER, sid, 1)

                if orphaned:
                    self.assertEqual((seen["status"], seen["error"]["code"]), ("failed", "interrupted"))
                    self.assertRegex(seen["finishedAt"], r"Z$")
                    self.assertEqual(stored, seen | {"finishedAt": stored["finishedAt"]})
                    self.assertEqual([e["seq"] for e in events], [1, 2])
                    self.assertEqual((events[-1]["kind"], events[-1]["payload"]["code"]), ("error", "interrupted"))
                else:
                    self.assertEqual(seen, task)
                    self.assertEqual(stored, task)
                    self.assertEqual(len(events), 1)

    async def test_a_task_this_process_is_running_is_never_called_interrupted_but_an_older_one_in_the_session_is(self):
        gate = asyncio.Event()
        env = Env([gate, *script(REVIEW)])
        sid, orphan = await self.seed(env)
        running = await env.runner.start(env.caller, sid, env.fields())

        with mock.patch.object(task_runner, "INTERRUPTED_GRACE_SECONDS", -1):
            alive = await env.runner.settled(OWNER, sid, running)
            old = await env.runner.settled(OWNER, sid, orphan)

        self.assertEqual(alive["status"], "running")
        self.assertEqual((old["status"], old["error"]["code"]), ("failed", "interrupted"))
        self.assertEqual((await env.store.get_task(OWNER, sid, 2))["status"], "running")
        gate.set()
        await env.runner.shutdown()

    async def test_a_store_that_cannot_record_it_still_gets_the_interrupted_view(self):
        env = Env()
        sid, task = await self.seed(env)

        async def broken(*args):
            raise sessions_store.StoreUnavailable("save_task")

        env.store.save_task = broken
        with self.assertLogs("ahm-demo", level="WARNING"):
            seen = await env.runner.settled(OWNER, sid, task)

        self.assertEqual((seen["status"], seen["error"]["code"]), ("failed", "interrupted"))
        self.assertEqual((await env.store.get_task(OWNER, sid, 1))["status"], "running")

    async def test_readers_asking_together_record_the_interruption_once(self):
        env = Env()
        sid, task = await self.seed(env)
        original = env.store.append_event

        async def slow(*args):
            await asyncio.sleep(0.01)
            await original(*args)

        env.store.append_event = slow

        seen = await asyncio.gather(*[env.runner.settled(OWNER, sid, task) for _ in range(6)])

        self.assertEqual({s["status"] for s in seen}, {"failed"})
        self.assertEqual([e["seq"] for e in await env.store.read_events(OWNER, sid, 1)], [1, 2])
        self.assertEqual((await env.store.get_task(OWNER, sid, 1))["status"], "failed")

    async def test_a_reader_that_saw_the_task_running_does_not_overwrite_a_result_saved_meanwhile(self):
        env = Env()
        sid, stale = await self.seed(env)
        await env.store.save_task(OWNER, sid, {**stale, "status": "done", "result": {"kind": "diff"}})

        seen = await env.runner.settled(OWNER, sid, stale)

        self.assertEqual(seen["status"], "done")
        self.assertEqual((await env.store.get_task(OWNER, sid, 1))["result"], {"kind": "diff"})
        self.assertEqual(len(await env.store.read_events(OWNER, sid, 1)), 1)


def caller_id(owner):
    return hashlib.sha256(owner.encode("utf-8")).hexdigest()[:16]


class SpanTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.exporter = InMemorySpanExporter()
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
        provider.add_span_processor(SimpleSpanProcessor(self.exporter))

    async def test_each_run_is_one_client_span_with_the_task_attributes(self):
        cases = [("done", script(REVIEW), StatusCode.UNSET), ("failed", script(REVIEW, REJECTED), StatusCode.ERROR)]
        for label, responses, status in cases:
            with self.subTest(label=label):
                self.exporter.clear()
                env = Env(responses)
                sid = await env.session()

                await env.run(sid, env.fields())

                (span,) = [s for s in self.exporter.get_finished_spans() if s.name == "foundry.agent.respond"]
                self.assertEqual(span.kind, SpanKind.CLIENT)
                self.assertEqual(span.status.status_code, status)
                self.assertEqual(
                    dict(span.attributes),
                    {"task.type": "review", "session.id": sid, "task.seq": 1, "caller.id": caller_id(OWNER)},
                )
                self.assertNotIn(OWNER, json.dumps(dict(span.attributes)))


if __name__ == "__main__":
    unittest.main()
