import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "deploy" / "deploy-agent.sh"
SUBSCRIPTION = "00000000-0000-0000-0000-000000000000"
PRINCIPAL = "11111111-2222-3333-4444-555555555555"
OTHER_PRINCIPAL = "99999999-8888-7777-6666-555555555555"
POLICY = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-example/providers/Microsoft.CognitiveServices/accounts/a/raiPolicies/agent-egress"

AZURE = r"""#!/usr/bin/env bash
echo "az $*" >> "$FAKE_LOG"
case "$1 $2" in
  "account get-access-token") echo fake-token ;;
  "resource show") echo agent-egress ;;
  "acr repository") [ -f "$FAKE_STATE/built" ] || exit 1 ;;
  "acr build") touch "$FAKE_STATE/built" ;;
  "containerapp show") cat "$FAKE_STATE/web-principal" 2>/dev/null; true ;;
  "containerapp update") for arg in "$@"; do case "$arg" in FOUNDRY_AGENT_PRINCIPAL_ID=*) echo "${arg#*=}" > "$FAKE_STATE/web-principal" ;; esac; done ;;
  *) echo "unexpected az $*" >&2; exit 2 ;;
esac
"""
AZD = r"""#!/usr/bin/env bash
echo "azd $*" >> "$FAKE_LOG"
[ "$1 $2" = "env set" ] || { echo "unexpected azd $*" >&2; exit 2; }
"""
CURL = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_CURL_ARGV"
exec "$REAL_CURL" "$@"
"""
SLEEP = "#!/usr/bin/env bash\nexit 0\n"


class FakeFoundry:
    """The project's agents API: agents, versions that turn active after some polls, 403 while access propagates."""

    def __init__(self):
        self.versions = []
        self.polls = {}
        self.forbidden = 0
        self.creating_polls = 1
        self.drop_policy = False
        self.requests = []
        self.auth_headers = []
        lock = threading.Lock()
        owner = self

        def version_object(n):
            status = "active" if owner.polls.get(n, 0) > owner.creating_polls else "creating"
            return {"object": "agent.version", "name": "health-model-agent", "version": str(n), "status": status, "definition": owner.versions[n - 1]}

        def agent_object():
            return {"object": "agent", "name": "health-model-agent", "instance_identity": {"principal_id": PRINCIPAL, "client_id": "c"}, "versions": {"latest": version_object(len(owner.versions))}}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def handle_any(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                path = self.path.split("?")[0]
                with lock:
                    owner.requests.append((method, path.split("/api/projects/p")[-1]))
                    owner.auth_headers.append(self.headers.get("Authorization"))
                    if owner.forbidden > 0:
                        owner.forbidden -= 1
                        return self.reply(403, {"error": {"code": "forbidden"}})
                    if method == "GET" and path.endswith("/agents/health-model-agent"):
                        return self.reply(200, agent_object()) if owner.versions else self.reply(404, {"error": {"code": "not_found"}})
                    if method == "GET" and "/versions/" in path:
                        n = int(path.rsplit("/", 1)[1])
                        if n > len(owner.versions) or owner.versions[n - 1] is None:
                            return self.reply(404, {})
                        owner.polls[n] = owner.polls.get(n, 0) + 1
                        return self.reply(200, version_object(n))
                    if method == "POST" and (path.endswith("/agents") or path.endswith("/versions")):
                        definition = dict(body["definition"])
                        if owner.drop_policy:
                            definition.pop("rai_config", None)
                        owner.versions.append(definition)
                        return self.reply(200, agent_object() if path.endswith("/agents") else version_object(len(owner.versions)))
                    if method == "DELETE" and "/versions/" in path:
                        owner.versions[int(path.rsplit("/", 1)[1]) - 1] = None
                        return self.reply(200, {"deleted": True})
                self.reply(404, {})

            def do_GET(self):
                self.handle_any("GET")

            def do_POST(self):
                self.handle_any("POST")

            def do_DELETE(self):
                self.handle_any("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = f"http://127.0.0.1:{self.server.server_address[1]}/api/projects/p"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def posts(self):
        return [path for method, path in self.requests if method == "POST"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class DeployScriptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state = self.root / "state"
        self.state.mkdir()
        shims = self.root / "bin"
        shims.mkdir()
        for name, text in (("az", AZURE), ("azd", AZD), ("curl", CURL), ("sleep", SLEEP)):
            (shims / name).write_text(text, encoding="utf-8")
            (shims / name).chmod(0o755 | stat.S_IXUSR)
        self.log = self.root / "calls.log"
        self.curl_argv = self.root / "curl-argv.log"
        self.foundry = FakeFoundry()
        self.addCleanup(self.foundry.close)
        self.env = {
            "PATH": f"{shims}:{os.environ['PATH']}",
            "HOME": os.environ["HOME"],
            "FAKE_LOG": str(self.log),
            "FAKE_STATE": str(self.state),
            "FAKE_CURL_ARGV": str(self.curl_argv),
            "REAL_CURL": shutil.which("curl"),
            "AZURE_SUBSCRIPTION_ID": SUBSCRIPTION,
            "AZURE_RESOURCE_GROUP": "rg-example",
            "AZURE_CONTAINER_REGISTRY_NAME": "acrexample",
            "AZURE_CONTAINER_REGISTRY_ENDPOINT": "acrexample.azurecr.io",
            "FOUNDRY_PROJECT_ENDPOINT": self.foundry.endpoint,
            "FOUNDRY_MODEL_DEPLOYMENT_NAME": "gpt-54-mini",
            "FOUNDRY_AGENT_NAME": "health-model-agent",
            "FOUNDRY_AGENT_EGRESS_POLICY_ID": POLICY,
            "MCP_URL": "https://ca-mcp.example.net/",
            "SERVICE_WEB_FQDN": "ca-web.example.net",
            "ENTRA_CLIENT_ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "SERVICE_WEB_NAME": "ca-web",
            "POLL_INTERVAL_SECONDS": "1",
            "ACTIVATION_TIMEOUT_SECONDS": "60",
        }

    def run_script(self, **overrides):
        env = {**self.env, **{key: value for key, value in overrides.items() if value is not None}}
        for key in [key for key, value in overrides.items() if value is None]:
            env.pop(key, None)
        result = subprocess.run(["/bin/bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)
        return result.returncode, result.stdout + result.stderr

    def calls(self, prefix):
        return [line for line in self.log.read_text(encoding="utf-8").splitlines() if line.startswith(prefix)] if self.log.exists() else []

    def test_create_builds_waits_and_hands_the_identity_to_the_web_app(self):
        code, output = self.run_script()

        self.assertEqual(code, 0, output)
        self.assertEqual(self.foundry.posts(), ["/agents"])
        self.assertIn("Version 1: active", output)
        self.assertEqual(len(self.calls("az acr build")), 1)
        self.assertEqual(self.calls("azd"), [f"azd env set FOUNDRY_AGENT_PRINCIPAL_ID {PRINCIPAL}"])
        self.assertEqual(
            self.calls("az containerapp update"),
            [f"az containerapp update --subscription {SUBSCRIPTION} --resource-group rg-example --name ca-web --set-env-vars FOUNDRY_AGENT_PRINCIPAL_ID={PRINCIPAL} --output none"],
        )

    def test_the_agent_version_carries_where_to_find_the_mcp_server_the_web_app_and_its_audience(self):
        self.run_script()

        environment = self.foundry.versions[0]["environment_variables"]
        self.assertEqual(
            environment,
            {
                "AZURE_AI_MODEL_DEPLOYMENT_NAME": "gpt-54-mini",
                "AZURE_TOKEN_CREDENTIALS": "ManagedIdentityCredential",
                "PYTHONNOUSERSITE": "1",
                "MCP_URL": "https://ca-mcp.example.net/",
                "WEB_APP_URL": "https://ca-web.example.net",
                "WEB_API_AUDIENCE": "api://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            },
        )
        self.assertEqual(self.foundry.versions[0]["rai_config"], {"rai_policy_name": POLICY})

    def test_the_agent_identity_gets_no_azure_role_and_the_override_never_reaches_the_agent(self):
        self.run_script(MCP_BEARER_COMMAND="echo token")

        self.assertEqual(self.calls("az role"), [])
        self.assertNotIn("MCP_BEARER_COMMAND", self.foundry.versions[0]["environment_variables"])

    def test_the_bearer_token_stays_off_the_command_line(self):
        self.run_script()

        self.assertNotIn("fake-token", self.curl_argv.read_text(encoding="utf-8"))
        self.assertTrue(self.foundry.auth_headers)
        self.assertEqual(set(self.foundry.auth_headers), {"Bearer fake-token"})

    def test_an_unchanged_run_creates_nothing_and_leaves_the_web_app_alone(self):
        self.run_script()
        posts = len(self.foundry.posts())

        code, output = self.run_script()

        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.foundry.posts()), posts)
        self.assertIn("already runs", output)
        self.assertIn("already knows the agent identity", output)
        self.assertEqual(len(self.calls("az containerapp update")), 1)
        self.assertEqual(len(self.calls("azd env set")), 2)

    def test_any_changed_setting_creates_a_new_version(self):
        self.run_script()
        cases = [
            ("model", {"FOUNDRY_MODEL_DEPLOYMENT_NAME": "other-model"}, "AZURE_AI_MODEL_DEPLOYMENT_NAME", "other-model"),
            ("mcp server", {"MCP_URL": "https://ca-mcp-2.example.net/"}, "MCP_URL", "https://ca-mcp-2.example.net/"),
            ("web app", {"SERVICE_WEB_FQDN": "ca-web-2.example.net"}, "WEB_APP_URL", "https://ca-web-2.example.net"),
            ("audience", {"ENTRA_CLIENT_ID": "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"}, "WEB_API_AUDIENCE", "api://ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee"),
        ]
        for label, change, name, value in cases:
            with self.subTest(label):
                before = len(self.foundry.versions)

                code, output = self.run_script(**change)

                self.assertEqual(code, 0, output)
                self.assertEqual(len(self.foundry.versions), before + 1)
                self.assertEqual(self.foundry.posts()[-1], "/agents/health-model-agent/versions")
                self.assertEqual(self.foundry.versions[-1]["environment_variables"][name], value)

    def test_the_web_app_learns_the_identity_unless_it_already_knows_it(self):
        cases = [
            ("none yet", None, True),
            ("another identity", OTHER_PRINCIPAL, True),
            ("the same identity", PRINCIPAL, False),
            ("the same in capitals", PRINCIPAL.upper(), False),
        ]
        for label, held, updated in cases:
            with self.subTest(label):
                (self.state / "web-principal").unlink(missing_ok=True)
                if held:
                    (self.state / "web-principal").write_text(held, encoding="utf-8")
                self.log.unlink(missing_ok=True)

                code, output = self.run_script()

                self.assertEqual(code, 0, output)
                self.assertEqual(len(self.calls("az containerapp update")), 1 if updated else 0)
                self.assertEqual(len(self.calls("azd env set")), 1)

    def test_a_missing_azd_output_is_named_before_anything_happens(self):
        names = [
            "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP", "AZURE_CONTAINER_REGISTRY_NAME", "AZURE_CONTAINER_REGISTRY_ENDPOINT",
            "FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_MODEL_DEPLOYMENT_NAME", "FOUNDRY_AGENT_EGRESS_POLICY_ID", "FOUNDRY_AGENT_NAME",
            "MCP_URL", "SERVICE_WEB_FQDN", "ENTRA_CLIENT_ID", "SERVICE_WEB_NAME",
        ]
        for name in names:
            with self.subTest(name):
                code, output = self.run_script(**{name: None})

                self.assertNotEqual(code, 0)
                self.assertIn("AGENT_NAME is not set" if name == "FOUNDRY_AGENT_NAME" else f"{name} is not set", output)
                self.assertEqual(self.foundry.requests, [])

    def test_agent_name_overrides_the_azd_value(self):
        code, output = self.run_script(FOUNDRY_AGENT_NAME=None, AGENT_NAME="health-model-agent")

        self.assertEqual(code, 0, output)

    def test_a_forbidden_answer_is_retried_while_access_propagates_and_then_reported(self):
        self.foundry.forbidden = 2
        code, output = self.run_script()
        self.assertEqual(code, 0, output)
        self.assertIn("deployer's access may still be propagating", output)
        self.assertIn("retrying in 5s", output)
        self.assertIn("retrying in 10s", output)

        self.foundry.forbidden = 100000
        code, output = self.run_script(FORBIDDEN_RETRY_SECONDS="6", FOUNDRY_MODEL_DEPLOYMENT_NAME="another")
        self.assertNotEqual(code, 0)
        self.assertIn("Foundry Project Manager", output)

    def test_a_version_without_the_egress_policy_is_deleted_and_never_waited_for(self):
        self.foundry.drop_policy = True

        code, output = self.run_script()

        self.assertNotEqual(code, 0)
        self.assertIn("does not reference the egress policy", output)
        self.assertIn("Deleted version 1", output)
        self.assertNotIn("Version 1:", output)
        self.assertIsNone(self.foundry.versions[0])
        self.assertEqual(self.calls("azd env set"), [])

    def test_a_version_still_provisioning_after_the_timeout_is_reused_by_the_next_run(self):
        self.foundry.creating_polls = 1000
        code, output = self.run_script(ACTIVATION_TIMEOUT_SECONDS="3")
        self.assertNotEqual(code, 0)
        self.assertIn("does not create another", output)
        self.assertEqual(self.calls("azd env set"), [])

        self.foundry.creating_polls = self.foundry.polls[1] + 2
        code, output = self.run_script()

        self.assertEqual(code, 0, output)
        self.assertEqual(len(self.foundry.versions), 1)
        self.assertIn("Version 1: active", output)
        self.assertEqual(len(self.calls("azd env set")), 1)


if __name__ == "__main__":
    unittest.main()
