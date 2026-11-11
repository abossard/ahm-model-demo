import asyncio
import json
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))

import activity  # noqa: E402
import fixture_models  # noqa: E402
import foundry_agent  # noqa: E402
import sessions_store  # noqa: E402
import task_runner  # noqa: E402
from auth import Caller  # noqa: E402

# The agent contract as captured from a deployed agent (version 6): the trimmed and anonymized stream of an
# Explain run, the 404 a deleted conversation answers and the failure shape. Everything below is built from them.

SUB = "11111111-1111-1111-1111-111111111111"
CALLER = Caller("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Ada", "assertion-one")
GROUP = "rg-fixture"
MODEL = "hm-fixture"
DESIGN = "hm-fixture-design"
ENDPOINT = "https://acct.services.ai.azure.com/api/projects/proj/"
OLD_CONVERSATION = "conv_live_old" + "A" * 40
NEW_CONVERSATION = "conv_live_new"
UPSTREAM_ERROR = "An internal server error occurred."
EXPLAIN_RESULT = {
    "kind": "explain",
    "entity": "orders-api",
    "state": "Degraded",
    "summary": "orders-api is degraded because its order errors are above the threshold.",
    "causes": [
        {
            "entity": "orders-api",
            "signal": "order-errors",
            "state": "Degraded",
            "threshold": "> 1 Degraded",
            "value": 3,
            "rollup": "signal group azureResource",
            "note": "Three failed orders in the last hour.",
        }
    ],
}
MISSING = {
    "error": {
        "code": "not_found",
        "message": f"Conversation '{OLD_CONVERSATION}' not found. [Request ID: 0c3a47749ff4db15d4697e998d2422ce]",
        "type": "error",
        "details": [],
        "additionalInfo": {"request_id": "0c3a47749ff4db15d4697e998d2422ce"},
    }
}
FAILED = {
    "type": "response.failed",
    "response": {
        "id": "caresp_live1",
        "object": "response",
        "output": [],
        "error": {"code": "server_error", "message": UPSTREAM_ERROR},
        "status": "failed",
        "response_id": "caresp_live1",
    },
    "sequence_number": 27,
}

LIVE_EXPLAIN = r'''event: response.created
data: {"type": "response.created", "response": {"id": "caresp_live1", "object": "response", "output": [], "created_at": 1794361768, "error": null, "incomplete_details": null, "instructions": null, "parallel_tool_calls": false, "conversation": {"id": "conv_live1"}, "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}, "status": "in_progress", "response_id": "caresp_live1", "model": "", "agent_session_id": "session_live1"}, "sequence_number": 0}

event: response.in_progress
data: {"type": "response.in_progress", "response": {"id": "caresp_live1", "object": "response", "output": [], "created_at": 1794361768, "error": null, "incomplete_details": null, "instructions": null, "parallel_tool_calls": false, "conversation": {"id": "conv_live1"}, "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}, "status": "in_progress", "response_id": "caresp_live1", "model": "", "agent_session_id": "session_live1"}, "sequence_number": 1}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 0, "item": {"type": "function_call", "id": "fc_live1", "call_id": "call_live1", "name": "load_skill", "arguments": "", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 2}

event: response.function_call_arguments.delta
data: {"type": "response.function_call_arguments.delta", "item_id": "fc_live1", "output_index": 0, "delta": "{\"", "sequence_number": 3}

event: response.function_call_arguments.done
data: {"type": "response.function_call_arguments.done", "item_id": "fc_live1", "output_index": 0, "name": "load_skill", "arguments": "{\"skill_name\":\"healthmodel-analyze\"}", "sequence_number": 4}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 0, "item": {"type": "function_call", "id": "fc_live1", "call_id": "call_live1", "name": "load_skill", "arguments": "{\"skill_name\":\"healthmodel-analyze\"}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 5}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 1, "item": {"type": "function_call_output", "id": "fco_live1", "call_id": "call_live1", "output": "---\nname: healthmodel-analyze\ndescription: Read-only analysis of an existing Azure Monitor health model.\n---\nThe skill text.", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 6}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 1, "item": {"type": "function_call_output", "id": "fco_live1", "call_id": "call_live1", "output": "---\nname: healthmodel-analyze\ndescription: Read-only analysis of an existing Azure Monitor health model.\n---\nThe skill text.", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 7}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 2, "item": {"type": "function_call", "id": "fc_live2", "call_id": "call_live2", "name": "monitor_healthmodels_inspect", "arguments": "", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 8}

event: response.function_call_arguments.delta
data: {"type": "response.function_call_arguments.delta", "item_id": "fc_live2", "output_index": 2, "delta": "{\"", "sequence_number": 9}

event: response.function_call_arguments.done
data: {"type": "response.function_call_arguments.done", "item_id": "fc_live2", "output_index": 2, "name": "monitor_healthmodels_inspect", "arguments": "{\"subscription\":\"11111111-1111-1111-1111-111111111111\",\"resource-group\":\"rg-fixture\",\"health-model\":\"hm-fixture\",\"entity\":\"orders-api\",\"walk\":\"Causes\",\"include\":[\"Signals\"],\"top\":500}", "sequence_number": 10}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 2, "item": {"type": "function_call", "id": "fc_live2", "call_id": "call_live2", "name": "monitor_healthmodels_inspect", "arguments": "{\"subscription\":\"11111111-1111-1111-1111-111111111111\",\"resource-group\":\"rg-fixture\",\"health-model\":\"hm-fixture\",\"entity\":\"orders-api\",\"walk\":\"Causes\",\"include\":[\"Signals\"],\"top\":500}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 11}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 3, "item": {"type": "function_call", "id": "fc_live3", "call_id": "call_live3", "name": "monitor_healthmodels_get", "arguments": "", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 12}

event: response.function_call_arguments.delta
data: {"type": "response.function_call_arguments.delta", "item_id": "fc_live3", "output_index": 3, "delta": "{\"", "sequence_number": 13}

event: response.function_call_arguments.done
data: {"type": "response.function_call_arguments.done", "item_id": "fc_live3", "output_index": 3, "name": "monitor_healthmodels_get", "arguments": "{\"subscription\":\"11111111-1111-1111-1111-111111111111\",\"resource-group\":\"rg-fixture\",\"health-model\":\"hm-fixture\"}", "sequence_number": 14}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 3, "item": {"type": "function_call", "id": "fc_live3", "call_id": "call_live3", "name": "monitor_healthmodels_get", "arguments": "{\"subscription\":\"11111111-1111-1111-1111-111111111111\",\"resource-group\":\"rg-fixture\",\"health-model\":\"hm-fixture\"}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 15}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 4, "item": {"type": "function_call_output", "id": "fco_live2", "call_id": "call_live2", "output": "{\"status\":200,\"message\":\"Success\",\"results\":{\"entities\":[{\"path\":\"orders-api\",\"entity\":{\"name\":\"orders-api\"}}]}}", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 16}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 4, "item": {"type": "function_call_output", "id": "fco_live2", "call_id": "call_live2", "output": "{\"status\":200,\"message\":\"Success\",\"results\":{\"entities\":[{\"path\":\"orders-api\",\"entity\":{\"name\":\"orders-api\"}}]}}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 17}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 5, "item": {"type": "function_call_output", "id": "fco_live3", "call_id": "call_live3", "output": "{\"status\":200,\"message\":\"Success\",\"results\":{\"healthModel\":{\"healthState\":\"Degraded\"}}}", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 18}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 5, "item": {"type": "function_call_output", "id": "fco_live3", "call_id": "call_live3", "output": "{\"status\":200,\"message\":\"Success\",\"results\":{\"healthModel\":{\"healthState\":\"Degraded\"}}}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 19}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 6, "item": {"type": "function_call", "id": "fc_live4", "call_id": "call_live4", "name": "submit_result", "arguments": "", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 20}

event: response.function_call_arguments.delta
data: {"type": "response.function_call_arguments.delta", "item_id": "fc_live4", "output_index": 6, "delta": "{\"", "sequence_number": 21}

event: response.function_call_arguments.done
data: {"type": "response.function_call_arguments.done", "item_id": "fc_live4", "output_index": 6, "name": "submit_result", "arguments": "{\"result\":{\"kind\":\"explain\",\"entity\":\"orders-api\",\"state\":\"Degraded\",\"summary\":\"orders-api is degraded because its order errors are above the threshold.\",\"causes\":[{\"entity\":\"orders-api\",\"signal\":\"order-errors\",\"state\":\"Degraded\",\"threshold\":\"> 1 Degraded\",\"value\":3,\"rollup\":\"signal group azureResource\",\"note\":\"Three failed orders in the last hour.\"}]}}", "sequence_number": 22}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 6, "item": {"type": "function_call", "id": "fc_live4", "call_id": "call_live4", "name": "submit_result", "arguments": "{\"result\":{\"kind\":\"explain\",\"entity\":\"orders-api\",\"state\":\"Degraded\",\"summary\":\"orders-api is degraded because its order errors are above the threshold.\",\"causes\":[{\"entity\":\"orders-api\",\"signal\":\"order-errors\",\"state\":\"Degraded\",\"threshold\":\"> 1 Degraded\",\"value\":3,\"rollup\":\"signal group azureResource\",\"note\":\"Three failed orders in the last hour.\"}]}}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 23}

event: response.output_item.added
data: {"type": "response.output_item.added", "output_index": 7, "item": {"type": "function_call_output", "id": "fco_live4", "call_id": "call_live4", "output": "{\"status\":\"accepted\"}", "status": "in_progress", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 24}

event: response.output_item.done
data: {"type": "response.output_item.done", "output_index": 7, "item": {"type": "function_call_output", "id": "fco_live4", "call_id": "call_live4", "output": "{\"status\":\"accepted\"}", "status": "completed", "response_id": "caresp_live1", "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}}, "sequence_number": 25}

event: response.completed
data: {"type": "response.completed", "response": {"id": "caresp_live1", "object": "response", "output": [], "created_at": 1794361768, "error": null, "incomplete_details": null, "instructions": null, "parallel_tool_calls": false, "conversation": {"id": "conv_live1"}, "agent_reference": {"type": "agent_reference", "name": "health-model-agent", "version": "6"}, "status": "completed", "completed_at": 1794361778, "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}, "response_id": "caresp_live1", "model": "", "agent_session_id": "session_live1"}, "sequence_number": 26}

'''


def parse(text):
    events = []
    for block in text.split("\n\n"):
        lines = block.strip().split("\n")
        if len(lines) == 2 and lines[0].startswith("event: "):
            events.append((lines[0][7:], json.loads(lines[1][6:])))
    return events


def render(events, keep_alive_every=0):
    blocks = []
    for number, (name, data) in enumerate(events, 1):
        blocks.append(f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n")
        if keep_alive_every and number % keep_alive_every == 0:
            blocks.append(": keep-alive\n\n")
    return "".join(blocks)


LIVE = parse(LIVE_EXPLAIN)


def copy_of(events):
    return json.loads(json.dumps(events))


def without_completion(events):
    return [event for event in copy_of(events) if event[0] != "response.completed"]


def doubled(events):
    changed = copy_of(events)
    for name, data in changed:
        item = data.get("item") or {}
        if name == "response.output_item.done" and item.get("name") == "submit_result":
            item["arguments"] += item["arguments"]
        if name == "response.function_call_arguments.done" and data.get("name") == "submit_result":
            data["arguments"] += data["arguments"]
    return changed


def before_submission(events):
    cut = next(
        number
        for number, (name, data) in enumerate(events)
        if name == "response.output_item.added" and (data.get("item") or {}).get("name") == "submit_result"
    )
    return copy_of(events[:cut])


def with_output(events, tool, output):
    changed = copy_of(events)
    calls = {
        data["item"]["call_id"]
        for name, data in changed
        if name == "response.output_item.done" and data["item"].get("name") == tool
    }
    for name, data in changed:
        item = data.get("item") or {}
        if item.get("type") == "function_call_output" and item["call_id"] in calls:
            item["output"] = output
    return changed


class Wire:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def paths(self):
        return [(request.method, request.url.path.rsplit("/", 1)[-1]) for request in self.requests]


class Cut(httpx.AsyncByteStream):
    def __init__(self, text, error):
        self.text = text
        self.error = error

    async def __aiter__(self):
        yield self.text.encode()
        raise self.error


def stream(events, keep_alive_every=0):
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=render(events, keep_alive_every).encode()
    )


def cut(events, error=None):
    return httpx.Response(200, stream=Cut(render(events), error or httpx.ReadError("connection reset")))


def new_conversation(identifier=NEW_CONVERSATION):
    return httpx.Response(200, json={"id": identifier, "object": "conversation", "created_at": 1794361768, "metadata": {}})


def missing():
    return httpx.Response(404, json=MISSING)


class Live:
    def __init__(self, *answers, conversation=None):
        self.store = sessions_store.MemorySessionsStore()
        self.health = fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, DESIGN))
        self.wire = Wire(*answers)
        credential = SimpleNamespace(get_token=lambda scope: SimpleNamespace(token="the-token"))
        self.agent = foundry_agent.FoundryAgent(
            credential, ENDPOINT, "health-model-agent", transport=httpx.MockTransport(self.wire)
        )
        self.runner = task_runner.TaskRunner(self.store, self.agent, self.health, timeout=10)
        self.conversation = conversation

    async def run(self):
        session = await self.store.create_session(CALLER.oid, "S")
        if self.conversation:
            await self.store.save_session(CALLER.oid, {**session, "conversationId": self.conversation})
        fields = {
            "type": "explain",
            "target": {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL, "entity": "orders-api"},
            "instruction": "",
            "createdAt": sessions_store.utc_now(),
        }
        task = await self.runner.start(CALLER, session["id"], fields)
        queue = self.runner.attach(CALLER.oid, session["id"], task["seq"])
        while await queue.get() is not None:
            pass
        sid = session["id"]
        return (
            await self.store.get_task(CALLER.oid, sid, 1),
            await self.store.read_events(CALLER.oid, sid, 1),
            await self.store.get_session(CALLER.oid, sid),
        )


def timeline(events):
    return [(event["kind"], event["summary"]) for event in events]


class CurrentRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_current_agent_run_becomes_a_timeline_and_a_done_task(self):
        live = Live(new_conversation(), stream(LIVE, keep_alive_every=5))

        task, events, session = await live.run()

        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual(task["result"], EXPLAIN_RESULT)
        self.assertEqual(session["conversationId"], NEW_CONVERSATION)
        self.assertEqual(timeline(events), [
                ("status", "Explain task started"),
                ("status", "Agent started"),
                ("tool_call", "Load skill healthmodel-analyze"),
                ("tool_result", "Load skill healthmodel-analyze: ok, 124 B"),
                ("tool_call", "Inspect health model hm-fixture (entity orders-api, walk Causes)"),
                ("tool_call", "Get health model hm-fixture"),
                ("tool_result", "Inspect health model hm-fixture (entity orders-api, walk Causes): ok, 112 B"),
                ("tool_result", "Get health model hm-fixture: ok, 87 B"),
                ("tool_call", "Submit result (explain, 1 causes)"),
                ("tool_result", "Submit result (explain, 1 causes): accepted"),
                ("result", "Result accepted (explain, 1 causes)"),
                ("status", "Agent finished"),
                ("status", "Result verified"),
            ])
        self.assertNotIn("text", [event["kind"] for event in events])
        self.assertEqual(live.wire.paths(), [("POST", "conversations"), ("POST", "responses")])
        request = live.wire.requests[1]
        sent = json.loads(request.content)
        self.assertEqual((sent["conversation"], sent["stream"]), (NEW_CONVERSATION, True))
        self.assertTrue(sent["input"].startswith("Explain why this entity has its health state"))
        self.assertEqual(json.loads(sent["input"].split("\n", 1)[1])["task"]["target"]["entity"], "orders-api")
        self.assertEqual(request.headers["authorization"], "Bearer the-token")
        self.assertEqual(request.url.params["api-version"], "v1")

    async def test_a_tool_that_failed_is_a_failed_step_and_the_run_goes_on(self):
        error = 'Error: Function failed. Exception: {"status":404,"message":"Resource not found"}'
        live = Live(new_conversation(), stream(with_output(LIVE, "monitor_healthmodels_inspect", error)))

        task, events, _ = await live.run()

        results = [event for event in events if event["kind"] == "tool_result"]
        self.assertEqual(task["status"], "done")
        self.assertEqual([r["payload"]["ok"] for r in results], [True, False, True, True])
        self.assertIn("failed", results[1]["summary"])

    async def test_doubled_arguments_from_an_old_agent_version_still_finish_the_task(self):
        live = Live(new_conversation(), stream(doubled(LIVE)))

        task, events, _ = await live.run()

        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual(task["result"], EXPLAIN_RESULT)
        self.assertIn("Result accepted (explain, 1 causes)", [event["summary"] for event in events])


class AcceptedResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_accepted_result_stands_when_the_run_fails_afterwards(self):
        late = "Agent reported a failure after the result was accepted (server_error)"
        cut_stream = "Agent stream failed after the result was accepted (agent_unreachable)"
        cases = [
            ("response.failed instead of completed", stream(without_completion(LIVE) + [("response.failed", FAILED)]), late, True),
            ("an error event", stream(without_completion(LIVE) + [("error", {"type": "error", "code": "server_error", "message": "x"})]), late, True),
            ("a connection that breaks", cut(without_completion(LIVE)), cut_stream, False),
            ("a connection that times out", cut(without_completion(LIVE), httpx.ReadTimeout("silent")), cut_stream, False),
            ("a missing conversation reported late", stream(without_completion(LIVE) + [("response.failed", {"type": "response.failed", "response": {"status": "failed", "error": {"code": "not_found", "message": MISSING["error"]["message"]}}})]), "Agent stream failed after the result was accepted (conversation_not_found)", False),
        ]
        for label, answer, summary, logs in cases:
            with self.subTest(label=label):
                live = Live(new_conversation(), answer)

                with self.assertLogs("ahm-demo", level="WARNING") if logs else nullcontext():
                    task, events, _ = await live.run()

                self.assertEqual(task["status"], "done", task.get("error"))
                self.assertEqual(task["result"], EXPLAIN_RESULT)
                self.assertNotIn("error", [event["kind"] for event in events])
                self.assertEqual([e["kind"] for e in events if e["summary"] == summary], ["status"])
                self.assertEqual(events[-1]["summary"], "Result verified")
                self.assertEqual(live.wire.paths(), [("POST", "conversations"), ("POST", "responses")])

    async def test_without_an_accepted_result_a_failure_still_fails_the_task(self):
        rejected = with_output(LIVE, "submit_result", json.dumps({"status": "rejected", "problems": ["no"]}))
        cases = [
            ("failure before any submission", stream(before_submission(LIVE) + [("response.failed", FAILED)]), "agent_failed", True),
            ("failure after a rejected submission", stream(without_completion(rejected) + [("response.failed", FAILED)]), "agent_failed", True),
            ("a connection that breaks before the submission", cut(before_submission(LIVE)), "agent_unreachable", False),
        ]
        for label, answer, code, logs in cases:
            with self.subTest(label=label):
                live = Live(new_conversation(), answer)

                with self.assertLogs("ahm-demo", level="WARNING") if logs else nullcontext():
                    task, events, _ = await live.run()

                self.assertEqual((task["status"], task["error"]["code"]), ("failed", code))
                self.assertNotIn("result", task)
                self.assertEqual(len([e for e in events if e["kind"] == "error"]), 1)


class ServerErrorTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_server_error_says_what_the_usual_cause_is(self):
        live = Live(new_conversation(), stream(before_submission(LIVE) + [("response.failed", FAILED)]))

        with self.assertLogs("ahm-demo", level="WARNING") as logged:
            task, events, _ = await live.run()

        (error,) = [event for event in events if event["kind"] == "error"]
        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "agent_failed"))
        self.assertEqual(task["error"]["message"], activity.SERVER_ERROR_MESSAGE)
        self.assertIn("internal error", task["error"]["message"])
        self.assertIn("busy model deployment", task["error"]["message"])
        self.assertEqual(error["payload"], {"code": "server_error", "message": activity.SERVER_ERROR_MESSAGE})
        self.assertIn(UPSTREAM_ERROR, "\n".join(logged.output))
        self.assertEqual(live.wire.paths(), [("POST", "conversations"), ("POST", "responses")])


class BusyDeploymentTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_failure_before_any_event_is_retried_on_the_same_conversation_with_the_same_input(self):
        def busy():
            return stream(LIVE[:2] + [("response.failed", FAILED)])

        cases = [
            ("busy once", [busy, lambda: stream(LIVE)], "done", 2),
            ("busy three times", [busy, busy, busy, lambda: stream(LIVE)], "done", 4),
            ("busy four times", [busy, busy, busy, busy], "failed", 4),
        ]
        for label, answers, status, requests in cases:
            with self.subTest(label=label):
                live = Live(new_conversation(), *[answer() for answer in answers])

                with mock.patch.object(task_runner, "BUSY_RETRY_SECONDS", (0, 0, 0)), self.assertLogs("ahm-demo", level="WARNING"):
                    task, events, _ = await live.run()

                self.assertEqual(task["status"], status, task.get("error"))
                self.assertEqual(live.wire.paths(), [("POST", "conversations")] + [("POST", "responses")] * requests)
                bodies = [json.loads(request.content) for request in live.wire.requests[1:]]
                self.assertEqual(len({(body["conversation"], body["input"]) for body in bodies}), 1)
                waits = [e for e in events if e["summary"] == "The assistant is busy, trying again"]
                self.assertEqual(len(waits), requests - 1 if status == "done" else 3)
                errors = [e for e in events if e["kind"] == "error"]
                if status == "done":
                    self.assertEqual((errors, task["result"]), ([], EXPLAIN_RESULT))
                else:
                    self.assertEqual(task["error"], {"code": "agent_failed", "message": activity.SERVER_ERROR_MESSAGE})
                    self.assertEqual(len(errors), 1)


class ConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_deleted_conversation_is_replaced_once_and_the_run_retried(self):
        live = Live(missing(), new_conversation(), stream(LIVE), conversation=OLD_CONVERSATION)

        task, events, session = await live.run()

        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual(session["conversationId"], NEW_CONVERSATION)
        self.assertEqual(live.wire.paths(), [("POST", "responses"), ("POST", "conversations"), ("POST", "responses")])
        self.assertEqual([json.loads(r.content).get("conversation") for r in live.wire.requests if r.url.path.endswith("responses")], [OLD_CONVERSATION, NEW_CONVERSATION])
        self.assertEqual([e["summary"] for e in events].count("Conversation expired; started a new one"), 1)

    async def test_a_conversation_that_is_missing_again_fails_the_task(self):
        live = Live(missing(), new_conversation(), missing(), conversation=OLD_CONVERSATION)

        task, _, _ = await live.run()

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "conversation_lost"))
        self.assertEqual(len(live.wire.requests), 3)

    async def test_a_missing_conversation_reported_inside_the_stream_is_recognised_too(self):
        failure = {"type": "response.failed", "response": {"id": "caresp_live1", "status": "failed", "error": {"code": "not_found", "message": MISSING["error"]["message"]}}}
        live = Live(stream([("response.created", LIVE[0][1]), ("response.failed", failure)]), new_conversation(), stream(LIVE), conversation=OLD_CONVERSATION)

        task, _, session = await live.run()

        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual(session["conversationId"], NEW_CONVERSATION)
        self.assertEqual(len(live.wire.requests), 3)


class TimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_request_that_gets_no_answer_is_sent_once_more(self):
        for label, error in [("a timeout", httpx.ReadTimeout("no first byte")), ("a reset", httpx.ReadError("connection reset")), ("no connection", httpx.ConnectTimeout("no connect"))]:
            with self.subTest(label=label):
                live = Live(new_conversation(), error, stream(LIVE))

                with self.assertLogs("ahm-demo", level="WARNING"):
                    task, _, _ = await live.run()

                self.assertEqual(task["status"], "done", task.get("error"))
                self.assertEqual(live.wire.paths(), [("POST", "conversations"), ("POST", "responses"), ("POST", "responses")])

    async def test_a_request_is_never_repeated_once_events_arrived(self):
        live = Live(new_conversation(), cut(LIVE[:6]))

        task, events, _ = await live.run()

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "agent_unreachable"))
        self.assertEqual(live.wire.paths(), [("POST", "conversations"), ("POST", "responses")])
        self.assertIn("Agent started", [event["summary"] for event in events])

    async def test_two_failures_before_any_event_fail_the_task(self):
        live = Live(new_conversation(), httpx.ReadTimeout("one"), httpx.ReadTimeout("two"))

        with self.assertLogs("ahm-demo", level="WARNING"):
            task, _, _ = await live.run()

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "agent_unreachable"))
        self.assertEqual(len(live.wire.requests), 3)


if __name__ == "__main__":
    unittest.main()
