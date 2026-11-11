import json
import logging
import os
import re
import shlex
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

import tools
from contracts import validate_task_result
from reduction import REPEATED_REJECTION
from tools import (
    MAX_IDLE,
    REDUCE_AFTER_TOTAL,
    SHELL_FILE_KIB,
    SHELL_OUTPUT_LIMIT,
    SHELL_TIMEOUT_CAP,
    RunRecord,
    ShellRun,
    asked_entity,
    blocked_problems,
    change_problems,
    clamp_timeout,
    design_problems,
    edges_of,
    endpoint_problems,
    expected_reads,
    find_envelope,
    find_task,
    limits_prelude,
    marked_pids,
    render_shell_run,
    run_command,
    shell_env,
    submit,
    target_name,
    task_folder,
    task_nonce,
    unreadable,
    task_problems,
    task_tools,
    unread_problems,
    verification_problems,
)

NEEDS_PROC = unittest.skipUnless(Path("/proc").is_dir(), "needs /proc")

AGENT_ENV = {
    "PATH": "/app/.venv/bin:/usr/bin",
    "HOME": "/home/session",
    "LANG": "C.UTF-8",
    "TMPDIR": "/tmp/session",
    "PYTHONNOUSERSITE": "1",
    "HTTPS_PROXY": "http://proxy.invalid:3128",
    "NO_PROXY": "localhost",
    "SSL_CERT_FILE": "/etc/ssl/custom.pem",
    "IDENTITY_ENDPOINT": "http://169.254.0.1:8081/msi/token",
    "IDENTITY_HEADER": "secret-header",
    "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
    "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
    "APPLICATIONINSIGHTS_CONNECTION_STRING": "InstrumentationKey=00000000-0000-0000-0000-000000000000",
    "FOUNDRY_PROJECT_ENDPOINT": "https://example.invalid/api/projects/p",
    "FOUNDRY_AGENT_SESSION_ID": "session-1",
    "AZURE_AI_MODEL_DEPLOYMENT_NAME": "model",
    "MCP_URL": "https://mcp.example.net/",
    "WEB_APP_URL": "https://web.example.net",
    "WEB_API_AUDIENCE": "api://00000000-0000-0000-0000-00000000aaaa",
    "MCP_BEARER_COMMAND": "az account get-access-token --query accessToken -o tsv",
    "OPENAI_API_KEY": "sk-not-for-the-shell",
}

RELATIONSHIPS = [
    {"name": "r-root-checkout", "parent": "hm", "child": "checkout"},
    {"name": "checkout-orders-db", "parent": "checkout", "child": "orders-db"},
]

ENVELOPE = {
    "task": {
        "id": "t-7",
        "type": "review",
        "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": "hm"},
        "workload": None,
        "instruction": "",
    },
    "relationships": RELATIONSHIPS,
}

RESULT = {
    "kind": "explain",
    "entity": "checkout",
    "state": "Healthy",
    "summary": "Nothing drives the state.",
    "causes": [],
}


def envelope_text(task_id, line="Review this model.", relationships=RELATIONSHIPS):
    return f"{line}\n{json.dumps({'task': {**ENVELOPE['task'], 'id': task_id}, 'relationships': relationships})}"


class TaskLookupTests(unittest.TestCase):
    def test_find_task_returns_the_latest_envelope(self):
        cases = [
            ("one envelope", [envelope_text("t-1")], "t-1"),
            ("latest text wins", [envelope_text("t-1"), envelope_text("t-2")], "t-2"),
            ("earlier text when the latest has none", [envelope_text("t-1"), "thanks"], "t-1"),
            ("latest envelope inside one text", [envelope_text("t-1") + "\n" + envelope_text("t-3")], "t-3"),
            ("no line before the json", [json.dumps(ENVELOPE)], "t-7"),
            ("relationships before the task", [json.dumps({"relationships": RELATIONSHIPS, "task": ENVELOPE["task"]})], "t-7"),
            ("no relationships", [json.dumps({"task": ENVELOPE["task"]})], "t-7"),
            ("empty relationships", [json.dumps({"task": ENVELOPE["task"], "relationships": []})], "t-7"),
            ("relationship named task", [envelope_text("t-6", relationships=[{"name": "task", "parent": "task", "child": "task-x"}])], "t-6"),
            ("many relationships", [envelope_text("t-8", relationships=[{"name": f"r-{n}", "parent": "hm", "child": f"e-{n}"} for n in range(500)])], "t-8"),
            ("relationships without a task", [json.dumps({"relationships": RELATIONSHIPS})], None),
            ("braces around it", ["see {braces} then " + json.dumps(ENVELOPE) + " {end}"], "t-7"),
            ("no envelope", ["hello"], None),
            ("no texts", [], None),
            ("broken json", ['{"task": {"id": "t-1"'], None),
            ("task is not an object", ['{"task": "t-1"}'], None),
            ("id is not text", ['{"task": {"id": 5}}'], None),
            ("empty id", ['{"task": {"id": ""}}'], None),
            ("json without task", ['{"id": "t-1"}'], None),
        ]
        for label, texts, expected in cases:
            with self.subTest(label):
                task = find_task(texts)

                self.assertEqual(task["id"] if task else None, expected)

    def test_task_folder_is_below_tasks_and_safe(self):
        workspace = Path("/tmp")
        cases = [
            ("plain", {"id": "t-7"}, "t-7"),
            ("uuid", {"id": "22222222-2222-2222-2222-222222222222"}, "22222222-2222-2222-2222-222222222222"),
            ("path separators", {"id": "../../etc/passwd"}, "______etc_passwd"),
            ("dots only", {"id": ".."}, "__"),
            ("spaces", {"id": "my task"}, "my_task"),
            ("long", {"id": "a" * 100}, "a" * 64),
            ("no task", None, "adhoc"),
        ]
        for label, task, expected in cases:
            with self.subTest(label):
                self.assertEqual(task_folder(workspace, task), workspace / "tasks" / expected)

    def test_clamp_timeout_stays_between_one_second_and_the_cap(self):
        for seconds, expected in [(-5, 1), (0, 1), (1, 1), (30, 30), (SHELL_TIMEOUT_CAP, SHELL_TIMEOUT_CAP), (10_000, SHELL_TIMEOUT_CAP)]:
            with self.subTest(seconds=seconds):
                self.assertEqual(clamp_timeout(seconds), expected)


class ShellEnvTests(unittest.TestCase):
    def test_only_listed_variables_reach_the_command(self):
        env = shell_env(AGENT_ENV, Path("/home/session/tasks/t-7"), "run-1")

        self.assertEqual(
            env,
            {
                "PATH": "/app/.venv/bin:/usr/bin",
                "HOME": "/home/session",
                "LANG": "C.UTF-8",
                "TMPDIR": "/tmp/session",
                "PYTHONNOUSERSITE": "1",
                "HTTPS_PROXY": "http://proxy.invalid:3128",
                "NO_PROXY": "localhost",
                "SSL_CERT_FILE": "/etc/ssl/custom.pem",
                "PWD": "/home/session/tasks/t-7",
                "GIT_TERMINAL_PROMPT": "0",
                "AGENT_RUN_ID": "run-1",
            },
        )

    def test_nothing_that_identifies_the_agent_is_handed_over(self):
        env = shell_env(AGENT_ENV, Path("/t"), "run-1")

        for key in (
            "IDENTITY_ENDPOINT",
            "IDENTITY_HEADER",
            "AZURE_TOKEN_CREDENTIALS",
            "AZURE_CLIENT_ID",
            "APPLICATIONINSIGHTS_CONNECTION_STRING",
            "FOUNDRY_PROJECT_ENDPOINT",
            "FOUNDRY_AGENT_SESSION_ID",
            "AZURE_AI_MODEL_DEPLOYMENT_NAME",
            "MCP_URL",
            "WEB_APP_URL",
            "WEB_API_AUDIENCE",
            "MCP_BEARER_COMMAND",
            "OPENAI_API_KEY",
        ):
            with self.subTest(key):
                self.assertNotIn(key, env)

    def test_an_empty_parent_still_gets_the_defined_variables(self):
        self.assertEqual(
            shell_env({}, Path("/t"), "run-1"),
            {"PWD": "/t", "GIT_TERMINAL_PROMPT": "0", "AGENT_RUN_ID": "run-1"},
        )


class ShellLimitsTests(unittest.TestCase):
    def test_limits_prelude(self):
        cases = [
            ("tasks unknown", None, "ulimit -t 240 2>/dev/null; ulimit -f 2097152 2>/dev/null; "),
            ("no tasks yet", 0, "ulimit -t 240 2>/dev/null; ulimit -f 2097152 2>/dev/null; ulimit -u 256 2>/dev/null; "),
            ("busy user", 150, "ulimit -t 240 2>/dev/null; ulimit -f 2097152 2>/dev/null; ulimit -u 406 2>/dev/null; "),
        ]
        for label, own_tasks, expected in cases:
            with self.subTest(label):
                self.assertEqual(limits_prelude(own_tasks), expected)

    def test_marked_pids_match_the_whole_marker_entry_only(self):
        environs = {
            1: b"PATH=/usr/bin\0HOME=/root",
            10: b"X=1\0AGENT_RUN_ID=abc\0Y=2",
            11: b"AGENT_RUN_ID=abcd",
            12: b"NOT_AGENT_RUN_ID=abc",
            13: b"",
            14: b"AGENT_RUN_ID=abc",
        }

        self.assertEqual(marked_pids(environs, "abc"), [10, 14])
        self.assertEqual(marked_pids(environs, "zzz"), [])


class ShellRenderTests(unittest.TestCase):
    def test_render_shell_run(self):
        cases = [
            ("success", ShellRun(0, b"hello\n", 6, 60), ["exit code 0\nhello\n"], ["truncated", "timed out"]),
            ("failure", ShellRun(3, b"bad\n", 4, 60), ["exit code 3\n"], ["truncated", "timed out"]),
            ("timeout", ShellRun(None, b"partial", 7, 5), ["timed out after 5s and was killed\npartial"], ["exit code"]),
            ("truncated", ShellRun(0, b"x" * 10, 50, 60), ["[output truncated: first 10 of 50 bytes shown]"], ["timed out"]),
            ("invalid utf-8", ShellRun(0, b"a\xffb", 3, 60), ["a�b"], []),
        ]
        for label, run, expected, unexpected in cases:
            with self.subTest(label):
                text = render_shell_run(run)

                for part in expected:
                    self.assertIn(part, text)
                for part in unexpected:
                    self.assertNotIn(part, text)


class ShellRunTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name, "tasks", "t-7")

    async def test_runs_in_the_task_folder_and_creates_it(self):
        self.assertFalse(self.folder.exists())

        run = await run_command("pwd", self.folder, 10)

        self.assertEqual(run.exit_code, 0)
        self.assertEqual(Path(run.output.decode().strip()).resolve(), self.folder.resolve())

    async def test_reports_exit_code_and_merges_stderr(self):
        cases = [
            ("success", "echo out", 0, b"out\n"),
            ("failure", "exit 3", 3, b""),
            ("stderr", "echo out; echo err >&2; exit 1", 1, b"out\nerr\n"),
            ("missing command", "no-such-command-xyz", 127, None),
            ("reads no stdin", "cat; echo done", 0, b"done\n"),
        ]
        for label, command, exit_code, output in cases:
            with self.subTest(label):
                run = await run_command(command, self.folder, 10)

                self.assertEqual(run.exit_code, exit_code)
                if output is not None:
                    self.assertEqual(run.output, output)

    async def test_environment_never_prompts_git(self):
        run = await run_command("echo $GIT_TERMINAL_PROMPT", self.folder, 10)

        self.assertEqual(run.output, b"0\n")

    async def test_timeout_kills_the_whole_command_and_keeps_its_output(self):
        started = time.monotonic()

        run = await run_command("echo started; sleep 30 & sleep 30; echo never", self.folder, 1)

        self.assertIsNone(run.exit_code)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(run.output, b"started\n")
        self.assertIn("timed out after 1s", render_shell_run(run))

    async def test_output_is_capped_and_the_notice_says_how_much_was_dropped(self):
        run = await run_command("head -c 50000 /dev/zero | tr '\\0' x", self.folder, 10)

        self.assertEqual(run.exit_code, 0)
        self.assertEqual(len(run.output), SHELL_OUTPUT_LIMIT)
        self.assertEqual(run.total_bytes, 50_000)
        self.assertIn(f"first {SHELL_OUTPUT_LIMIT} of 50000 bytes", render_shell_run(run))

    async def test_a_command_that_leaves_a_background_job_still_returns(self):
        started = time.monotonic()

        with mock.patch.object(tools, "DRAIN_SECONDS", 1):
            run = await run_command("echo hi; sleep 4 &", self.folder, 10)

        self.assertEqual(run.exit_code, 0)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(run.output, b"hi\n")


class ShellSandboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name, "tasks", "t-7")

    async def test_the_command_sees_the_listed_variables_and_no_agent_identity(self):
        with mock.patch.dict(os.environ, AGENT_ENV):
            run = await run_command("env", self.folder, 10)

        shown = run.output.decode()
        for secret in ("secret-header", "169.254.0.1", "InstrumentationKey", "example.invalid", "sk-not-for-the-shell"):
            with self.subTest(secret):
                self.assertNotIn(secret, shown)
        for expected in ("HTTPS_PROXY=http://proxy.invalid:3128", "GIT_TERMINAL_PROMPT=0", "AGENT_RUN_ID="):
            with self.subTest(expected):
                self.assertIn(expected, shown)

    async def test_limits_are_set_on_the_command(self):
        run = await run_command("ulimit -t; ulimit -f", self.folder, 10)

        self.assertEqual(run.output.decode().split(), ["240", str(SHELL_FILE_KIB)])

    async def test_the_command_cannot_raise_its_limits(self):
        run = await run_command("ulimit -t 1000 2>&1; ulimit -t", self.folder, 10)

        self.assertIn("240", run.output.decode().split())
        self.assertNotIn("1000", run.output.decode().split())

    async def test_a_file_above_the_size_limit_cannot_be_written(self):
        with mock.patch.object(tools, "SHELL_FILE_KIB", 1):
            run = await run_command("head -c 100000 /dev/zero > big; echo status=$?; wc -c < big", self.folder, 10)

        shown = run.output.decode()
        self.assertNotEqual(re.search(r"status=(\d+)", shown).group(1), "0")
        self.assertLessEqual(int(shown.split()[-1]), 1024)

    async def test_a_command_that_burns_cpu_is_stopped_by_the_cpu_limit(self):
        started = time.monotonic()

        with mock.patch.object(tools, "SHELL_CPU_SECONDS", 1):
            run = await run_command("while :; do :; done", self.folder, 20)

        self.assertIsNotNone(run.exit_code)
        self.assertNotEqual(run.exit_code, 0)
        self.assertLess(time.monotonic() - started, 10)

    @NEEDS_PROC
    async def test_a_fork_storm_stops_at_the_task_limit(self):
        spawn = (
            "import subprocess\nstarted = 0\nfor _ in range(80):\n    try:\n"
            "        subprocess.Popen(['sleep', '3'])\n        started += 1\n    except OSError:\n        pass\nprint(started)"
        )

        with mock.patch.object(tools, "SHELL_TASK_HEADROOM", 15):
            run = await run_command(f"{shlex.quote(sys.executable)} -c {shlex.quote(spawn)}", self.folder, 20)

        self.assertEqual(run.exit_code, 0)
        self.assertLess(int(run.output.decode().split()[-1]), 80)

    @NEEDS_PROC
    async def test_timeout_also_kills_children_that_left_the_process_group(self):
        escape = "import os, time\nos.setsid()\nopen('pid', 'w').write(str(os.getpid()))\ntime.sleep(60)"

        run = await run_command(f"{shlex.quote(sys.executable)} -c {shlex.quote(escape)} & sleep 30", self.folder, 2)

        pid = int((self.folder / "pid").read_text())
        self.assertIsNone(run.exit_code)
        for _ in range(40):
            if not process_alive(pid):
                break
            time.sleep(0.05)
        self.assertFalse(process_alive(pid))

    @NEEDS_PROC
    async def test_a_leftover_session_leader_is_killed_when_it_holds_the_output_open(self):
        escape = "import os, time\nos.setsid()\nopen('pid', 'w').write(str(os.getpid()))\ntime.sleep(60)"

        with mock.patch.object(tools, "DRAIN_SECONDS", 1):
            run = await run_command(f"{shlex.quote(sys.executable)} -c {shlex.quote(escape)} & sleep 1; echo done", self.folder, 10)

        pid = int((self.folder / "pid").read_text())
        self.assertEqual(run.exit_code, 0)
        self.assertEqual(run.output, b"done\n")
        for _ in range(40):
            if not process_alive(pid):
                break
            time.sleep(0.05)
        self.assertFalse(process_alive(pid))


def process_alive(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat.rsplit(")", 1)[1].split()[0] != "Z"


class TaskToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name, "tasks", "t-7")
        self.tools = {tool.name: tool for tool in task_tools(self.folder, RunRecord())}

    def test_tools_are_named_and_never_wait_for_approval(self):
        self.assertEqual(sorted(self.tools), ["clone_repository", "run_shell", "submit_result"])
        for name, tool in self.tools.items():
            with self.subTest(name):
                self.assertEqual(tool.approval_mode, "never_require")

    async def test_run_shell_clamps_the_timeout_and_renders_the_run(self):
        output = await self.tools["run_shell"].invoke(
            arguments={"command": "echo hi; exit 2", "timeout_seconds": 100_000}, skip_parsing=True
        )

        self.assertEqual(output, "exit code 2\nhi\n")

    async def test_run_shell_defaults_the_timeout(self):
        output = await self.tools["run_shell"].invoke(arguments={"command": "echo hi"}, skip_parsing=True)

        self.assertEqual(output, "exit code 0\nhi\n")

    async def test_submit_result_accepts_and_writes_the_file(self):
        output = await self.tools["submit_result"].invoke(arguments={"result": RESULT}, skip_parsing=True)

        self.assertEqual(output, '{"status":"accepted"}')
        self.assertEqual(json.loads((self.folder / "result.json").read_text(encoding="utf-8")), RESULT)

    async def test_submit_result_rejects_with_problems_and_writes_nothing(self):
        output = await self.tools["submit_result"].invoke(arguments={"result": {"kind": "explain"}}, skip_parsing=True)

        answer = json.loads(output)
        self.assertEqual(answer["status"], "rejected")
        self.assertIn("result: 'summary' is a required property (add it)", answer["problems"])
        self.assertFalse((self.folder / "result.json").exists())

    async def test_submit_result_keeps_the_last_accepted_result(self):
        later = {**RESULT, "state": "Degraded"}
        for result in (RESULT, {"kind": "explain"}, later):
            await self.tools["submit_result"].invoke(arguments={"result": result}, skip_parsing=True)

        self.assertEqual(json.loads((self.folder / "result.json").read_text(encoding="utf-8")), later)


def diff_with(*rows):
    return {"kind": "diff", "summary": "x", "changes": [], "findings": [], "verification": list(rows)}


def row(status, value=None, error=None):
    return {"entity": "api", "signal": "latency", "status": status, "query": "q", "value": value, "error": error}


class VerificationTests(unittest.TestCase):
    def test_rows_rest_on_queries_of_this_run(self):
        cases = [
            ("no rows", diff_with(), [], []),
            ("not_run needs no query", diff_with(row("not_run", error="PromQL")), [], []),
            ("verified after a query", diff_with(row("verified", value=3)), [True], []),
            ("failing after a failed query", diff_with(row("failing", error="no data")), [False], []),
            ("verified and failing after one query", diff_with(row("verified", value=3), row("failing", error="x")), [True], []),
            ("explain results have no rows", RESULT, [], []),
            ("verified without a query", diff_with(row("verified", value=3)), [], ["verification: no metrics or log query ran in this Task"]),
            ("failing without a query", diff_with(row("failing", error="no data")), [], ["verification: no metrics or log query ran in this Task"]),
            ("verified after a failed query only", diff_with(row("verified", value=3)), [False, False], ["verification: no query returned in this Task"]),
            ("verified without a value", diff_with(row("verified")), [True], ["verification[0]: a `verified` row needs `value`"]),
            ("failing without an error", diff_with(row("failing")), [True], ["verification[0]: a `failing` row needs `error`"]),
            ("not_run without a reason", diff_with(row("not_run")), [], ["verification[0]: a `not_run` row needs `error`"]),
            ("a zero reading is a value", diff_with(row("verified", value=0)), [True], []),
        ]
        for label, result, queries, expected in cases:
            with self.subTest(label):
                problems = verification_problems(result, RunRecord(queries))

                self.assertEqual(len(problems), len(expected), problems)
                for text, problem in zip(expected, problems):
                    self.assertTrue(problem.startswith(text), problem)

    def test_rows_after_failed_queries_are_told_how_to_become_honest(self):
        problems = verification_problems(diff_with(row("verified", value=3)), RunRecord([False, False]))

        self.assertEqual(len(problems), 1)
        for text in (
            "set each such row's status to `not_run`",
            "put the reason in `error`",
            "run a query that returns",
            "`failing` is for a signal the model already has; a new signal whose query fails is left out",
        ):
            self.assertIn(text.lower(), problems[0].lower())
        self.assertNotIn("to `failing`", problems[0])

    def test_a_finding_does_not_call_missing_what_a_row_read(self):
        def result(text, entity="api", status="verified"):
            rows = [{**row(status, value=1 if status == "verified" else None, error=None if status == "verified" else "x"), "entity": "api"}]
            return {**diff_with(*rows), "findings": [{"severity": "high", "entity": entity, "text": text, "changeIds": []}]}

        cases = [
            ("missing and read", result("The metric signals point at a resource ID that is not present."), 1),
            ("the entity in another case", result("The resource no longer exists.", entity="API"), 1),
            ("another entity", result("The resource does not exist.", entity="db"), 0),
            ("no entity", result("The resource does not exist.", entity=None), 0),
            ("missing and the row failed", result("The resource does not exist.", status="failing"), 0),
            ("read and healthy", result("Thresholds look too tight."), 0),
        ]
        for label, one, expected in cases:
            with self.subTest(label):
                problems = verification_problems(one, RunRecord([True]))

                self.assertEqual(len(problems), expected, problems)
                if expected:
                    self.assertIn("calls the resource of", problems[0])
                    self.assertIn("verification[0] read it", problems[0])

    def test_submit_rejects_rows_without_queries_and_accepts_them_afterwards(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord()
            result = {
                "kind": "diff",
                "summary": "x",
                "changes": [],
                "findings": [],
                "verification": [{"entity": "api", "signal": "latency", "status": "verified", "query": "q", "value": 1, "error": None}],
            }

            first = json.loads(submit(Path(directory), result, record))
            record.queries.append(True)
            second = json.loads(submit(Path(directory), result, record))

            self.assertEqual(first["status"], "rejected")
            self.assertTrue(first["problems"][0].startswith("verification: no metrics or log query ran"))
            self.assertEqual(second, {"status": "accepted"})


CURRENT = {
    "provisioningState": "Succeeded",
    "displayName": "Web",
    "healthObjective": 99.0,
    "impact": "Standard",
    "healthState": "Healthy",
    "signalGroups": {
        "dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": True},
        "azureResource": {
            "authenticationSetting": "auth-system",
            "azureResourceId": "/subscriptions/0/resourceGroups/rg/providers/Microsoft.App/containerApps/web",
            "azureResourceKind": "ContainerApp",
            "resourceHealth": {"enabled": "Enabled", "signalName": "ResourceHealth-1", "status": {"healthState": "Unknown"}},
            "signals": [
                {
                    "name": "cpu",
                    "signalKind": "AzureResourceMetric",
                    "metricNamespace": "Microsoft.App/containerApps",
                    "metricName": "CpuPercentage",
                    "aggregationType": "Average",
                    "timeGrain": "PT1M",
                    "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 95.0}},
                    "status": {"healthState": "Healthy", "value": 0.0},
                },
                {
                    "name": "memory",
                    "signalKind": "AzureResourceMetric",
                    "metricNamespace": "Microsoft.App/containerApps",
                    "metricName": "MemoryPercentage",
                    "aggregationType": "Average",
                    "timeGrain": "PT1M",
                    "evaluationRules": {"unhealthyRule": {"operator": "GreaterThan", "threshold": 95.0}},
                },
            ],
        },
    },
}

INSPECTED = json.dumps(
    {
        "status": 200,
        "message": "Success",
        "results": {"entities": [{"path": "web", "entity": {"name": "Web", "properties": CURRENT}}], "total": 1},
    }
)


def entity_change(name="web", reason="Fixes the threshold.", **edit):
    after = json.loads(json.dumps(CURRENT))
    for path, value in edit.items():
        target = after
        *parents, last = path.split("__")
        for part in parents:
            target = target[int(part)] if isinstance(target, list) else target[part]
        if value is DROP:
            del target[int(last) if isinstance(target, list) else last]
        else:
            target[int(last) if isinstance(target, list) else last] = value
    return {"kind": "diff", "changes": [{"id": "c1", "op": "change", "kind": "entity", "name": name, "after": after, "reason": reason}]}


DROP = object()


def envelope_of(task_type, name="hm", entity=None, relationships=None):
    target = {"name": name, **({"entity": entity} if entity else {})}
    body = {"task": {"id": "t-1", "type": task_type, "target": target}}
    if relationships is not None:
        body["relationships"] = relationships
    return body


class ReadingTests(unittest.TestCase):
    def test_what_a_task_has_to_read(self):
        edges = [{"name": "r-1", "parent": "hm", "child": "Checkout"}, {"name": "r-2", "parent": "Checkout", "child": "api"}]
        cases = [
            ("review reads the root and every edge end", envelope_of("review", "HM", relationships=edges), {"hm", "checkout", "api"}),
            ("review of a model without edges", envelope_of("review", "hm", relationships=[]), {"hm"}),
            ("review without a relationships list", envelope_of("review", "hm"), {"hm"}),
            ("review with a broken edge", envelope_of("review", "hm", relationships=["x", {"parent": 5, "child": None}]), {"hm"}),
            ("explain reads its entity", envelope_of("explain", entity="Checkout"), {"checkout"}),
            ("explain without an entity", envelope_of("explain"), set()),
            ("design reads nothing", envelope_of("design", relationships=edges), set()),
            ("no envelope", None, set()),
        ]
        for label, envelope, expected in cases:
            with self.subTest(label):
                self.assertEqual(expected_reads(envelope), frozenset(expected))

    def test_the_envelope_keeps_its_relationships(self):
        text = "Review this.\n" + json.dumps(envelope_of("review", relationships=[{"name": "r", "parent": "hm", "child": "a"}]))

        self.assertEqual(find_envelope([text])["relationships"][0]["child"], "a")
        self.assertIsNone(find_envelope(["hello"]))

    def test_unread_entities_are_named(self):
        read = {"hm": {}, "checkout": {}}
        cases = [
            ("all read", {"hm", "checkout"}, read, []),
            ("more read than needed", {"hm"}, read, []),
            ("nothing expected", set(), {}, []),
            ("review, some unread", {"hm", "checkout", "api", "db"}, read, ["review: 2 of the model's 4 entities were not read in this Task (for example api, db)"]),
            ("review, none read", {"hm", "api"}, {}, ["review: 2 of the model's 2 entities were not read in this Task (for example api, hm)"]),
            ("explain, not read", {"checkout"}, {"hm": {}}, ["explain: entity 'checkout' was not read in this Task"]),
        ]
        for label, expected, entities, problems in cases:
            with self.subTest(label):
                found = unread_problems(RunRecord(entities=entities, expected=frozenset(expected)))

                self.assertEqual(len(found), len(problems), found)
                for text, problem in zip(problems, found):
                    self.assertTrue(problem.startswith(text), problem)


class TaskAnswerTests(unittest.TestCase):
    def test_the_result_answers_the_task_of_the_latest_message(self):
        def explained(entity):
            return {**RESULT, "entity": entity}

        diff = diff_with()
        cases = [
            ("an explain answered", explained("checkout"), "explain", "checkout", []),
            ("the entity in another case", explained("Checkout"), "explain", "checkout", []),
            ("another entity explained", explained("api"), "explain", "checkout", ["this Task explains 'checkout', but the result is about 'api'"]),
            ("an explain answered with a diff", diff, "explain", "checkout", ["this Task is a explain: submit a result of kind `explain`, not `diff`"]),
            ("a review answered with an explain", explained("checkout"), "review", "", ["this Task is a review: submit a result of kind `diff`, not `explain`"]),
            ("a design answered with an explain", explained("checkout"), "design", "", ["this Task is a design: submit a result of kind `diff`, not `explain`"]),
            ("a review answered", diff, "review", "", []),
            ("a design answered", diff, "design", "", []),
            ("an explain without an entity", explained("api"), "explain", "", []),
            ("no task", diff, "", "", []),
        ]
        for label, result, task_type, asked, expected in cases:
            with self.subTest(label):
                problems = task_problems(result, RunRecord(task_type=task_type, asked=asked))

                self.assertEqual(len(problems), len(expected), problems)
                for text in expected:
                    self.assertTrue(problems[0].startswith(text), problems[0])
        self.assertIn("whatever earlier Tasks asked", task_problems(diff, RunRecord(task_type="explain"))[0])

    def test_the_asked_entity_belongs_to_an_explain(self):
        self.assertEqual(asked_entity(envelope_of("explain", entity="Checkout")), "checkout")
        self.assertEqual(asked_entity(envelope_of("review", entity="Checkout")), "")
        self.assertEqual(asked_entity(envelope_of("explain")), "")
        self.assertEqual(asked_entity(None), "")

    def test_the_wrong_kind_is_said_before_anything_else(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord(task_type="design", design=True, entities={"hm": {}})

            problems = json.loads(submit(Path(directory), RESULT, record))["problems"]

        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("this Task is a design"))


class EndpointTests(unittest.TestCase):
    def test_a_relationship_joins_entities_the_model_has_once_the_result_is_applied(self):
        def entity(op, name):
            return {"id": f"e-{name}", "op": op, "kind": "entity", "name": name, "after": None if op == "remove" else {}, "reason": "x"}

        def relationship(op, name, parent, child):
            return {"id": f"r-{name}", "op": op, "kind": "relationship", "name": name, "after": None if op == "remove" else {"parentEntityName": parent, "childEntityName": child}, "reason": "x"}

        def result(*changes):
            return {"kind": "diff", "changes": list(changes)}

        read = {"checkout": {}, "api": {}}
        cases = [
            ("both ends read", result(relationship("add", "a-b", "checkout", "API")), read, "hm", 0),
            ("the root is the model name", result(relationship("add", "a-b", "HM", "api")), read, "hm", 0),
            ("a child added in the same result", result(entity("add", "Db"), relationship("add", "a-b", "api", "db")), read, "hm", 0),
            ("a child that does not exist", result(relationship("add", "a-b", "api", "session-storage")), read, "hm", 1),
            ("a parent and a child that do not exist", result(relationship("add", "a-b", "x-1", "y-1")), read, "hm", 2),
            ("an entity removed by the same result", result(entity("remove", "api"), relationship("change", "a-b", "checkout", "api")), read, "hm", 1),
            ("a removed relationship is not checked", result(relationship("remove", "a-b", "x", "y")), read, "hm", 0),
            ("nothing was read", result(relationship("add", "a-b", "x-1", "y-1")), {}, "hm", 0),
            ("the root without a name", result(relationship("add", "a-b", "hm", "api")), read, "", 1),
            ("an explain result", RESULT, read, "hm", 0),
        ]
        for label, one, entities, root, expected in cases:
            with self.subTest(label):
                problems = endpoint_problems(one, RunRecord(entities=entities, root=root))

                self.assertEqual(len(problems), expected, problems)
                for problem in problems:
                    self.assertIn("which the model does not have", problem)

    def test_the_message_names_the_end_and_what_to_do(self):
        change = {"id": "c1", "op": "add", "kind": "relationship", "name": "a-b", "after": {"parentEntityName": "api", "childEntityName": "session-storage"}, "reason": "x"}

        problem = endpoint_problems({"kind": "diff", "changes": [change]}, RunRecord(entities={"api": {}}))[0]

        self.assertIn("relationship 'a-b' has child 'session-storage'", problem)
        self.assertIn("`add` that entity in this result, or leave the relationship out", problem)

    def test_the_model_of_the_task_is_named_in_lower_case(self):
        self.assertEqual(target_name(envelope_of("review", "Hm-Demo")), "hm-demo")
        self.assertEqual(target_name(None), "")
        self.assertEqual(target_name({"task": {"id": "1", "target": "x"}}), "")


class DesignTests(unittest.TestCase):
    def test_a_design_of_an_empty_model_adds_the_workload_tree(self):
        def change(op, kind):
            return {"id": "c1", "op": op, "kind": kind, "name": "x", "after": {}, "reason": "x"}

        def diff(*changes):
            return {"kind": "diff", "changes": list(changes)}

        root = {"hm": {}}
        cases = [
            ("nothing proposed", diff(), root, True, 1),
            ("only an entity", diff(change("add", "entity")), root, True, 1),
            ("only a relationship", diff(change("add", "relationship")), root, True, 1),
            ("only a change of the root", diff(change("change", "entity")), root, True, 1),
            ("an entity and a relationship", diff(change("add", "entity"), change("add", "relationship")), root, True, 0),
            ("the target was not read", diff(), {}, True, 0),
            ("a model that has more than its root", diff(), {"hm": {}, "api": {}}, True, 0),
            ("a review", diff(), root, False, 0),
            ("an explain", RESULT, root, True, 0),
        ]
        for label, result, entities, design, expected in cases:
            with self.subTest(label):
                problems = design_problems(result, RunRecord(entities=entities, design=design))

                self.assertEqual(len(problems), expected, problems)


class ChangeTests(unittest.TestCase):
    def record(self):
        record = RunRecord()
        record.read_entities(INSPECTED)
        return record

    def test_a_change_starts_from_what_the_run_read_and_keeps_the_rest(self):
        cases = [
            ("a new threshold", entity_change(signalGroups__azureResource__signals__0__evaluationRules__unhealthyRule__threshold=80), []),
            ("a new display name", entity_change(displayName="Web app"), []),
            ("a new signal", entity_change(signalGroups__azureResource__signals__1__name="memory-load"), ["leaves out signalGroups.azureResource.signals[memory]"]),
            ("nothing changed", entity_change(), ["is the same as in the model"]),
            ("only read-only fields differ", entity_change(provisioningState="Failed", healthState="Unhealthy"), ["is the same as in the model"]),
            ("a position is not a change", entity_change(canvasPosition={"x": 1, "y": 2}), ["is the same as in the model"]),
            ("a group left out", entity_change(signalGroups__dependencies=DROP), ["leaves out signalGroups.dependencies"]),
            ("a signal left out", entity_change(signalGroups__azureResource__signals__1=DROP, signalGroups__dependencies=DROP), ["signalGroups.dependencies", "signals[memory]"]),
            ("a field left out", entity_change(healthObjective=DROP), ["leaves out healthObjective"]),
            ("left out and named in the reason", entity_change(reason="Removes the memory signal, which has no data.", signalGroups__azureResource__signals__1=DROP, signalGroups__azureResource__signals__0__metricName="CpuPercentage"), []),
            ("left out and named with other spacing", entity_change(reason="Turns off resource health, which is unsupported here.", signalGroups__azureResource__resourceHealth=DROP), []),
            ("left out but another thing is named", entity_change(reason="Removes the cpu signal.", signalGroups__dependencies=DROP, signalGroups__azureResource__signals__0__metricName="CpuPercentage"), ["leaves out signalGroups.dependencies"]),
            ("the name in another case", entity_change(name="WEB", displayName="Web app"), []),
            ("an entity that was not read", entity_change(name="checkout", displayName="Checkout"), ["entity 'checkout' was not read in this Task"]),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = change_problems(result, self.record())

                self.assertEqual(len(problems), 1 if expected else 0, problems)
                for text in expected:
                    self.assertIn(text, problems[0])

    def test_a_relationship_change_moves_an_edge_of_the_task(self):
        record = RunRecord(edges=edges_of(envelope_of("review", relationships=[{"name": "R-1", "parent": "hm", "child": "Checkout"}])))
        change = {"id": "c1", "op": "change", "kind": "relationship", "name": "r-1", "reason": "x"}
        cases = [
            ("same pair", {**change, "after": {"parentEntityName": "HM", "childEntityName": "checkout"}}, ["is the same as in the model"]),
            ("another child", {**change, "after": {"parentEntityName": "hm", "childEntityName": "api"}}, []),
            ("another parent", {**change, "after": {"parentEntityName": "root", "childEntityName": "checkout"}}, []),
            ("an unlisted name", {**change, "name": "r-9", "after": {"parentEntityName": "hm", "childEntityName": "api"}}, ["is not in the Task's relationships"]),
            ("an add of a listed name", {**change, "op": "add", "after": {"parentEntityName": "hm", "childEntityName": "checkout"}}, ["already exists"]),
        ]
        for label, one, expected in cases:
            with self.subTest(label):
                problems = change_problems({"kind": "diff", "changes": [one]}, record)

                self.assertEqual(len(problems), len(expected), problems)
                for text in expected:
                    self.assertIn(text, problems[0])

    def test_an_add_of_what_the_run_read_is_a_change_or_nothing(self):
        record = RunRecord(
            entities={"hm": {}, "checkout": {}},
            edges=edges_of(envelope_of("design", relationships=[{"name": "hm-checkout", "parent": "hm", "child": "checkout"}])),
        )

        def add(kind, name, after):
            return {"kind": "diff", "changes": [{"id": "c1", "op": "add", "kind": kind, "name": name, "after": after, "reason": "x"}]}

        edge = lambda parent, child: {"parentEntityName": parent, "childEntityName": child}
        cases = [
            ("the root", add("entity", "HM", {"displayName": "x"}), ["entity 'HM' already exists in the model (the root exists too)"]),
            ("an entity that was read", add("entity", "checkout", {"displayName": "x"}), ["already exists"]),
            ("a new entity", add("entity", "api", {"displayName": "x"}), []),
            ("a listed relationship", add("relationship", "hm-checkout", edge("hm", "checkout")), ["relationship 'hm-checkout' already exists"]),
            ("a listed pair under another name", add("relationship", "root-checkout", edge("HM", "Checkout")), ["repeats hm -> checkout, which already exists as 'hm-checkout'"]),
            ("a new relationship", add("relationship", "checkout-api", edge("checkout", "api")), []),
            ("a signal definition", add("signalDefinition", "checkout", {"signalKind": "AzureResourceMetric"}), []),
            (
                "a listed pair under another name, the listed one removed",
                {"kind": "diff", "changes": [*add("relationship", "root-checkout", edge("HM", "Checkout"))["changes"], {"id": "c2", "op": "remove", "kind": "relationship", "name": "HM-Checkout", "after": None, "reason": "x"}]},
                [],
            ),
        ]
        for label, result, expected in cases:
            with self.subTest(label):
                problems = change_problems(result, record)

                self.assertEqual(len(problems), len(expected), problems)
                for text in expected:
                    self.assertIn(text, problems[0])

    def test_the_task_relationships_are_read_by_name(self):
        edges = [{"name": "A-b", "parent": "A", "child": "B"}, {"name": 5, "parent": "x", "child": "y"}, "z", {"name": "c"}]

        self.assertEqual(edges_of(envelope_of("review", relationships=edges)), {"a-b": ("a", "b")})
        self.assertEqual(edges_of(None), {})
        self.assertEqual(edges_of(envelope_of("explain")), {})

    def test_only_changes_of_entities_are_checked(self):
        change = entity_change()["changes"][0]
        cases = [
            ("add", {**change, "op": "add"}),
            ("remove", {**change, "op": "remove", "after": None}),
            ("relationship removal", {**change, "op": "remove", "kind": "relationship", "after": None}),
            ("signal definition", {**change, "kind": "signalDefinition"}),
        ]
        for label, one in cases:
            with self.subTest(label):
                self.assertEqual(change_problems({"kind": "diff", "changes": [one]}, RunRecord()), [])
        self.assertEqual(change_problems(RESULT, RunRecord()), [])

    def test_a_read_that_is_partial_or_repeated_still_serves_as_the_current_state(self):
        record = RunRecord()
        record.read_entities(json.dumps({"results": {"entities": [{"entity": {"name": "web", "properties": {"displayName": "Web"}}}]}}))
        partial = change_problems(entity_change(displayName="Web app"), record)
        record.read_entities(INSPECTED)
        full = change_problems(entity_change(signalGroups__dependencies=DROP), record)

        self.assertEqual(partial, [])
        self.assertIn("leaves out signalGroups.dependencies", full[0])

    def test_an_entity_without_a_name_is_named_by_its_path_or_by_the_call(self):
        def inspected(*items):
            return json.dumps({"results": {"entities": [{**item, "entity": {"properties": {"displayName": "x", **extra}}} for item, extra in items]}})

        cases = [
            ("named by itself", json.dumps({"results": {"entities": [{"path": "other", "entity": {"name": "Api", "properties": {"displayName": "x"}}}]}}), None, {"api"}),
            ("named by the end of its walk path", inspected(({"path": "hm/checkout/Api"}, {}), ({"path": "hm/checkout/db"}, {})), None, {"api", "db"}),
            ("named by a path without a walk", inspected(({"path": "checkout"}, {})), "other", {"checkout"}),
            ("named by the entity the call asked for", inspected(({}, {})), "Checkout", {"checkout"}),
            ("a call that asked for none", inspected(({}, {})), None, set()),
            ("two nameless items and one asked entity", inspected(({}, {}), ({}, {})), "checkout", set()),
            ("an empty path", inspected(({"path": ""}, {})), "checkout", {"checkout"}),
        ]
        for label, text, requested, expected in cases:
            with self.subTest(label):
                record = RunRecord()
                record.read_entities(text, requested)

                self.assertEqual(set(record.entities), expected)

    def test_a_nameless_whole_model_read_cannot_stand_for_the_entities(self):
        record = RunRecord(expected=frozenset({"hm", "checkout"}))
        record.read_entities(json.dumps({"results": {"entities": [{"entity": {"properties": {}}}, {"entity": {"properties": {}}}]}}))

        problems = unread_problems(record)

        self.assertEqual(len(problems), 1)
        self.assertIn("keep `entity.name` if you use `fields`", problems[0])

    def test_reads_that_are_not_inspect_results_record_nothing(self):
        record = RunRecord()
        for text in ["", "not json", "Error: Function failed.", "[]", '{"results": {}}', '{"results": {"entities": [{"entity": {}}]}}', '{"results": {"entities": null}}']:
            with self.subTest(text):
                record.read_entities(text)

        self.assertEqual(record.entities, {})


DESIGN_ENTITIES = {
    "hm-demo": {"displayName": "Model"},
    "browse-products": {"displayName": "Browse products", "icon": {"iconName": "UserFlow"}},
    "web-app": {
        "displayName": "Web app",
        "signalGroups": {
            "azureResource": {"authenticationSetting": "auth-system", "azureResourceId": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/web", "signals": []}
        },
    },
    "orders-db": {"displayName": "Orders database"},
}


def design_record(**changes):
    """A design of a model that is not empty: a root, a flow below it, a component with a resource and a database."""
    entities = json.loads(json.dumps(DESIGN_ENTITIES))
    edges = {
        "hm-demo-browse-products": ("hm-demo", "browse-products"),
        "browse-products-web-app": ("browse-products", "web-app"),
        "web-app-orders-db": ("web-app", "orders-db"),
    }
    return RunRecord(entities=entities, edges=edges, design=True, root="hm-demo", task_type="design", **changes)


def no_op_changes(count):
    """Changes of entities that leave them as they are: each is rejected as `the same as in the model`."""
    return [
        {"id": f"c{number}", "op": "change", "kind": "entity", "name": name, "after": json.loads(json.dumps(DESIGN_ENTITIES[name])), "reason": "Rewrites it."}
        for number, name in enumerate(["browse-products", "web-app", "orders-db"][:count], 1)
    ]


def unfit_diff(count=3):
    return {"kind": "diff", "summary": "Proposes the model.", "changes": no_op_changes(count), "verification": [], "findings": []}


def diff_with_one_good_change():
    """A removal that passes every check, beside changes that cannot."""
    good = {"id": "c9", "op": "remove", "kind": "relationship", "name": "browse-products-web-app", "after": None, "reason": "The flow goes away."}
    return {**unfit_diff(2), "changes": [*no_op_changes(2), good]}


DISTINCT_BROKEN = [
    {"kind": "x"},
    {"kind": "explain"},
    {"kind": "diff"},
    {"kind": "explain", "entity": "e"},
    {"kind": "diff", "summary": "s"},
]


class RejectionLadderTests(unittest.TestCase):
    """Every rejection has an exit: the problems, then a decision, then the result the agent submits itself."""

    def climb(self, record, results, folder):
        return [json.loads(submit(folder, result, record)) for result in results]

    def test_a_result_sent_again_unchanged_gets_a_decision_and_then_a_reduced_result(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord()

            first, second, third = self.climb(record, [{"kind": "x"}] * 3, Path(directory))

        self.assertEqual([answer["status"] for answer in (first, second, third)], ["rejected"] * 3)
        self.assertNotEqual(first["problems"][0], REPEATED_REJECTION)
        self.assertEqual(second["problems"][0], REPEATED_REJECTION)
        self.assertIn("1 more unchanged submit(s)", second["problems"][-1])
        self.assertEqual(third["problems"], ["Rejected again: the agent now submits a reduced result for you. Do not submit again."])
        self.assertEqual((record.rejections, record.repeats), (3, 2))
        self.assertIsNotNone(record.reduced)

    def test_a_changed_result_starts_the_count_again(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord()
            other = {"kind": "explain"}

            answers = self.climb(record, [{"kind": "x"}, {"kind": "x"}, other, other], Path(directory))

        self.assertEqual([answer["problems"][0] == REPEATED_REJECTION for answer in answers], [False, True, False, True])
        self.assertIsNone(record.reduced)
        self.assertEqual((record.rejections, record.repeats), (4, 1))

    def test_the_total_of_rejections_ends_it_however_the_problems_change(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord()

            answers = self.climb(record, DISTINCT_BROKEN, Path(directory))

        self.assertEqual(REDUCE_AFTER_TOTAL, len(DISTINCT_BROKEN))
        self.assertEqual([answer["problems"][0].startswith("Rejected again") for answer in answers], [False] * 4 + [True])
        self.assertEqual(record.repeats, 0)
        self.assertIsNotNone(record.reduced)

    def test_the_reduced_result_is_accepted_as_partial_and_written(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory, "tasks", "t-1")
            record = design_record()

            answers = self.climb(record, [unfit_diff()] * 3, folder)
            reduced = record.reduced
            accepted = submit(folder, reduced, record)
            written = json.loads((folder / "result.json").read_text(encoding="utf-8"))

        self.assertEqual([answer["status"] for answer in answers], ["rejected"] * 3)
        self.assertEqual(accepted, '{"status":"accepted","partial":true}')
        self.assertEqual(written, reduced)
        self.assertEqual(validate_task_result(reduced), [])
        self.assertEqual(reduced["changes"], [])
        self.assertTrue(reduced["summary"].startswith("Partial result: the proposal was rejected 3 times"))
        self.assertEqual(len(reduced["findings"]), 3)
        for finding in reduced["findings"]:
            self.assertTrue(finding["text"].startswith("Not proposed (change entity"), finding["text"])
            self.assertIn("is the same as in the model", finding["text"])

    def test_the_decision_names_the_changes_to_drop_and_the_fallbacks_that_are_always_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            record = design_record()

            _, second = self.climb(record, [unfit_diff()] * 2, Path(directory))

        text = " ".join(second["problems"])
        for expected in [
            "The problems sit in c1 (change entity 'browse-products'), c2 (change entity 'web-app'), c3 (change entity 'orders-db')",
            "put it in `findings` (`changeIds` `[]`)",
            "`remove` it and every relationship that names it, and give a replacement another name",
            "the diff without those changes, or, when the model already covers the workload, `changes` `[]` with a `summary` that says so",
        ]:
            with self.subTest(expected):
                self.assertIn(expected, text)

    def test_the_reduced_result_keeps_what_passes_and_quotes_what_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            record = design_record()

            self.climb(record, [diff_with_one_good_change()] * 3, Path(directory))

        reduced = record.reduced
        self.assertEqual([change["id"] for change in reduced["changes"]], ["c9"])
        self.assertEqual(validate_task_result(reduced), [])
        self.assertEqual([finding["entity"] for finding in reduced["findings"]], ["browse-products", "web-app"])
        self.assertIn("the 2 change(s) left out are quoted in the findings", reduced["summary"])

    def test_an_explain_that_cannot_be_fixed_keeps_the_state_the_run_read(self):
        record = RunRecord(task_type="explain", asked="checkout", entities={"checkout": {"healthState": "Unhealthy"}}, expected=frozenset({"checkout"}))
        broken = {"kind": "explain", "entity": "checkout", "state": "Unhealthy", "summary": "x" * 400, "causes": []}
        with tempfile.TemporaryDirectory() as directory:
            self.climb(record, [broken] * 3, Path(directory))

        reduced = record.reduced
        self.assertEqual((reduced["kind"], reduced["entity"], reduced["state"], reduced["causes"]), ("explain", "checkout", "Unhealthy", []))
        self.assertTrue(reduced["summary"].startswith("Partial result: the proposal was rejected 3 times, so no explanation could be completed"))
        self.assertEqual(validate_task_result(reduced), [])

    def test_a_run_that_never_submitted_gets_an_empty_result_that_says_why(self):
        cases = [
            ("design", 30, "diff", "Partial result: the Task used all 30 model calls, so nothing is proposed."),
            ("review", 20, "diff", "Partial result: the Task used all 20 model calls, so nothing is proposed."),
            ("explain", 12, "explain", "Partial result: the Task used all 12 model calls, so no explanation could be completed."),
        ]
        for task_type, calls, kind, summary in cases:
            with self.subTest(task_type), tempfile.TemporaryDirectory() as directory:
                record = RunRecord(task_type=task_type, asked="checkout" if task_type == "explain" else "")

                reduced = tools.forced_result(record, Path(directory), f"the Task used all {calls} model calls")

                self.assertEqual(validate_task_result(reduced), [])
                self.assertEqual((reduced["kind"], reduced["summary"]), (kind, summary))
                if kind == "diff":
                    self.assertEqual([finding["text"] for finding in reduced["findings"]], [f"The Task ended early: the Task used all {calls} model calls."])

    def test_a_blocked_run_that_never_submitted_says_why_azure_cannot_be_read(self):
        record = RunRecord(task_type="review", blocked="The user must sign in again.")
        with tempfile.TemporaryDirectory() as directory:
            reduced = tools.forced_result(record, Path(directory), "the Task used all 20 model calls")

        self.assertEqual(reduced["changes"], [])
        self.assertEqual(reduced["summary"], "Partial result: Azure cannot be read for this Task (The user must sign in again.), so nothing is proposed.")
        self.assertEqual(validate_task_result(reduced), [])

    def test_every_rejection_is_logged_with_its_problems_and_without_the_nonce(self):
        record = RunRecord(nonce="nonce-1234567890", task_type="explain", asked="checkout")
        wrong = {"kind": "explain", "entity": "nonce-1234567890", "state": "Healthy", "summary": "Fine.", "causes": []}
        with tempfile.TemporaryDirectory() as directory, self.assertLogs("health-model-agent", level="INFO") as logged:
            answer = json.loads(submit(Path(directory, "t-5"), wrong, record))

        self.assertEqual(answer["problems"], ["this Task explains 'checkout', but the result is about 'nonce-1234567890'"])
        self.assertEqual(
            [line.split(":", 2)[2] for line in logged.output],
            [
                "submit_result rejected task=t-5 rejection=1 identical=1 problems=1",
                "submit_result problem 1: this Task explains 'checkout', but the result is about '[redacted]'",
            ],
        )

    def test_the_repeat_message_says_the_same_payload_is_rejected_again(self):
        self.assertIn("this payload will be rejected again, however often it is sent", REPEATED_REJECTION)

    def test_idle_is_reset_by_every_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            record = RunRecord(idle=MAX_IDLE)

            submit(Path(directory), {"kind": "x"}, record)

        self.assertEqual(record.idle, 0)


class TaskNonceTests(unittest.TestCase):
    def test_the_nonce_is_the_text_the_envelope_carries(self):
        cases = [
            ("a nonce", {"task": {"id": "t", "nonce": "x" * 43}}, "x" * 43),
            ("none", {"task": {"id": "t"}}, ""),
            ("not text", {"task": {"id": "t", "nonce": 7}}, ""),
            ("no envelope", None, ""),
        ]
        for label, envelope, expected in cases:
            with self.subTest(label):
                self.assertEqual(task_nonce(envelope), expected)

    def test_it_is_found_with_the_task_in_the_user_message(self):
        text = f"Explain.\n{json.dumps({'task': {'id': 't-1', 'type': 'explain', 'nonce': 'abc'}})}"

        self.assertEqual(task_nonce(find_envelope([text])), "abc")


class BlockedTests(unittest.TestCase):
    """Azure could not be read for the run: the result says so and proposes nothing."""

    REASON = "The signed-in user must sign in again before Azure can be read."
    CAUSE = {"entity": "checkout", "signal": None, "state": "Degraded", "threshold": None, "value": None, "rollup": None, "note": "Guess."}
    NOTHING_READ = {
        "kind": "diff",
        "summary": REASON,
        "changes": [],
        "verification": [],
        "findings": [{"severity": "high", "entity": None, "text": REASON, "changeIds": []}],
    }
    ADD = {"id": "c1", "op": "add", "kind": "entity", "name": "storefront", "after": {"displayName": "Storefront"}, "reason": "Needed."}
    ROW = {"entity": "checkout", "signal": "latency", "status": "verified", "query": "q", "value": 1, "error": None}

    def test_only_a_result_that_claims_nothing_is_accepted(self):
        record = RunRecord(blocked=self.REASON)
        cases = [
            ("explain without causes", {**RESULT, "state": "Unknown", "causes": []}, True),
            ("explain with a cause", {**RESULT, "causes": [self.CAUSE]}, False),
            ("diff without changes", self.NOTHING_READ, True),
            ("diff with a change", {**self.NOTHING_READ, "changes": [self.ADD]}, False),
            ("diff with a verification row", {**self.NOTHING_READ, "verification": [self.ROW]}, False),
        ]
        for label, result, accepted in cases:
            with self.subTest(label):
                problems = blocked_problems(result, record.blocked)

                self.assertEqual(problems == [], accepted)
                if not accepted:
                    self.assertIn(f"Azure cannot be read for this Task ({self.REASON})", problems[0])

    def test_a_blocked_run_needs_no_reading_and_another_run_does(self):
        explain = {**RESULT, "state": "Unknown", "causes": []}
        task = {"task": {"id": "t-1", "type": "explain", "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": "hm", "entity": "checkout"}}}
        cases = [
            ("blocked", RunRecord(blocked=self.REASON, expected=expected_reads(task), task_type="explain", asked="checkout"), '{"status":"accepted"}'),
            ("not blocked", RunRecord(expected=expected_reads(task), task_type="explain", asked="checkout"), None),
        ]
        for label, record, expected in cases:
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                answer = submit(Path(directory), explain, record)

                if expected:
                    self.assertEqual(answer, expected)
                else:
                    self.assertIn("was not read in this Task", answer)

    def test_a_model_that_could_not_be_read_twice_is_as_good_as_blocked(self):
        read = {"checkout": {"displayName": "Checkout"}}
        cases = [
            ("no failure", RunRecord(), False),
            ("one failure", RunRecord(read_failures=1), False),
            ("two failures", RunRecord(read_failures=2), True),
            ("two failures, then a read", RunRecord(read_failures=2, entities=read), False),
            ("blocked", RunRecord(blocked=self.REASON), True),
        ]
        for label, record, expected in cases:
            with self.subTest(label):
                self.assertEqual(bool(unreadable(record)), expected)
        self.assertEqual(unreadable(RunRecord(blocked=self.REASON, read_failures=5)), self.REASON)

    def test_an_empty_result_is_accepted_once_the_model_could_not_be_read_twice(self):
        task = {"task": {"id": "t-1", "type": "explain", "target": {"subscriptionId": "s", "resourceGroup": "rg", "name": "hm", "entity": "checkout"}}}
        explain = {**RESULT, "state": "Unknown", "causes": []}
        for label, failures, expected in [("once", 1, "was not read in this Task"), ("twice", 2, '"status":"accepted"')]:
            with self.subTest(label), tempfile.TemporaryDirectory() as directory:
                record = RunRecord(expected=expected_reads(task), task_type="explain", asked="checkout", read_failures=failures)

                self.assertIn(expected, submit(Path(directory), explain, record))

    def test_a_blocked_run_still_answers_its_own_task(self):
        record = RunRecord(blocked=self.REASON, task_type="review")
        with tempfile.TemporaryDirectory() as directory:
            answer = json.loads(submit(Path(directory), {**RESULT, "state": "Unknown"}, record))

        self.assertEqual(answer["status"], "rejected")
        self.assertIn("this Task is a review: submit a result of kind `diff`", answer["problems"][0])


class SubmitTests(unittest.TestCase):
    def test_submit_answers_with_compact_json(self):
        with tempfile.TemporaryDirectory() as directory:
            cases = [
                ("accepted", RESULT, '{"status":"accepted"}'),
                ("rejected", {"kind": "x"}, None),
            ]
            for label, result, expected in cases:
                with self.subTest(label):
                    answer = submit(Path(directory, label), result, RunRecord())

                    if expected:
                        self.assertEqual(answer, expected)
                    else:
                        self.assertTrue(answer.startswith('{"status":"rejected","problems":['))


if __name__ == "__main__":
    unittest.main()
