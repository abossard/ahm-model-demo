import logging
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from agent_framework import (
    BaseChatClient,
    FunctionTool,
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

from agent import FUNCTION_INVOCATION_CONFIGURATION, KEPT_RESULTS, MODEL_CALLS, MODEL_SECONDS, TaskSettings, build_agent, forget_reads, task_settings, visible_tools
from contracts import validate_task_result
from tools import MAX_IDLE

SKILLS_DIR = Path(__file__).parents[1] / "skills"

DIFF = {
    "kind": "diff",
    "summary": "Removes a signal definition nothing uses.",
    "changes": [
        {"id": "c1", "op": "remove", "kind": "signalDefinition", "name": "legacy-5xx", "after": None, "reason": "Nothing uses it any more."}
    ],
    "verification": [],
    "findings": [{"severity": "low", "entity": None, "text": "The definition was unused.", "changeIds": ["c1"]}],
}

RESOURCE_ID = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/ca-web"
LISTED = json.dumps(
    {
        "status": 200,
        "message": "Success",
        "results": {"resources": [{"name": "ca-web", "id": RESOURCE_ID, "type": "Microsoft.App/containerApps", "location": "swedencentral"}]},
    }
)
DESIGN = {
    "kind": "diff",
    "summary": "One flow over the web app. Flows are inferred from infrastructure only.",
    "changes": [
        {
            "id": "c1",
            "op": "add",
            "kind": "entity",
            "name": "use-web-app",
            "after": {"displayName": "Use the web app", "icon": {"iconName": "UserFlow"}},
            "reason": "Users reach the service through the container app ca-web.",
        },
        {
            "id": "c2",
            "op": "add",
            "kind": "entity",
            "name": "web-app",
            "after": {
                "displayName": "Web app",
                "signalGroups": {"azureResource": {"authenticationSetting": "auth-system", "azureResourceId": RESOURCE_ID, "signals": []}},
            },
            "reason": "The container app serves it.",
        },
        {
            "id": "c3",
            "op": "add",
            "kind": "relationship",
            "name": "hm-demo-use-web-app",
            "after": {"parentEntityName": "hm-demo", "childEntityName": "use-web-app"},
            "reason": "The flow hangs off the root.",
        },
        {
            "id": "c4",
            "op": "add",
            "kind": "relationship",
            "name": "use-web-app-web-app",
            "after": {"parentEntityName": "use-web-app", "childEntityName": "web-app"},
            "reason": "The app serves the flow.",
        },
    ],
    "verification": [],
    "findings": [{"severity": "low", "entity": None, "text": "The flow comes from the resources only.", "changeIds": ["c1"]}],
}


@tool(name="group_resource_list", approval_mode="never_require")
def group_resource_list(resource_group: str = "rg") -> str:
    return LISTED


RELATIONSHIPS = [{"name": "r-root-checkout", "parent": "hm", "child": "checkout"}]


def envelope(task_id, task_type="design", entity=None, model="hm", instruction=""):
    task = {
        "id": task_id,
        "type": task_type,
        "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": model, **({"entity": entity} if entity else {})},
        "workload": None,
        "instruction": instruction,
    }
    body = {"task": task} if task_type == "explain" else {"task": task, "relationships": RELATIONSHIPS}
    return f"Run this task.\n{json.dumps(body)}"


AZURE_ARGUMENTS = ("subscription", "resource-group", "health-model", "entity", "include", "walk", "start-at", "end-at", "workspace", "resource")
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
INSPECTED = json.dumps({"results": {"entities": [{"entity": {"name": "checkout", "properties": {"healthState": "Healthy"}}}]}})


def azure_tool(name, seen, answer="{}"):
    """A stand-in for a tool of the Azure MCP server: names in kebab-case like the server's, and a record of what arrives."""

    async def run(**arguments):
        seen.append(arguments)
        return answer

    schema = {"type": "object", "properties": {key: {"type": ["string", "array", "number"]} for key in AZURE_ARGUMENTS}, "additionalProperties": False}
    return FunctionTool(name=name, description=name, func=run, approval_mode="never_require", input_model=schema)


def explained(**extra):
    return {"kind": "explain", "entity": "checkout", "state": "Healthy", "summary": "Checkout is healthy and nothing drives its state.", "causes": [], **extra}


def submissions(messages):
    """The answers of submit_result in the messages: accepted or rejected."""
    answers = [json.loads(result) for result in results_of(messages) if isinstance(result, str) and result.startswith("{")]
    return [answer for answer in answers if answer.get("status") in ("accepted", "rejected")]


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
        self.options = []

    def _inner_get_response(self, *, messages, stream, options, **kwargs):
        self.model_calls += 1
        self.seen.append(list(messages))
        self.tool_names = [tool.name for tool in options.get("tools", [])]
        self.instructions = options.get("instructions") or ""
        self.choices.append(options.get("tool_choice"))
        self.options.append({key: value for key, value in options.items() if key != "tools"})
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

    async def run_agent(self, texts, steps, tools=(), **settings):
        client = ScriptedClient(steps)
        agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=self.workspace, tools=tools, **settings)
        messages = [Message(role="user", contents=[Content.from_text(text)]) for text in texts]
        response = await agent.run(messages)
        return client, response

    async def test_a_task_leads_to_submit_result_and_the_result_file(self):
        client, response = await self.run_agent([envelope("t-7")], [[call("submit_result", result=DIFF)]])

        self.assertEqual(response.text, "")
        self.assertEqual(client.model_calls, 1)
        self.assertEqual(json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8")), DIFF)
        self.assertEqual([json.loads(r) for r in results_of(response.messages)], [{"status": "accepted"}])

    async def test_the_model_sees_the_tools_the_skill_and_the_instructions_of_its_task_type(self):
        cases = [
            ("explain", ["submit_result", "load_skill"], ["run_shell", "clone_repository", "read_skill_resource", "run_skill_script"], ["Explain", "healthmodel-analyze"]),
            ("review", ["submit_result", "load_skill"], ["run_shell", "clone_repository", "read_skill_resource", "run_skill_script"], ["Review", "healthmodel-design-rules"]),
            ("design", ["submit_result", "load_skill", "run_shell", "clone_repository"], ["read_skill_resource", "run_skill_script"], ["Design", "healthmodel-plan", "healthmodel-design-rules"]),
        ]
        for task_type, offered, hidden, texts in cases:
            with self.subTest(task_type):
                client, _ = await self.run_agent([envelope("t-7", task_type, "checkout")], [[Content.from_text("Nothing to do.")]])

                for name in offered:
                    self.assertIn(name, client.tool_names)
                for name in hidden:
                    self.assertNotIn(name, client.tool_names)
                for text in ["You answer questions about Azure Monitor health models", "submit_result", *texts]:
                    self.assertIn(text, client.instructions)
                for other in {"Explain", "Review", "Design"} - {texts[0]}:
                    self.assertNotIn(f"## {other}", client.instructions)

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
        current = {"displayName": "Web API", "impact": "Standard"}

        def change(display_name):
            return {
                **DIFF,
                "changes": [
                    {
                        "id": "c1",
                        "op": "change",
                        "kind": "entity",
                        "name": "web-api",
                        "after": {**current, "displayName": display_name},
                        "reason": "Renames it.",
                    }
                ],
                "findings": [],
            }

        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            entities = [{"entity": {"name": name, "properties": current}} for name in ("hm", "web-api")]
            return json.dumps({"results": {"entities": entities}})

        steps = [
            [call("submit_result", result=change("Web"))],
            [call("monitor_healthmodels_inspect", health_model="hm")],
            [call("submit_result", result=change("Web API"))],
            [call("submit_result", result=change("Web API"))],
            [call("submit_result", result=change("Web"))],
            [Content.from_text("Done.")],
        ]

        _, response = await self.run_agent([envelope("t-7")], steps, tools=[monitor_healthmodels_inspect])

        answers = [json.loads(result) for result in results_of(response.messages) if result.startswith('{"status"')]
        self.assertEqual([answer["status"] for answer in answers], ["rejected", "rejected", "rejected", "accepted"])
        self.assertIn("was not read in this Task", answers[0]["problems"][0])
        self.assertIn("is the same as in the model", answers[1]["problems"][0])
        self.assertIn("Same problems as your previous submit", answers[2]["problems"][0])
        self.assertIn("The problems sit in c1 (change entity 'web-api')", answers[2]["problems"][1])

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
            ("design reads only the root", envelope("t-1", "design", model="hm-demo"), DESIGN, inspect("hm-demo"), None),
        ]
        for label, text, result, reader, rejection in cases:
            with self.subTest(label):
                steps = [[call("submit_result", result=result)], [call("monitor_healthmodels_inspect", health_model="hm")], [call("submit_result", result=result)], [Content.from_text("Done.")]]
                if rejection is None:
                    steps = [[call("monitor_healthmodels_inspect", health_model="hm")], [call("submit_result", result=result)], [Content.from_text("Done.")]]
                if result is DESIGN:
                    steps.insert(1, [call("group_resource_list", resource_group="rg")])

                _, response = await self.run_agent([text], steps, tools=[reader, group_resource_list])

                answers = [a for a in map(json.loads, filter(lambda r: r.startswith('{"status"'), results_of(response.messages))) if a["status"] in ("accepted", "rejected")]
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

    async def test_a_design_must_rest_on_what_the_run_listed_and_ran(self):
        model = "hm-demo"
        workspace = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/law-demo"
        resources = [
            {"name": "ca-web", "id": RESOURCE_ID, "type": "Microsoft.App/containerApps", "location": "x"},
            {"name": "law-demo", "id": workspace, "type": "Microsoft.OperationalInsights/workspaces", "location": "x"},
        ]
        query = "AppRequests | where Success == false | summarize failedRequests = count()"
        signal = {
            "name": "failed-requests",
            "signalKind": "LogAnalyticsQuery",
            "displayName": "Failed requests",
            "queryText": query,
            "valueColumnName": "failedRequests",
            "timeGrain": "PT5M",
            "refreshInterval": "PT1M",
            "dataUnit": "Count",
            "evaluationRules": {
                "degradedRule": {"operator": "GreaterThan", "threshold": 5},
                "unhealthyRule": {"operator": "GreaterThan", "threshold": 20},
            },
        }
        design = json.loads(json.dumps(DESIGN))
        design["changes"][0]["after"]["signalGroups"] = {
            "azureLogAnalytics": {"authenticationSetting": "auth-system", "logAnalyticsWorkspaceResourceId": workspace, "signals": [signal]}
        }
        shop = {
            **DESIGN,
            "summary": "Assumed the container app is the main path.",
            "changes": [
                {"id": "c1", "op": "add", "kind": "entity", "name": "Browse-products", "after": {"displayName": "Browse products", "icon": {"iconName": "UserFlow"}}, "reason": "Customers browse."},
                {"id": "c2", "op": "add", "kind": "relationship", "name": "hm-demo-browse-products", "after": {"parentEntityName": model, "childEntityName": "Browse-products"}, "reason": "Root."},
            ],
        }

        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            return json.dumps({"results": {"entities": [{"entity": {"name": model, "properties": {"displayName": model}}}]}})

        @tool(name="group_resource_list", approval_mode="never_require")
        def listing(resource_group: str = "rg") -> str:
            return json.dumps({"status": 200, "message": "Success", "results": {"resources": resources}})

        def log_query(works):
            @tool(name="monitor_workspace_log_query", approval_mode="never_require")
            def monitor_workspace_log_query(query: str, table: str = "") -> str:
                if not works:
                    raise RuntimeError("A semantic error occurred: 'cloud_RoleName' is not a column")
                return json.dumps({"status": 200, "results": {"results": [{"failedRequests": "7"}]}})

            return monitor_workspace_log_query

        inspect_and_list = [[call("monitor_healthmodels_inspect", health_model=model)], [call("group_resource_list")]]
        cases = [
            ("the query returns", True, "accepted", None),
            ("the query fails", False, "rejected", "that exact query failed when it ran: check the table's columns first"),
        ]
        for label, works, final, expected in cases:
            with self.subTest(label):
                steps = [
                    *inspect_and_list,
                    [call("submit_result", result=shop)],
                    [call("submit_result", result=design)],
                    [call("monitor_workspace_log_query", query=query, table="AppRequests")],
                    [call("submit_result", result=design)],
                    [Content.from_text("Done.")],
                ]

                _, response = await self.run_agent(
                    [envelope("t-1", "design", model=model)], steps, tools=[monitor_healthmodels_inspect, listing, log_query(works)]
                )

                answers = [a for a in map(json.loads, filter(lambda r: r.startswith('{"status"'), results_of(response.messages))) if a["status"] in ("accepted", "rejected")]
                self.assertEqual([a["status"] for a in answers], ["rejected", "rejected", final])
                first = "\n".join(answers[0]["problems"])
                for text in ("lower-case kebab-case", "examples of the skill templates", "needs at least one resource entity below it", "names no evidence", "inferred from the resources alone"):
                    self.assertIn(text, first)
                self.assertIn("that exact query was not run in this Task", answers[1]["problems"][0])
                if expected:
                    self.assertIn(expected, answers[2]["problems"][0])

    async def test_a_design_for_a_repository_is_grounded_in_its_clone(self):
        model = "hm-demo"
        url = "https://github.com/example/albums"
        with tempfile.TemporaryDirectory() as origin:
            (Path(origin) / "src").mkdir()
            (Path(origin) / "src" / "server.js").write_text("// the products API\n", encoding="utf-8")
            git = Path(origin, "fake-git")
            git.write_text(f'#!/bin/sh\nfor last; do :; done\nmkdir -p "$last/.git"\ncp -R "{origin}/src" "$last/"\n', encoding="utf-8")
            git.chmod(0o755)
            task = json.loads(envelope("t-1", "design", model=model).split("\n", 1)[1])
            task["task"]["workload"] = {"resourceGroup": "rg", "repositoryUrl": url}
            text = f"Design this.\n{json.dumps(task)}"
            design = json.loads(json.dumps(DESIGN))
            design["summary"] = "Flows come from src/server.js."
            design["changes"][0]["name"] = "browse-products"
            design["changes"][0]["reason"] = "The route in src/server.js serves the products."
            design["changes"][2]["name"] = "hm-demo-browse-products"
            design["changes"][2]["after"]["childEntityName"] = "browse-products"
            design["changes"][3]["name"] = "browse-products-web-app"
            design["changes"][3]["after"]["parentEntityName"] = "browse-products"

            @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
            def monitor_healthmodels_inspect(health_model: str) -> str:
                return json.dumps({"results": {"entities": [{"entity": {"name": model, "properties": {"displayName": model}}}]}})

            steps = [
                [call("monitor_healthmodels_inspect", health_model=model)],
                [call("group_resource_list")],
                [call("submit_result", result=design)],
                [call("clone_repository", url=url)],
                [call("submit_result", result=design)],
            ]

            with mock.patch.dict(os.environ, {"CLONE_GIT": str(git)}):
                _, response = await self.run_agent([text], steps, tools=[monitor_healthmodels_inspect, group_resource_list])

        answers = submissions(response.messages)
        self.assertEqual([a["status"] for a in answers], ["rejected", "accepted"])
        self.assertIn(f"workload.repositoryUrl is {url} but no repository was cloned in this Task: call `clone_repository` with it", answers[0]["problems"][-1])
        self.assertIn("Cloned https://github.com/example/albums into albums (1 files).", results_of(response.messages)[3])

    async def test_a_design_that_names_a_repository_the_tool_refuses_goes_on_with_what_the_resources_say(self):
        model = "hm-demo"
        task = json.loads(envelope("t-1", "design", model=model).split("\n", 1)[1])
        task["task"]["workload"] = {"resourceGroup": "rg", "repositoryUrl": "https://dev.azure.com/example/albums"}
        design = json.loads(json.dumps(DESIGN))

        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            return json.dumps({"results": {"entities": [{"entity": {"name": model, "properties": {"displayName": model}}}]}})

        steps = [
            [call("monitor_healthmodels_inspect", health_model=model)],
            [call("group_resource_list")],
            [call("clone_repository", url="https://dev.azure.com/example/albums")],
            [call("submit_result", result=design)],
        ]

        _, response = await self.run_agent([f"Design this.\n{json.dumps(task)}"], steps, tools=[monitor_healthmodels_inspect, group_resource_list])

        self.assertTrue(results_of(response.messages)[2].startswith("Error: refused. Only public repositories at https://github.com/"))
        self.assertEqual(submissions(response.messages), [{"status": "accepted"}])

    async def test_a_model_that_cannot_be_read_ends_with_an_empty_result_instead_of_a_loop(self):
        @tool(name="monitor_healthmodels_inspect", approval_mode="never_require")
        def monitor_healthmodels_inspect(health_model: str) -> str:
            raise ValueError("AuthorizationFailed: the user has no access")

        explained = {"kind": "explain", "entity": "checkout", "state": "Unknown", "summary": "You have no access to the model.", "causes": []}
        steps = [
            [call("monitor_healthmodels_inspect", health_model="hm")],
            [call("submit_result", result=explained)],
            [call("monitor_healthmodels_inspect", health_model="hm")],
            [call("submit_result", result=explained)],
        ]

        _, response = await self.run_agent([envelope("t-1", "explain", "checkout")], steps, tools=[monitor_healthmodels_inspect])

        answers = [json.loads(r)["status"] for r in results_of(response.messages) if r.startswith('{"status"')]
        self.assertEqual(answers, ["rejected", "accepted"])

    async def test_every_model_call_must_call_a_tool_so_that_an_answer_in_words_cannot_end_the_run(self):
        rejected = {key: value for key, value in DIFF.items() if key != "summary"}
        client, _ = await self.run_agent(
            [envelope("t-7")],
            [[call("run_shell", command="true")], [call("submit_result", result=rejected)], [call("submit_result", result=DIFF)]],
        )

        self.assertEqual(client.choices, ["required"] * 3)

    async def test_a_message_that_holds_no_task_is_left_to_the_model(self):
        client, _ = await self.run_agent(["Thanks."], [[Content.from_text("You are welcome.")]])

        self.assertEqual(client.choices, ["auto"])
        self.assertLessEqual({"run_shell", "clone_repository", "submit_result", "load_skill", "read_skill_resource"}, set(client.tool_names))
        for part in ("## Explain", "## Review", "## Design"):
            self.assertNotIn(part, client.instructions)

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

    async def test_skills_load_without_approval_and_only_the_skills_of_the_type_exist(self):
        cases = [
            ("design", ["healthmodel-plan", "healthmodel-design-rules"], ["# Health model plan", "# Rules for the entities and signals you propose"]),
            ("explain", ["healthmodel-analyze", "healthmodel-build"], ["# Analyze a health model", "Error: Skill 'healthmodel-build' not found."]),
        ]
        for task_type, skills, expected in cases:
            with self.subTest(task_type):
                steps = [[call("load_skill", skill_name=skill) for skill in skills], [Content.from_text("Loaded.")]]

                client, response = await self.run_agent([envelope("t-7", task_type, "checkout")], steps)

                results = [str(result) for result in results_of(response.messages)]
                self.assertEqual(client.model_calls, 2)
                for result, text in zip(results, expected, strict=True):
                    self.assertIn(text, result)
                approvals = [c for m in response.messages for c in m.contents or [] if c.type == "function_approval_request"]
                self.assertEqual(approvals, [])


    async def test_a_task_that_never_submits_ends_with_the_agents_own_result_at_its_cap(self):
        steps = [[call("group_resource_list")]] * 3

        client, response = await self.run_agent([envelope("t-7", "explain", "checkout")], steps, tools=[group_resource_list], calls={"explain": 3})

        forced = {"mode": "required", "required_function_name": "submit_result"}
        self.assertEqual((client.model_calls, client.choices), (3, ["required", "required", forced]))
        contents = [content for message in response.messages for content in message.contents or []]
        submitted = [content for content in contents if content.type == "function_call" and content.name == "submit_result"]
        self.assertEqual(len(submitted), 1)
        self.assertTrue(submitted[0].call_id.startswith("forced-"))
        written = json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(submitted[0].arguments), {"result": written})
        self.assertEqual((written["kind"], written["entity"], written["state"], written["causes"]), ("explain", "checkout", "Unknown", []))
        self.assertEqual(written["summary"], "Partial result: the Task used all 3 model calls, so no explanation could be completed.")
        self.assertEqual(results_of(response.messages)[-1], '{"status":"accepted","partial":true}')

    async def test_a_task_that_runs_out_of_seconds_must_submit_and_then_the_agent_submits_for_it(self):
        times = iter([0.0, 10.0, 200.0, 400.0])
        steps = [[call("group_resource_list")]] * 3

        client, response = await self.run_agent(
            [envelope("t-7", "explain", "checkout")], steps, tools=[group_resource_list], seconds={"explain": 240}, timer=lambda: next(times)
        )

        forced = {"mode": "required", "required_function_name": "submit_result"}
        self.assertEqual((client.model_calls, client.choices), (3, ["required", "required", forced]))
        written = json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(written["summary"], "Partial result: the Task used its 4 minutes, so no explanation could be completed.")
        self.assertEqual(results_of(response.messages)[-1], '{"status":"accepted","partial":true}')

    async def test_the_seconds_of_the_task_types_end_before_the_web_app_gives_up(self):
        self.assertEqual(MODEL_SECONDS, {"explain": 240, "review": 360, "design": 420})
        self.assertLess(max(MODEL_SECONDS.values()), 600)

    async def test_the_caps_of_the_task_types_leave_room_for_the_framework_limit(self):
        self.assertEqual(MODEL_CALLS, {"explain": 12, "review": 20, "design": 30})
        self.assertGreater(FUNCTION_INVOCATION_CONFIGURATION["max_iterations"], max(MODEL_CALLS.values()))
        self.assertGreaterEqual(FUNCTION_INVOCATION_CONFIGURATION["max_consecutive_errors_per_request"], FUNCTION_INVOCATION_CONFIGURATION["max_iterations"])

    async def test_a_rejection_that_repeats_ends_with_a_reduced_result_the_agent_submits(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}

        client, response = await self.run_agent([envelope("t-7")], [[call("submit_result", result=broken)]] * 3)

        answers = submissions(response.messages)
        self.assertEqual(client.model_calls, 3)
        self.assertEqual([answer["status"] for answer in answers], ["rejected", "rejected", "rejected", "accepted"])
        self.assertEqual(answers[-1], {"status": "accepted", "partial": True})
        self.assertIn("Same problems as your previous submit", answers[1]["problems"][0])
        self.assertTrue(answers[2]["problems"][0].startswith("Rejected again: the agent now submits a reduced result for you"))
        written = json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8"))
        self.assertTrue(written["summary"].startswith("Partial result: the proposal was rejected 3 times"))
        self.assertEqual(written["changes"], DIFF["changes"])
        self.assertEqual(validate_task_result(written), [])

    async def test_a_model_that_does_not_submit_after_a_rejection_loses_the_call_after_three(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}
        steps = [[call("submit_result", result=broken)], *[[call("group_resource_list")]] * MAX_IDLE]

        client, response = await self.run_agent([envelope("t-7")], steps, tools=[group_resource_list])

        self.assertEqual(client.model_calls, 1 + MAX_IDLE)
        self.assertEqual([answer["status"] for answer in submissions(response.messages)], ["rejected", "accepted"])
        written = json.loads((self.workspace / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8"))
        self.assertTrue(written["summary"].startswith(f"Partial result: the last rejection was not corrected in {MAX_IDLE} model calls"))

    async def test_every_rejection_gives_the_model_three_calls_again(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}
        other = {**broken, "findings": [{"severity": "urgent"}]}
        idle = [[call("group_resource_list")]] * (MAX_IDLE - 1)
        steps = [[call("submit_result", result=broken)], *idle, [call("submit_result", result=other)], *idle, [call("submit_result", result=DIFF)]]

        client, response = await self.run_agent([envelope("t-7")], steps, tools=[group_resource_list])

        self.assertEqual(client.model_calls, 2 * MAX_IDLE + 1)
        self.assertEqual(submissions(response.messages)[-1], {"status": "accepted"})
        self.assertEqual([answer["status"] for answer in submissions(response.messages)], ["rejected", "rejected", "accepted"])

    async def test_a_decision_is_a_rejection_with_an_exit_the_model_can_follow(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}

        _, response = await self.run_agent([envelope("t-7")], [[call("submit_result", result=broken)]] * 2 + [[call("submit_result", result=DIFF)]])

        answers = submissions(response.messages)
        self.assertEqual([answer["status"] for answer in answers], ["rejected", "rejected", "accepted"])
        self.assertEqual(answers[2], {"status": "accepted"})

    async def test_history_is_read_for_a_bounded_window_and_the_result_says_which(self):
        seen = []
        window = {"from": "2026-11-10T12:00:00Z", "to": "2026-11-11T12:00:00Z"}
        read = call(
            "monitor_healthmodels_inspect",
            subscription="s",
            **{"resource-group": "rg", "health-model": "hm", "start-at": "2020-01-01T00:00:00Z"},
            entity="checkout",
            include=["History"],
            walk="Causes",
        )
        steps = [[read], [call("submit_result", result=explained())], [call("submit_result", result=explained(window=window))]]

        _, response = await self.run_agent(
            [envelope("t-7", "explain", "checkout")], steps, tools=[azure_tool("monitor_healthmodels_inspect", seen, INSPECTED)], clock=lambda: NOW
        )

        self.assertEqual(
            seen,
            [{"subscription": "s", "resource-group": "rg", "health-model": "hm", "entity": "checkout", "include": ["History"], **{"start-at": window["from"], "end-at": window["to"]}}],
        )
        answers = submissions(response.messages)
        self.assertEqual([answer["status"] for answer in answers], ["rejected", "accepted"])
        self.assertEqual(
            answers[0]["problems"], [f"window: history was read for this period: set `window` to {window['from']} and {window['to']} as `from` and `to`"]
        )

    async def test_a_window_without_history_is_rejected_and_without_one_the_result_is_accepted(self):
        window = {"from": "2026-11-10T12:00:00Z", "to": "2026-11-11T12:00:00Z"}
        cases = [("a window", explained(window=window), ["rejected", "accepted"]), ("no window", explained(), ["accepted"])]
        for label, result, statuses in cases:
            with self.subTest(label):
                seen = []
                steps = [[call("monitor_healthmodels_inspect", subscription="s", entity="checkout", include=["Signals"])], [call("submit_result", result=result)], [call("submit_result", result=explained())]]

                _, response = await self.run_agent(
                    [envelope("t-7", "explain", "checkout")], steps, tools=[azure_tool("monitor_healthmodels_inspect", seen, INSPECTED)], clock=lambda: NOW
                )

                self.assertEqual(seen[0]["include"], ["Signals"])
                self.assertNotIn("start-at", seen[0])
                self.assertEqual([answer["status"] for answer in submissions(response.messages)], statuses)

    async def test_history_is_refused_where_the_rule_does_not_allow_it_and_longer_when_the_instruction_asks(self):
        cases = [
            ("a review", "review", None, "", {"include": ["History"]}, "History is read only for an Explain Task", None),
            ("another entity", "explain", "checkout", "", {"entity": "orders-db", "include": ["History"]}, "pass `entity` 'checkout' and call again", None),
            ("signal history without a question about the past", "explain", "checkout", "", {"entity": "checkout", "include": ["SignalHistory"]}, "are read only when the instruction asks about the past", None),
            ("signal history of last week", "explain", "checkout", "What changed last week?", {"entity": "checkout", "include": ["SignalHistory"]}, None, "2026-11-04T12:00:00Z"),
        ]
        for label, task_type, entity, instruction, arguments, refusal, start in cases:
            with self.subTest(label):
                seen = []
                steps = [[call("monitor_healthmodels_inspect", subscription="s", **arguments)], [Content.from_text("Done.")]]

                _, response = await self.run_agent(
                    [envelope("t-7", task_type, entity, instruction=instruction)], steps, tools=[azure_tool("monitor_healthmodels_inspect", seen, INSPECTED)], clock=lambda: NOW
                )

                result = [content for message in response.messages for content in message.contents or [] if content.type == "function_result"][0]
                self.assertIsNone(result.exception)
                if refusal:
                    self.assertEqual(seen, [])
                    self.assertTrue(result.result.startswith("Error: refused. "), result.result)
                    self.assertIn(refusal, result.result)
                else:
                    self.assertEqual(seen[0]["start-at"], start)

    async def test_an_azure_call_outside_the_task_is_refused_and_never_reaches_the_tool(self):
        resource = "/subscriptions/s/resourceGroups/other-rg/providers/Microsoft.Web/sites/w"
        cases = [
            ("another subscription", {"subscription": "other"}, "This Task works in subscription s, not other"),
            ("another resource group", {"subscription": "s", "resource-group": "other-rg"}, "This Task reads the resource group rg, not other-rg"),
            ("another health model", {"subscription": "s", "resource-group": "rg", "health-model": "other-hm"}, "This Task is about the health model hm, not other-hm"),
            ("a resource of another group", {"subscription": "s", "resource": resource}, "is outside this Task's subscription and resource groups"),
            ("the task's own, in another case", {"subscription": "S", "resource-group": "RG", "health-model": "HM"}, None),
        ]
        for label, arguments, refusal in cases:
            with self.subTest(label):
                seen = []
                steps = [[call("monitor_healthmodels_get", **arguments)], [Content.from_text("Done.")]]

                _, response = await self.run_agent([envelope("t-7", "review")], steps, tools=[azure_tool("monitor_healthmodels_get", seen, "{}")])

                result = [content for message in response.messages for content in message.contents or [] if content.type == "function_result"][0]
                self.assertIsNone(result.exception)
                if refusal:
                    self.assertEqual(seen, [])
                    self.assertTrue(result.result.startswith("Error: refused. "), result.result)
                    self.assertIn(refusal, result.result)
                else:
                    self.assertEqual(seen, [arguments])

    async def test_the_group_of_a_resource_the_model_uses_may_be_read_once_the_model_was_read(self):
        shared = "/subscriptions/s/resourceGroups/rg-shared/providers/Microsoft.Web/sites/w"
        model = json.dumps({"results": {"entities": [{"entity": {"name": "checkout", "properties": {"signalGroups": {"azureResource": {"azureResourceId": shared}}}}}]}})
        seen, read = [], []
        arguments = {"subscription": "s", "resource-group": "rg-shared"}
        steps = [
            [call("monitor_metrics_query", **arguments)],
            [call("monitor_healthmodels_inspect", subscription="s", entity="checkout")],
            [call("monitor_metrics_query", **arguments)],
            [Content.from_text("Done.")],
        ]
        tools = [azure_tool("monitor_metrics_query", seen), azure_tool("monitor_healthmodels_inspect", read, model)]

        _, response = await self.run_agent([envelope("t-7", "explain", "checkout")], steps, tools=tools)

        results = results_of(response.messages)
        self.assertTrue(results[0].startswith("Error: refused. This Task reads the resource group rg, not rg-shared."))
        self.assertEqual(seen, [arguments])

    async def test_refusals_are_no_errors_so_that_any_number_of_them_does_not_stop_the_run(self):
        seen = []
        steps = [[call("monitor_healthmodels_get", subscription="other")]] * 8 + [[call("submit_result", result=DIFF)]]

        _, response = await self.run_agent([envelope("t-7")], steps, tools=[azure_tool("monitor_healthmodels_get", seen)])

        self.assertEqual(seen, [])
        self.assertEqual(submissions(response.messages), [{"status": "accepted"}])

    async def test_each_task_type_gets_its_own_model_and_reasoning_effort(self):
        settings = {"explain": TaskSettings(effort="low"), "review": TaskSettings("review-deployment", "high"), "design": TaskSettings()}
        cases = [("explain", None, {"effort": "low"}), ("review", "review-deployment", {"effort": "high"}), ("design", None, None)]
        for task_type, model, reasoning in cases:
            with self.subTest(task_type):
                client, _ = await self.run_agent([envelope("t-7", task_type, "checkout")], [[Content.from_text("Nothing.")]], settings=settings)

                self.assertEqual(client.options[0].get("model"), model)
                self.assertEqual(client.options[0].get("reasoning"), reasoning)


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
            ("the same model twice keeps the last result only", task("1", "hm", "s1") + task("2", "hm", "s2") + task("3", "hm", "s3")[:1], ["s2"]),
            ("another model", task("1", "hm-design", "s1") + task("2", "hm", "s2")[:1], []),
            ("a mixture", task("1", "hm", "s1") + task("2", "hm-design", "s2") + task("3", "HM", "s3") + task("4", "hm", "s4")[:1], ["s3"]),
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


    @mock.patch.dict(os.environ, {"OTEL_SDK_DISABLED": "true"})
    def test_the_result_the_agent_submits_for_the_model_reaches_the_client_as_a_call_with_its_arguments(self):
        broken = {key: value for key, value in DIFF.items() if key != "summary"}
        for label, in_parts in (("in parts, then whole", True), ("whole", False)):
            with self.subTest(label), tempfile.TemporaryDirectory() as workspace:
                client = ScriptedClient([[call("submit_result", result=broken)]] * 3, in_parts=in_parts)
                agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=Path(workspace))
                body = {"input": envelope("t-7"), "store": False, "stream": True}

                with TestClient(ResponsesHostServer(agent)) as http, http.stream("POST", "/responses", json=body) as response:
                    events = [json.loads(line[5:]) for line in response.iter_lines() if line.startswith("data:")]

                items = [event["item"] for event in events if event["type"] == "response.output_item.done"]
                calls = [json.loads(item["arguments"]) for item in items if item["type"] == "function_call"]
                outputs = [item["output"] for item in items if item["type"] == "function_call_output"]
                written = json.loads((Path(workspace) / "tasks" / "t-7" / "result.json").read_text(encoding="utf-8"))
                self.assertEqual(client.model_calls, 3)
                self.assertEqual(events[-1]["type"], "response.completed")
                self.assertEqual(events[-1]["response"]["status"], "completed")
                self.assertEqual(calls, [{"result": broken}] * 3 + [{"result": written}])
                self.assertEqual(len(outputs), 4)
                self.assertEqual(outputs[3], '{"status":"accepted","partial":true}')
                self.assertTrue(written["summary"].startswith("Partial result: the proposal was rejected 3 times"))

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


class TaskSettingsTests(unittest.TestCase):
    def test_each_type_works_at_its_effort_only_where_the_model_takes_one(self):
        cases = [
            ("a reasoning deployment", {}, "gpt-54-mini", {"explain": TaskSettings(None, "low"), "review": TaskSettings(None, "medium"), "design": TaskSettings(None, "medium")}),
            ("an o-series deployment", {}, "o4-mini", {"explain": TaskSettings(None, "low"), "review": TaskSettings(None, "medium"), "design": TaskSettings(None, "medium")}),
            ("a deployment that takes no effort", {}, "gpt-4.1", {task_type: TaskSettings() for task_type in ("explain", "review", "design")}),
            (
                "the environment names a model and an effort",
                {"EXPLAIN_MODEL": "o4-mini", "EXPLAIN_REASONING_EFFORT": " High "},
                "gpt-4.1",
                {"explain": TaskSettings("o4-mini", "high"), "review": TaskSettings(), "design": TaskSettings()},
            ),
            (
                "an empty effort leaves the default of the deployment",
                {"REVIEW_REASONING_EFFORT": ""},
                "gpt-54-mini",
                {"explain": TaskSettings(None, "low"), "review": TaskSettings(None, None), "design": TaskSettings(None, "medium")},
            ),
            (
                "a model that takes none, named for one type",
                {"DESIGN_MODEL": "gpt-4.1"},
                "gpt-54-mini",
                {"explain": TaskSettings(None, "low"), "review": TaskSettings(None, "medium"), "design": TaskSettings("gpt-4.1", None)},
            ),
        ]
        for label, environ, model, expected in cases:
            with self.subTest(label):
                self.assertEqual(task_settings(environ, model), expected)

    def test_an_effort_the_service_does_not_know_stops_the_start(self):
        with self.assertRaises(RuntimeError) as failure:
            task_settings({"DESIGN_REASONING_EFFORT": "extreme"}, "gpt-54-mini")

        self.assertIn("DESIGN_REASONING_EFFORT is 'extreme', not one of none, minimal, low, medium, high, xhigh", str(failure.exception))


class VisibleToolsTests(unittest.TestCase):
    AZURE = {
        "monitor_healthmodels_list", "monitor_healthmodels_get", "monitor_healthmodels_inspect", "monitor_metrics_definitions",
        "monitor_metrics_query", "monitor_workspace_log_query", "group_resource_list",
    }

    def test_what_each_type_is_offered(self):
        cases = [
            ("explain", {"submit_result", "load_skill", "monitor_activitylog_list"}),
            ("review", {"submit_result", "load_skill", "monitor_activitylog_list"}),
            ("design", {"submit_result", "load_skill", "run_shell", "clone_repository"}),
        ]
        for task_type, extra in cases:
            with self.subTest(task_type):
                self.assertEqual(visible_tools(task_type), frozenset(self.AZURE | extra))


if __name__ == "__main__":
    unittest.main()
