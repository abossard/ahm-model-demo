import logging
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_framework import (
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    ChatResponseUpdate,
    Content,
    FunctionInvocationLayer,
    Message,
    ResponseStream,
    tool,
)
from agent_framework_foundry_hosting import ResponsesHostServer
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

from agent import FUNCTION_INVOCATION_CONFIGURATION, KEPT_RESULTS, build_agent, forget_reads

SKILLS_DIR = Path(__file__).parents[1] / "skills"

DIFF = {
    "kind": "diff",
    "summary": "Adds a signal definition.",
    "changes": [
        {
            "id": "c1",
            "op": "add",
            "kind": "signalDefinition",
            "name": "http-5xx",
            "after": {
                "signalKind": "AzureResourceMetric",
                "metricNamespace": "Microsoft.Web/sites",
                "metricName": "Http5xx",
                "aggregationType": "Total",
                "timeGrain": "PT5M",
                "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 20}},
            },
            "reason": "Failures are not covered.",
        },
        {
            "id": "c2",
            "op": "add",
            "kind": "entity",
            "name": "storefront",
            "after": {"displayName": "Storefront"},
            "reason": "The workload needs a front.",
        },
        {
            "id": "c3",
            "op": "add",
            "kind": "entity",
            "name": "storefront-api",
            "after": {"displayName": "Storefront API"},
            "reason": "The front needs its API.",
        },
        {
            "id": "c4",
            "op": "add",
            "kind": "relationship",
            "name": "storefront-storefront-api",
            "after": {"parentEntityName": "storefront", "childEntityName": "storefront-api"},
            "reason": "The API serves the front.",
        },
    ],
    "verification": [],
    "findings": [{"severity": "low", "entity": None, "text": "Failures are not covered.", "changeIds": ["c1"]}],
}


RELATIONSHIPS = [{"name": "r-root-checkout", "parent": "hm", "child": "checkout"}]


def envelope(task_id, task_type="design", entity=None):
    task = {
        "id": task_id,
        "type": task_type,
        "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": "hm", **({"entity": entity} if entity else {})},
        "workload": None,
        "instruction": "",
    }
    body = {"task": task} if task_type == "explain" else {"task": task, "relationships": RELATIONSHIPS}
    return f"Run this task.\n{json.dumps(body)}"


def call(name, **arguments):
    return Content.from_function_call(f"call-{name}", name, arguments=json.dumps(arguments))


def results_of(messages):
    return [content.result for message in messages for content in message.contents or [] if content.type == "function_result"]


def streamed_in_parts(contents):
    """What the Responses client yields for a call: an empty start, the arguments in two parts, then all of them again."""
    updates = []
    for content in contents:
        if content.type != "function_call":
            updates.append([content])
            continue
        text, middle = content.arguments, len(content.arguments) // 2
        for arguments, merge_mode in (("", "append"), (text[:middle], "append"), (text[middle:], "append"), (text, "replace")):
            updates.append([Content.from_function_call(content.call_id, content.name, arguments=arguments, merge_mode=merge_mode)])
    return updates


class ScriptedClient(FunctionInvocationLayer, ChatMiddlewareLayer, BaseChatClient):
    """Answers each model call with the next scripted step; a step may inspect what the model was given."""

    def __init__(self, steps, in_parts=False):
        super().__init__(function_invocation_configuration=FUNCTION_INVOCATION_CONFIGURATION)
        self.steps = list(steps)
        self.in_parts = in_parts
        self.model_calls = 0
        self.tool_names = []
        self.instructions = ""
        self.seen = []
        self.choices = []

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        self.model_calls += 1
        self.seen.append(list(messages))
        self.tool_names = [tool.name for tool in options.get("tools", [])]
        self.instructions = options.get("instructions") or ""
        self.choices.append(options.get("tool_choice"))
        step = self.steps.pop(0)
        contents = step(messages) if callable(step) else step

        if not stream:

            async def _response():
                return ChatResponse(messages=[Message(role="assistant", contents=contents)])

            return _response()

        async def _stream():
            for part in streamed_in_parts(contents) if self.in_parts else [contents]:
                yield ChatResponseUpdate(role="assistant", contents=part)

        return ResponseStream(_stream(), finalizer=lambda updates: ChatResponse.from_updates(updates))


class AgentRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = Path(self.directory.name)

    async def run_agent(self, texts, steps, tools=()):
        client = ScriptedClient(steps)
        agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=self.workspace, tools=tools)
        messages = [Message(role="user", contents=[Content.from_text(text)]) for text in texts]
        response = await agent.run(messages)
        return client, response

    async def test_a_task_leads_to_submit_result_and_the_result_file(self):
        client, response = await self.run_agent([envelope("t-7")], [[call("submit_result", result=DIFF)]])

        self.assertEqual(response.text, "")
        self.assertEqual(client.model_calls, 1)
        self.assertEqual(json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8")), DIFF)
        self.assertEqual([json.loads(r) for r in results_of(response.messages)], [{"status": "accepted"}])

    async def test_the_model_sees_the_task_tools_the_skill_tools_and_the_instructions(self):
        client, _ = await self.run_agent([envelope("t-7")], [[Content.from_text("Nothing to do.")]])

        for name in ("run_shell", "submit_result", "load_skill", "read_skill_resource"):
            with self.subTest(name):
                self.assertIn(name, client.tool_names)
        for text in ("healthmodel-plan", "healthmodel-analyze", "healthmodel-build", "submit_result"):
            with self.subTest(text):
                self.assertIn(text, client.instructions)

    async def test_a_rejected_result_is_fixed_and_submitted_again(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}

        def fixed(messages):
            rejection = json.loads(results_of(messages)[-1])
            self.assertEqual(rejection["status"], "rejected")
            self.assertIn("result: 'summary' is a required property (add it)", rejection["problems"])
            return [call("submit_result", result=DIFF)]

        client, response = await self.run_agent(
            [envelope("t-7")], [[call("submit_result", result=broken)], fixed]
        )

        self.assertEqual(client.model_calls, 2)
        self.assertEqual(json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8")), DIFF)

    async def test_verification_rows_wait_for_a_query_that_returned(self):
        verified = {
            **DIFF,
            "verification": [{"entity": "storefront-api", "signal": "http-5xx", "status": "verified", "query": "q", "value": 1, "error": None}],
        }

        def metrics_query(works):
            @tool(name="monitor_metrics_query", approval_mode="never_require")
            def monitor_metrics_query(resource: str) -> str:
                if not works:
                    raise RuntimeError("resource not found")
                return '{"status":200}'

            return monitor_metrics_query

        for label, works, final_status in (("query returns", True, "accepted"), ("query fails", False, "rejected")):
            with self.subTest(label):
                steps = [
                    [call("submit_result", result=verified)],
                    [call("monitor_metrics_query", resource="r")],
                    [call("submit_result", result=verified)],
                    [Content.from_text("Done.")],
                ]

                _, response = await self.run_agent([envelope("t-7")], steps, tools=[metrics_query(works)])

                results = results_of(response.messages)
                self.assertEqual(json.loads(results[0])["status"], "rejected")
                self.assertIn("no metrics or log query ran", json.loads(results[0])["problems"][0])
                self.assertEqual(json.loads(results[2])["status"], final_status)

    async def test_an_entity_change_needs_a_read_and_a_difference(self):
        current = {"displayName": "Storefront API", "impact": "Standard"}

        def change(display_name):
            return {
                **DIFF,
                "changes": [
                    {
                        "id": "c1",
                        "op": "change",
                        "kind": "entity",
                        "name": "storefront-api",
                        "after": {**current, "displayName": display_name},
                        "reason": "Renames it.",
                    }
                ],
                "findings": [],
            }

        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            entities = [{"entity": {"name": name, "properties": current}} for name in ("hm", "storefront-api")]
            return json.dumps({"results": {"entities": entities}})

        steps = [
            [call("submit_result", result=change("Storefront"))],
            [call("monitor_healthmodels_inspect", health_model="hm")],
            [call("submit_result", result=change("Storefront API"))],
            [call("submit_result", result=change("Storefront API"))],
            [call("submit_result", result=change("Storefront"))],
            [Content.from_text("Done.")],
        ]

        _, response = await self.run_agent([envelope("t-7")], steps, tools=[monitor_healthmodels_inspect])

        answers = [json.loads(result) for result in results_of(response.messages) if result.startswith('{"status"')]
        self.assertEqual([answer["status"] for answer in answers], ["rejected", "rejected", "rejected", "accepted"])
        self.assertIn("was not read in this Task", answers[0]["problems"][0])
        self.assertIn("is the same as in the model", answers[1]["problems"][0])
        self.assertIn("Same problems as your previous submit", answers[2]["problems"][0])
        self.assertIn("is the same as in the model", answers[2]["problems"][1])

    async def test_a_task_reads_what_it_judges_whatever_earlier_tasks_showed(self):
        def inspect(*names):
            @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
            def monitor_healthmodels_inspect(health_model: str) -> str:
                entities = [{"entity": {"name": name, "properties": {"displayName": name}}} for name in names]
                return json.dumps({"results": {"entities": entities}})

            return monitor_healthmodels_inspect

        explained = {"kind": "explain", "entity": "checkout", "state": "Healthy", "summary": "Fine.", "causes": []}
        cases = [
            ("review of two entities, one read", envelope("t-1", "review"), DIFF, inspect("hm"), "review: 1 of the model's 2 entities were not read in this Task (for example checkout)"),
            ("review of two entities, both read", envelope("t-1", "review"), DIFF, inspect("hm", "checkout"), None),
            ("explain, entity not read", envelope("t-1", "explain", "checkout"), explained, inspect("hm"), "explain: entity 'checkout' was not read in this Task"),
            ("explain, entity read", envelope("t-1", "explain", "checkout"), explained, inspect("checkout"), None),
            ("design reads nothing", envelope("t-1", "design"), DIFF, inspect("hm"), None),
        ]
        for label, text, result, reader, rejection in cases:
            with self.subTest(label):
                steps = [[call("submit_result", result=result)], [call("monitor_healthmodels_inspect", health_model="hm")], [call("submit_result", result=result)], [Content.from_text("Done.")]]
                if rejection is None:
                    steps = [[call("monitor_healthmodels_inspect", health_model="hm")], [call("submit_result", result=result)], [Content.from_text("Done.")]]

                _, response = await self.run_agent([text], steps, tools=[reader])

                answers = [json.loads(r) for r in results_of(response.messages) if r.startswith('{"status"')]
                if rejection is None:
                    self.assertEqual(answers, [{"status": "accepted"}])
                else:
                    self.assertEqual([a["status"] for a in answers], ["rejected", "rejected"])
                    self.assertTrue(any(rejection in problem for problem in answers[-1]["problems"]), answers[-1]["problems"])

    async def test_a_read_that_a_fields_filter_left_without_names_still_counts(self):
        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str, entity: str = "", walk: str = "") -> str:
            item = {"path": entity} if walk else {}
            return json.dumps({"results": {"entities": [{**item, "entity": {"properties": {"displayName": "Checkout"}}}]}})

        explained = {"kind": "explain", "entity": "checkout", "state": "Healthy", "summary": "Fine.", "causes": []}
        for label, arguments in (("the call's entity", {"entity": "checkout"}), ("the walk path", {"entity": "checkout", "walk": "Causes"})):
            with self.subTest(label):
                steps = [[call("monitor_healthmodels_inspect", health_model="hm", **arguments)], [call("submit_result", result=explained)]]

                _, response = await self.run_agent([envelope("t-1", "explain", "checkout")], steps, tools=[monitor_healthmodels_inspect])

                answers = [json.loads(r) for r in results_of(response.messages) if r.startswith('{"status"')]
                self.assertEqual(answers, [{"status": "accepted"}])

    async def test_every_model_call_must_call_a_tool_so_that_an_answer_in_words_cannot_end_the_run(self):
        rejected = {key: value for key, value in DIFF.items() if key != "summary"}
        client, _ = await self.run_agent(
            [envelope("t-7")],
            [[call("run_shell", command="true")], [call("submit_result", result=rejected)], [call("submit_result", result=DIFF)]],
        )

        self.assertEqual(client.choices, ["required"] * 3)

    async def test_a_result_must_answer_the_task_of_the_latest_message(self):
        explained = {"kind": "explain", "entity": "checkout", "state": "Healthy", "summary": "Fine.", "causes": []}
        steps = [[call("submit_result", result=explained)], [call("submit_result", result=DIFF)]]

        _, response = await self.run_agent([envelope("t-1", "explain", "checkout"), "Done.", envelope("t-2", "design")], steps)

        answers = [json.loads(r) for r in results_of(response.messages) if r.startswith('{"status"')]
        self.assertEqual([a["status"] for a in answers], ["rejected", "accepted"])
        self.assertIn("this Task is a design: submit a result of kind `diff`", answers[0]["problems"][0])

    async def test_tool_errors_reach_the_model_with_their_cause(self):
        seen = []

        def after_error(messages):
            seen.extend(results_of(messages))
            return [Content.from_text("Giving up.")]

        await self.run_agent(
            [envelope("t-7")],
            [[call("submit_result", result="not an object"), call("run_shell", command="true", timeout_seconds="soon")], after_error],
        )

        self.assertEqual(len(seen), 2)
        for result in seen:
            with self.subTest(result[:60]):
                self.assertTrue(result.startswith("Error: Argument parsing failed. Exception:"), result)
        self.assertIn("result", seen[0])
        self.assertIn("timeout_seconds", seen[1])

    async def test_shell_and_result_use_the_folder_of_the_latest_task(self):
        cases = [
            ("two tasks", [envelope("t-1"), "Done.", envelope("t-2")], "t-2"),
            ("one task", [envelope("t-1")], "t-1"),
            ("no task", ["hello"], "adhoc"),
        ]
        for label, texts, folder in cases:
            with self.subTest(label):
                client, response = await self.run_agent(
                    texts,
                    [[call("run_shell", command="pwd")], [call("submit_result", result=DIFF)], [Content.from_text("Done.")]],
                )

                shell_output, submission = results_of(response.messages)
                self.assertEqual(Path(shell_output.splitlines()[1]).resolve(), (self.workspace / "tasks" / folder).resolve())
                self.assertEqual(submission, '{"status":"accepted"}')
                self.assertTrue((self.workspace / "tasks" / folder / "result.json").is_file())

    async def test_skills_load_without_approval_and_expose_their_templates(self):
        steps = [
            [
                call("load_skill", skill_name="healthmodel-plan"),
                call("load_skill", skill_name="healthmodel-analyze"),
                call("load_skill", skill_name="healthmodel-build"),
            ],
            [
                call("read_skill_resource", skill_name="healthmodel-build", resource_name="templates/main.bicep"),
                call("read_skill_resource", skill_name="healthmodel-plan", resource_name="templates/modelspec.md"),
                call("read_skill_resource", skill_name="healthmodel-plan", resource_name="templates/plan.md"),
            ],
            [Content.from_text("Loaded.")],
        ]

        client, response = await self.run_agent([envelope("t-7", "design")], steps)

        results = [str(result) for result in results_of(response.messages)]
        self.assertEqual(client.model_calls, 3)
        self.assertEqual(len(results), 6)
        for index, expected in enumerate(
            ["# Health model plan", "# Analyze a health model", "# Build a health model", "Starter health model", "modelspec", "plan"]
        ):
            with self.subTest(index):
                self.assertIn(expected, results[index])
        self.assertIn("<available_resources>", results[2])
        self.assertIn("templates/main.bicep", results[2])
        approvals = [c for m in response.messages for c in m.contents or [] if c.type == "function_approval_request"]
        self.assertEqual(approvals, [])


def traffic(messages):
    """Function calls and results in the messages, as (kind, call id)."""
    return [(content.type, content.call_id) for message in messages for content in message.contents or [] if content.type in ("function_call", "function_result")]


class ForgetReadsTests(unittest.TestCase):
    def test_earlier_tasks_keep_their_messages_and_last_results_only(self):
        def message(role, *contents):
            return Message(role=role, contents=list(contents))

        def task(number, read=True):
            call_id = f"submit-{number}"
            messages = [message("user", Content.from_text(f"Task {number}"))]
            if read:
                messages += [
                    message("assistant", Content.from_text_reasoning(text="thinking"), Content.from_function_call(f"read-{number}", "monitor_healthmodels_inspect", arguments="{}")),
                    message("tool", Content.from_function_result(f"read-{number}", result="big output")),
                ]
            messages += [
                message("assistant", Content.from_function_call(call_id, "submit_result", arguments="{}")),
                message("tool", Content.from_function_result(call_id, result='{"status":"accepted"}')),
                message("assistant", Content.from_text(f"Done {number}.")),
            ]
            return messages

        cases = [
            ("a single task is left alone", task(1), [("function_call", "read-1"), ("function_result", "read-1"), ("function_call", "submit-1"), ("function_result", "submit-1")]),
            ("an earlier task loses its reads", task(1) + task(2)[:1], [("function_call", "submit-1"), ("function_result", "submit-1")]),
            ("the running task keeps its reads", task(1) + task(2, read=True)[:3], [("function_call", "submit-1"), ("function_result", "submit-1"), ("function_call", "read-2"), ("function_result", "read-2")]),
        ]
        for label, messages, expected in cases:
            with self.subTest(label):
                self.assertEqual(traffic(forget_reads(messages)), expected)

        earlier = KEPT_RESULTS + 2
        many = [m for number in range(1, earlier + 1) for m in task(number)] + task(earlier + 1)[:1]
        kept = [call_id for kind, call_id in traffic(forget_reads(many)) if kind == "function_call"]
        self.assertEqual(kept, [f"submit-{number}" for number in range(earlier - KEPT_RESULTS + 1, earlier + 1)])

        texts = [m.text for m in forget_reads(task(1) + task(2)[:1]) if m.text]
        self.assertEqual(texts, ["Task 1", "Done 1.", "Task 2"])
        self.assertEqual([c.type for m in forget_reads(task(1) + task(2)[:1]) for c in m.contents if c.type == "text_reasoning"], [])
        original = task(1) + task(2)[:1]
        forget_reads(original)
        self.assertEqual(len(traffic(original)), 4)


class EarlierModelsTests(unittest.TestCase):
    def test_only_results_about_the_model_of_this_task_stay(self):
        def task(task_id, model, call_id):
            body = {"task": {"id": task_id, "type": "review", "target": {"name": model}}}
            return [
                Message(role="user", contents=[Content.from_text(f"Run this.\n{json.dumps(body)}")]),
                Message(role="assistant", contents=[Content.from_function_call(call_id, "submit_result", arguments="{}")]),
                Message(role="tool", contents=[Content.from_function_result(call_id, result='{"status":"accepted"}')]),
            ]

        def kept(messages):
            return [call_id for kind, call_id in traffic(forget_reads(messages)) if kind == "function_call"]

        cases = [
            ("the same model", task("1", "hm", "s1") + task("2", "hm", "s2")[:1], ["s1"]),
            ("another model", task("1", "hm-design", "s1") + task("2", "hm", "s2")[:1], []),
            ("a mixture", task("1", "hm", "s1") + task("2", "hm-design", "s2") + task("3", "HM", "s3") + task("4", "hm", "s4")[:1], ["s1", "s3"]),
            ("the model in another case", task("1", "HM", "s1") + task("2", "hm", "s2")[:1], ["s1"]),
            ("a latest message that is no task", task("1", "hm", "s1") + [Message(role="user", contents=[Content.from_text("thanks")])], ["s1"]),
            ("an earlier message that is no task", [Message(role="user", contents=[Content.from_text("hello")])] + task("1", "hm", "s1")[1:] + task("2", "hm", "s2")[:1], []),
        ]
        for label, messages, expected in cases:
            with self.subTest(label):
                self.assertEqual(kept(messages), expected)


class HostedStreamTests(unittest.TestCase):
    @mock.patch.dict(os.environ, {"OTEL_SDK_DISABLED": "true"})
    def test_a_streamed_call_reaches_the_client_with_its_arguments_once(self):
        for label, in_parts in (("in parts, then whole", True), ("whole", False)):
            with self.subTest(label), tempfile.TemporaryDirectory() as workspace:
                verified = {
                    **DIFF,
                    "verification": [{"entity": "storefront-api", "signal": "http-5xx", "status": "verified", "query": "q", "value": 1, "error": None}],
                }

                @tool(name="monitor_metrics_query", approval_mode="never_require")
                def monitor_metrics_query(resource: str) -> str:
                    return '{"status":200}'

                client = ScriptedClient(
                    [[call("monitor_metrics_query", resource="r")], [call("submit_result", result=verified)], [Content.from_text("Done.")]],
                    in_parts=in_parts,
                )
                agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=Path(workspace), tools=[monitor_metrics_query])
                body = {"input": envelope("t-7"), "store": False, "stream": True}

                with TestClient(ResponsesHostServer(agent)) as http, http.stream("POST", "/responses", json=body) as response:
                    events = [json.loads(line[5:]) for line in response.iter_lines() if line.startswith("data:")]

                items = [event["item"] for event in events if event["type"] == "response.output_item.done"]
                calls = [json.loads(item["arguments"]) for item in items if item["type"] == "function_call"]
                outputs = [item["output"] for item in items if item["type"] == "function_call_output"]
                self.assertEqual(events[-1]["type"], "response.completed")
                self.assertEqual(events[-1]["response"]["status"], "completed")
                self.assertEqual(calls, [{"resource": "r"}, {"result": verified}])
                self.assertEqual(len(outputs), 2)
                self.assertEqual(outputs[1], '{"status":"accepted"}')


    def test_a_follow_up_in_the_conversation_sees_earlier_results_but_not_their_reads(self):
        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            return "a very large reading"

        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as state:
            with mock.patch.dict(os.environ, {"OTEL_SDK_DISABLED": "true", "AGENTSERVER_STATE_ROOT": state}):
                client = ScriptedClient(
                    [
                        [call("monitor_healthmodels_inspect", health_model="hm")],
                        [call("submit_result", result=DIFF)],
                        [Content.from_text("Cannot do the second Task.")],
                    ]
                )
                agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=Path(workspace), tools=[monitor_healthmodels_inspect])
                with TestClient(ResponsesHostServer(agent)) as http:
                    first = http.post("/responses", json={"input": envelope("t-1"), "store": True}).json()
                    second = http.post("/responses", json={"input": envelope("t-2"), "store": True, "previous_response_id": first["id"]})

        self.assertEqual(second.status_code, 200)
        seen = client.seen[-1]
        self.assertEqual([c for m in seen for c in [m.text] if c], [envelope("t-1"), envelope("t-2")])
        self.assertEqual(traffic(seen), [("function_call", "call-submit_result"), ("function_result", "call-submit_result")])


if __name__ == "__main__":
    unittest.main()
