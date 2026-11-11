import asyncio
import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path

from agent_framework import Content, Message
from mcp import types

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).parent))

logging.getLogger("asyncio").setLevel(logging.ERROR)

from agent import build_agent
from azure_mcp import AZURE_MCP_TOOLS, azure_mcp_tool, bearer_header, current_secrets, parse_result, redact
from fake_mcp_server import JWT, FakeAzureMcp, serving
from test_agent_runtime import SKILLS_DIR, ScriptedClient, call, results_of
from tokens import AzureUnavailable
from tools import CURRENT_RUN, RunRecord

NONCE_A = "a" * 43
NONCE_B = "b" * 43
NONCE_C = "c" * 43
TOKEN_A = "user-token-for-task-a"
TOKEN_B = "user-token-for-task-b"
UNKNOWN = "The web app does not know this Task any more: it ended or was cancelled."
SIGN_IN = "The signed-in user must sign in again before Azure can be read."
EXPLAINED = {"kind": "explain", "entity": "checkout", "state": "Unknown", "summary": "Nothing could be read.", "causes": []}


class FakeTokens:
    """What the broker would hand out: a token per nonce. A nonce in `broken` fails with its reason."""

    def __init__(self, table, broken=None, fail_after=None):
        self.table = table
        self.broken = broken or {}
        self.fail_after = fail_after
        self.held = {}
        self.asked = []

    async def token_for(self, nonce):
        self.asked.append(nonce)
        if nonce in self.broken or (self.fail_after is not None and len(self.asked) > self.fail_after):
            raise AzureUnavailable(self.broken.get(nonce, UNKNOWN))
        self.held[nonce] = self.table[nonce]
        return self.held[nonce]

    def cached(self, nonce):
        return self.held.get(nonce)


def task_message(task_id, nonce, task_type="explain"):
    task = {
        "id": task_id,
        "type": task_type,
        "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": "hm", "entity": "checkout"},
        "workload": None,
        "instruction": "",
        "nonce": nonce,
    }
    return f"Explain this entity.\n{json.dumps({'task': task})}"


class RedactTests(unittest.TestCase):
    def test_redact_removes_secrets_and_keeps_the_rest_readable(self):
        secrets = [NONCE_A, TOKEN_A]
        cases = [
            ("task nonce", f"the nonce {NONCE_A} was refused", "the nonce [redacted] was refused"),
            ("held token", f"sent {TOKEN_A} to the server", "sent [redacted] to the server"),
            ("access token", f"token {JWT} rejected", "token [redacted] rejected"),
            ("bearer header", "Authorization: Bearer abcdefghijklmnop1234567890 failed", "Authorization: [redacted] failed"),
            ("sas signature", "https://x.blob.core.windows.net/c?sv=1&sig=abc%2Fdef&se=2", "https://x.blob.core.windows.net/c?sv=1&[redacted]&se=2"),
            ("account key", "AccountKey=abc123==;Other=1", "[redacted];Other=1"),
            ("instrumentation key alone", "key InstrumentationKey=00000000-0000-0000-0000-000000000000 seen", "key [redacted] seen"),
            ("nothing to hide", "No bearer here and a design= value", "No bearer here and a design= value"),
            (
                "azure error with resource ids",
                "The client with object id '22222222-2222-2222-2222-222222222222' has no access to '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg'",
                "The client with object id '22222222-2222-2222-2222-222222222222' has no access to '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg'",
            ),
        ]
        for label, text, expected in cases:
            with self.subTest(label):
                self.assertEqual(redact(text, secrets), expected)

    def test_short_values_are_not_worth_replacing(self):
        self.assertEqual(redact("abc abc", ["abc"]), "abc abc")

    def test_parse_result_redacts_errors_and_results_alike(self):
        for label, is_error in [("error", True), ("result", False)]:
            with self.subTest(label):
                result = types.CallToolResult(
                    content=[
                        types.TextContent(type="text", text=f"first {NONCE_A}"),
                        types.TextContent(type="text", text=f"second {JWT}"),
                    ],
                    is_error=is_error,
                )

                self.assertEqual(parse_result(result, [NONCE_A]), "first [redacted]\nsecond [redacted]")


class AzureMcpToolTests(unittest.TestCase):
    def test_tool_exposes_the_listed_tools_without_approval(self):
        tool = azure_mcp_tool("https://mcp.example.net/", FakeTokens({}))

        self.assertEqual(tool.url, "https://mcp.example.net/")
        self.assertEqual(tool.approval_mode, "never_require")
        self.assertEqual(list(tool.allowed_tools), list(AZURE_MCP_TOOLS))
        self.assertFalse(tool.load_prompts_flag)

    def test_the_listed_tools_are_the_ones_the_web_app_titles_know(self):
        self.assertEqual(
            sorted(AZURE_MCP_TOOLS),
            sorted(
                [
                    "monitor_healthmodels_list",
                    "monitor_healthmodels_get",
                    "monitor_healthmodels_inspect",
                    "monitor_metrics_definitions",
                    "monitor_metrics_query",
                    "monitor_workspace_log_query",
                    "group_resource_list",
                ]
            ),
        )

    def test_the_server_address_is_https_or_this_machine(self):
        for label, url, allowed in [("https", "https://mcp.example.net/", True), ("local", "http://127.0.0.1:8080/", True), ("plain http", "http://mcp.example.net/", False)]:
            with self.subTest(label):
                if allowed:
                    azure_mcp_tool(url, FakeTokens({}))
                else:
                    with self.assertRaises(ValueError) as failure:
                        azure_mcp_tool(url, FakeTokens({}))
                    self.assertIn("MCP_URL", str(failure.exception))


class RunTokenTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tokens = FakeTokens({NONCE_A: TOKEN_A, NONCE_B: TOKEN_B})
        self.tokens.held = {NONCE_A: TOKEN_A, NONCE_B: TOKEN_B}

    def test_the_header_carries_the_token_held_for_the_task_of_this_run(self):
        cases = [
            ("task a", RunRecord(nonce=NONCE_A), {"Authorization": f"Bearer {TOKEN_A}"}),
            ("task b", RunRecord(nonce=NONCE_B), {"Authorization": f"Bearer {TOKEN_B}"}),
        ]
        for label, record, expected in cases:
            with self.subTest(label):
                CURRENT_RUN.set(record)
                self.assertEqual(bearer_header(self.tokens), expected)

    def test_a_task_without_a_token_raises_the_reason_the_model_is_given(self):
        cases = [
            ("blocked", RunRecord(nonce=NONCE_C, blocked=SIGN_IN), SIGN_IN),
            ("no token held", RunRecord(nonce=NONCE_C), "There is no token for this Task."),
            ("no task", None, "There is no token for this Task."),
        ]
        for label, record, reason in cases:
            with self.subTest(label):
                CURRENT_RUN.set(record)

                with self.assertRaises(AzureUnavailable) as failure:
                    bearer_header(self.tokens)

                self.assertEqual(str(failure.exception), reason)

    async def test_two_tasks_running_at_once_each_send_their_own_token(self):
        async def header_of(nonce):
            CURRENT_RUN.set(RunRecord(nonce=nonce))
            await asyncio.sleep(0.01)
            return bearer_header(self.tokens)

        headers = await asyncio.gather(*(header_of(nonce) for nonce in (NONCE_A, NONCE_B, NONCE_A)))

        self.assertEqual([h["Authorization"] for h in headers], [f"Bearer {TOKEN_A}", f"Bearer {TOKEN_B}", f"Bearer {TOKEN_A}"])

    def test_the_secrets_of_a_run_are_its_nonce_and_its_token(self):
        CURRENT_RUN.set(RunRecord(nonce=NONCE_A))
        self.assertEqual(current_secrets(self.tokens), [NONCE_A, TOKEN_A])
        CURRENT_RUN.set(RunRecord(nonce=NONCE_C))
        self.assertEqual(current_secrets(self.tokens), [NONCE_C])
        CURRENT_RUN.set(None)
        self.assertEqual(current_secrets(self.tokens), [])


class RemoteAzureTests(unittest.IsolatedAsyncioTestCase):
    """The agent against a fake MCP server over HTTP, which answers 401 to a request without a token it knows."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = Path(self.directory.name)
        self.fake = FakeAzureMcp([TOKEN_A, TOKEN_B])
        served = serving(self.fake)
        self.url = served.__enter__()
        self.addCleanup(served.__exit__, None, None, None)

    def agent_for(self, tokens, steps):
        client = ScriptedClient(steps)
        agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=self.workspace, tools=[azure_mcp_tool(self.url, tokens)], tokens=tokens)
        self.addAsyncCleanup(agent.close)
        return client, agent

    async def run_task(self, agent, task_id, nonce):
        return await agent.run([Message(role="user", contents=[Content.from_text(task_message(task_id, nonce))])])

    async def test_each_task_sends_its_own_token_with_every_request(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A, NONCE_B: TOKEN_B})
        steps = [[call("monitor_healthmodels_list")], [Content.from_text("Done.")]] * 2
        client, agent = self.agent_for(tokens, steps)

        first = await self.run_task(agent, "t-1", NONCE_A)
        after_first = len(self.fake.requests)
        second = await self.run_task(agent, "t-2", NONCE_B)

        for label, requests, token in [("task a", self.fake.requests[:after_first], TOKEN_A), ("task b", self.fake.requests[after_first:], TOKEN_B)]:
            with self.subTest(label):
                self.assertTrue(requests)
                self.assertEqual({request["authorization"] for request in requests}, {f"Bearer {token}"})
                self.assertEqual(len([r for r in requests if r["rpc"] == "tools/call"]), 1)
        self.assertLessEqual({"tools/list", "tools/call"}, {request["rpc"] for request in self.fake.requests})
        for response in (first, second):
            self.assertEqual([json.loads(r)["status"] for r in results_of(response.messages)], [200])

    async def test_only_the_listed_tools_are_offered(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A})
        client, agent = self.agent_for(tokens, [[Content.from_text("Nothing to do.")]])

        await self.run_task(agent, "t-1", NONCE_A)

        offered = {name for name in client.tool_names if name.startswith(("monitor_", "group_", "subscription_"))}
        self.assertEqual(offered, {"monitor_healthmodels_list", "monitor_healthmodels_inspect", "group_resource_list"})

    async def test_opening_the_agent_outside_a_run_connects_to_nothing(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A})
        client, agent = self.agent_for(tokens, [[call("monitor_healthmodels_list")], [Content.from_text("Done.")]])

        await agent.open()
        self.assertEqual(self.fake.requests, [])
        response = await self.run_task(agent, "t-1", NONCE_A)

        self.assertEqual({request["authorization"] for request in self.fake.requests}, {f"Bearer {TOKEN_A}"})
        self.assertEqual([json.loads(r)["status"] for r in results_of(response.messages)], [200])

    async def test_a_task_without_a_token_runs_without_azure_tools_and_submits_why(self):
        tokens = FakeTokens({}, broken={NONCE_C: SIGN_IN})
        client, agent = self.agent_for(tokens, [[call("submit_result", result=EXPLAINED)]])

        response = await self.run_task(agent, "t-1", NONCE_C)

        self.assertEqual(self.fake.requests, [])
        self.assertFalse([name for name in client.tool_names if name.startswith(("monitor_", "group_"))])
        self.assertIn(f"Azure cannot be read for this Task: {SIGN_IN}", client.instructions)
        self.assertEqual([json.loads(r) for r in results_of(response.messages)], [{"status": "accepted"}])
        self.assertEqual(json.loads((self.workspace / "tasks" / "t-1" / "result.json").read_text(encoding="utf-8")), EXPLAINED)

    async def test_a_task_without_a_token_may_not_claim_readings(self):
        tokens = FakeTokens({}, broken={NONCE_C: SIGN_IN})
        invented = {**EXPLAINED, "state": "Degraded", "causes": [{"entity": "checkout", "signal": None, "state": "Degraded", "threshold": None, "value": None, "rollup": None, "note": "Guess."}]}
        client, agent = self.agent_for(tokens, [[call("submit_result", result=invented)], [call("submit_result", result=EXPLAINED)]])

        response = await self.run_task(agent, "t-1", NONCE_C)

        answers = [json.loads(r) for r in results_of(response.messages)]
        self.assertEqual([a["status"] for a in answers], ["rejected", "accepted"])
        self.assertIn(f"Azure cannot be read for this Task ({SIGN_IN})", answers[0]["problems"][0])

    async def test_a_token_that_cannot_be_refreshed_mid_run_becomes_the_reason_the_model_reads(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A}, fail_after=1)
        captured = []

        def after_failure(messages):
            captured.extend(results_of(messages))
            return [call("submit_result", result=EXPLAINED)]

        client, agent = self.agent_for(tokens, [[call("monitor_healthmodels_list")], after_failure])

        response = await self.run_task(agent, "t-1", NONCE_A)

        self.assertEqual(len(captured), 1)
        self.assertIn(UNKNOWN, captured[0])
        self.assertEqual(self.fake.tool_calls(), [])
        self.assertEqual(json.loads(results_of(response.messages)[-1]), {"status": "accepted"})

    async def test_the_model_never_sees_the_nonce_and_a_tool_error_cannot_echo_it(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A})
        self.fake.secrets_to_leak = [NONCE_A, TOKEN_A]
        errors = []

        def after_error(messages):
            errors.extend(results_of(messages))
            return [Content.from_text("Done.")]

        client, agent = self.agent_for(tokens, [[call("monitor_healthmodels_inspect")], after_error])

        await self.run_task(agent, "t-1", NONCE_A)

        everything_the_model_saw = json.dumps([[message.text for message in call_messages] for call_messages in client.seen])
        for secret in (NONCE_A, TOKEN_A):
            with self.subTest(secret[:6]):
                self.assertNotIn(secret, everything_the_model_saw)
                self.assertNotIn(secret, "".join(errors))
        self.assertIn('"nonce": "[hidden]"', everything_the_model_saw.replace('\\"', '"'))
        self.assertIn("upstream said no for [redacted] and [redacted]", errors[0])

    async def test_no_secret_reaches_a_log_line_or_the_task_folder(self):
        tokens = FakeTokens({NONCE_A: TOKEN_A})
        self.fake.secrets_to_leak = [NONCE_A, TOKEN_A]
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                if not record.name.startswith("mcp.server"):  # the fake server's own log is not the agent's
                    records.append(record.getMessage())

        capture, root = Capture(level=logging.DEBUG), logging.getLogger()
        previous = root.level
        root.addHandler(capture)
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.removeHandler, capture)
        self.addCleanup(root.setLevel, previous)
        steps = [[call("monitor_healthmodels_list"), call("monitor_healthmodels_inspect")], [call("run_shell", command="env; pwd")], [Content.from_text("Done.")]]
        client, agent = self.agent_for(tokens, steps)

        await self.run_task(agent, "t-1", NONCE_A)

        files = [path.read_text(encoding="utf-8", errors="replace") for path in (self.workspace / "tasks").rglob("*") if path.is_file()]
        self.assertTrue(records)
        for secret in (NONCE_A, TOKEN_A):
            with self.subTest(secret[:6]):
                self.assertFalse([line for line in [*records, *files] if secret in line])


if __name__ == "__main__":
    unittest.main()
