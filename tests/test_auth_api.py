import asyncio
import base64
import importlib
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import URLError

import jwt
from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError, ServiceRequestError
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

SUB = "11111111-1111-1111-1111-111111111111"
GROUP = "rg-ahm-demo"
MODEL = "hm-ahm-demo"
DESIGN = "hm-ahm-demo-design"
TARGET = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
TENANT = "3a3a3a3a-3a3a-3a3a-3a3a-3a3a3a3a3a3a"
OTHER_TENANT = "77777777-7777-7777-7777-777777777777"
CLIENT = "44444444-4444-4444-4444-444444444444"
API_SCOPE = f"api://{CLIENT}/access_as_user"
MCP_SCOPE = "api://55555555-5555-5555-5555-555555555555/Mcp.Tools.ReadWrite"
AGENT = "dddddddd-dddd-dddd-dddd-dddddddddddd"
STRANGER = "88888888-8888-8888-8888-888888888888"
ADA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
BOB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
CY = "cccccccc-cccc-cccc-cccc-cccccccccccc"
NAMES = {ADA: "Ada Lovelace", BOB: "Bob Barker", CY: "Cy Young"}
NOW = int(time.time())
CLAIMS = '{"access_token":{"acrs":{"essential":true,"value":"c1"}}}'
REPORT = {"signalName": "web-ui-health-report", "healthState": "Healthy", "value": 1, "expiresInMinutes": 30, "reasonPreset": "recovery"}
APP_MODULES = (
    "main", "config", "dto", "inventory", "reports", "errors", "healthmodels", "model_diff", "activity",
    "sessions_store", "foundry_agent", "fake_agent", "fixture_models", "task_runner", "apply", "auth", "obo",
)
PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_PRIVATE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PUBLIC_SURFACE = {("GET", "/"), ("GET", "/api/config"), ("POST", "/api/agent/token"), ("GET", "/{full_path}")}
DOCUMENTATION_PATHS = ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect")


def mint(oid=ADA, key=PRIVATE, kid="k1", **changes):
    payload = {
        "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0",
        "aud": CLIENT,
        "tid": TENANT,
        "oid": oid,
        "name": NAMES.get(oid),
        "scp": "access_as_user",
        "exp": NOW + 3600,
        "nbf": NOW - 60,
        "iat": NOW - 60,
        "ver": "2.0",
        **changes,
    }
    payload = {name: value for name, value in payload.items() if value is not None}
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})


def other_directory(oid=ADA, **changes):
    """A user token of OTHER_TENANT: a work or school account of another directory."""
    return mint(oid, tid=OTHER_TENANT, iss=f"https://login.microsoftonline.com/{OTHER_TENANT}/v2.0", **changes)


def app_token(oid=AGENT, **changes):
    return mint(oid, scp=None, idtyp="app", roles=["Task.Run"], **changes)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def frames(body):
    return [dict(line.split(": ", 1) for line in block.split("\n") if ": " in line) for block in body.split("\n\n") if block.strip()]


class Keys:
    def __init__(self):
        self.error = None

    def open(self, request, timeout=None):
        if self.error:
            raise self.error
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE.public_key(), as_dict=True)
        return io.BytesIO(json.dumps({"keys": [{**jwk, "kid": "k1", "use": "sig", "alg": "RS256"}]}).encode())


class Credentials:
    def __init__(self):
        self.asked = []
        self.directories = []
        self.error = None

    def credential(self, caller):
        credentials = self

        class ForCaller:
            def get_token(self, *scopes, claims=None, **_):
                credentials.asked.append((caller.oid, caller.assertion, scopes, claims))
                credentials.directories.append(caller.tenant_id)
                if credentials.error:
                    raise credentials.error
                return AccessToken(f"mcp-token-of-{caller.oid}", NOW + 3600)

        return ForCaller()


class EntraCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dist = tempfile.TemporaryDirectory()
        dist = Path(cls.dist.name)
        (dist / "assets").mkdir()
        (dist / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
        cls.environment = {
            "AUTH_MODE": "entra",
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": "InstrumentationKey=00000000-0000-0000-0000-000000000000",
            "AZURE_SUBSCRIPTION_ID": SUB,
            "AZURE_RESOURCE_GROUP": GROUP,
            "HEALTH_MODEL_NAME": MODEL,
            "HEALTH_MODEL_DESIGN_NAME": DESIGN,
            "SESSIONS_CONTAINER_URL": "memory:",
            "FOUNDRY_PROJECT_ENDPOINT": "fake:",
            "FOUNDRY_AGENT_NAME": "health-model-agent",
            "ENTRA_TENANT_ID": TENANT,
            "ENTRA_CLIENT_ID": CLIENT,
            "ENTRA_API_SCOPE": API_SCOPE,
            "MCP_SCOPE": MCP_SCOPE,
            "FOUNDRY_AGENT_PRINCIPAL_ID": AGENT,
            "UI_DIST_DIR": str(dist),
        }
        cls.env_patch = mock.patch.dict(os.environ, cls.environment)
        cls.env_patch.start()
        os.environ.pop("CONTAINER_APP_NAME", None)
        cls.keys = Keys()
        cls.patchers = [
            mock.patch("azure.identity.DefaultAzureCredential", return_value=mock.Mock()),
            mock.patch("azure.monitor.opentelemetry.configure_azure_monitor"),
            mock.patch("jwt.jwks_client.urllib.request.build_opener", return_value=cls.keys),
        ]
        for patcher in cls.patchers:
            patcher.start()
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "web" / "app"))
        for name in APP_MODULES:
            sys.modules.pop(name, None)
        cls.module = importlib.import_module("main")
        for name in APP_MODULES[1:]:
            setattr(cls, name, importlib.import_module(name))

    @classmethod
    def tearDownClass(cls):
        for patcher in reversed(cls.patchers):
            patcher.stop()
        cls.env_patch.stop()
        cls.dist.cleanup()

    def setUp(self):
        self.install(self.fake_agent.FakeAgent(delay=0))
        self.keys.error = None

    def install(self, agent):
        self.store = self.sessions_store.MemorySessionsStore()
        self.health = self.fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, DESIGN))
        self.credentials = Credentials()
        self.agent = agent
        self.module.store, self.module.agent, self.module.health = self.store, agent, self.health
        self.module.credentials = self.credentials
        self.module.runner = self.task_runner.TaskRunner(self.store, agent, self.health)

    def gated(self):
        gate, sent = asyncio.Event(), []

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                sent.append(text)
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        return gate, sent

    def nonce(self, sent, number=1):
        deadline = time.monotonic() + 5
        while len(sent) < number and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertGreaterEqual(len(sent), number, "the agent never got the task")
        return json.loads(sent[number - 1].split("\n", 1)[1])["task"]["nonce"]

    def call(self, client, method, path, who=ADA, **kwargs):
        headers = {**(bearer(mint(who)) if who else {}), **kwargs.pop("headers", {})}
        return client.request(method, path, headers=headers, **kwargs)

    def new_session(self, client, who=ADA, **body):
        response = self.call(client, "POST", "/api/sessions", who, json=body)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def start(self, client, sid, who=ADA, **body):
        return self.call(client, "POST", f"/api/sessions/{sid}/tasks", who, json=body)

    def finish(self, client, sid, who=ADA, seq=1):
        self.call(client, "GET", f"/api/sessions/{sid}/tasks/{seq}/events", who)
        return self.call(client, "GET", f"/api/sessions/{sid}/tasks/{seq}", who).json()

    def review(self, client, who=ADA):
        sid = self.new_session(client, who)
        self.assertEqual(self.start(client, sid, who, type="review", target=TARGET).status_code, 202)
        self.assertEqual(self.finish(client, sid, who)["status"], "done")
        return sid

    def agent_call(self, client, body, headers=None, **kwargs):
        headers = bearer(app_token()) if headers is None else headers
        return client.post("/api/agent/token", json=body, headers=headers, **kwargs)

    def assert_error(self, response, status, code, retryable=None):
        error = response.json()["error"]
        self.assertEqual((response.status_code, error["code"]), (status, code), response.text)
        if retryable is not None:
            self.assertEqual(error["retryable"], retryable)
        self.assertRegex(error["operationId"], r"^[0-9a-f]{32}$")
        self.assertEqual(response.headers["cache-control"], "no-store")
        return error


class SignInTests(EntraCase):
    def test_the_config_is_public_and_tells_the_ui_how_to_sign_in(self):
        with TestClient(self.module.app) as client:
            plain = client.get("/api/config")
            ignoring = client.get("/api/config", headers={"Authorization": "Bearer garbage"})

        for response in (plain, ignoring):
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.json(),
                {"authMode": "entra", "clientId": CLIENT, "apiScope": API_SCOPE, "homeDirectory": TENANT},
            )
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_only_the_shell_the_config_the_broker_and_the_assets_are_public(self):
        top = {getattr(route, "path", None) for route in self.module.app.routes} - {None}
        operations = [
            (method.upper(), path)
            for path, methods in self.module.app.openapi()["paths"].items()
            for method in methods
        ]
        protected = sorted(set(operations) - PUBLIC_SURFACE)

        self.assertEqual(top, {"/", "/api/config", "/api/agent/token", "/assets", "/{full_path:path}"})
        self.assertEqual([d.dependency for d in self.module.api.dependencies], [self.module.authenticated])
        self.assertTrue(PUBLIC_SURFACE <= set(operations))
        self.assertGreaterEqual(len(protected), 12)
        self.assertTrue(all(path.startswith("/api/") for _, path in protected))
        with TestClient(self.module.app) as client:
            for method, path in protected:
                with self.subTest(route=f"{method} {path}"):
                    response = client.request(method, re.sub(r"\{[^}]+\}", "x", path))

                    error = self.assert_error(response, 401, "unauthenticated", False)
                    self.assertEqual(response.headers["www-authenticate"], "Bearer")
                    self.assertEqual(error["message"], "Sign in to continue.")

    def test_the_public_routes_answer_without_a_token(self):
        with TestClient(self.module.app) as client:
            answers = {
                "the shell": client.get("/"),
                "a deep link": client.get("/sessions/abc"),
                "the config": client.get("/api/config"),
            }

        self.assertEqual({label: response.status_code for label, response in answers.items()}, dict.fromkeys(answers, 200))

    def test_the_built_in_documentation_routes_do_not_exist_and_fall_through_to_the_shell(self):
        with TestClient(self.module.app) as client:
            answers = {path: client.get(path) for path in DOCUMENTATION_PATHS}

        self.assertEqual((self.module.app.docs_url, self.module.app.redoc_url, self.module.app.openapi_url), (None, None, None))
        for path, response in answers.items():
            with self.subTest(path=path):
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"].split(";")[0], "text/html")
                self.assertEqual(response.text, '<div id="root"></div>')

    def test_unknown_api_paths_never_fall_through_to_the_shell_and_need_a_sign_in_like_the_rest(self):
        cases = [
            ("GET", "/api/nope"),
            ("GET", "/api/"),
            ("GET", "/api"),
            ("POST", "/api/nope"),
            ("PUT", "/api/sessions"),
            ("DELETE", "/api/sessions/x"),
            ("GET", "/api/sessions/x/tasks"),
            ("GET", "/api/sessions/x/unknown"),
            ("POST", "/api/config"),
            ("GET", "/api/agent/token"),
            ("GET", "/api/openapi.json"),
            ("GET", "/api/docs"),
            ("OPTIONS", "/api/nope"),
            ("HEAD", "/api/nope"),
        ]
        with TestClient(self.module.app) as client:
            for method, path in cases:
                with self.subTest(route=f"{method} {path}"):
                    anonymous = client.request(method, path)
                    signed_in = self.call(client, method, path)

                    self.assertEqual((anonymous.status_code, signed_in.status_code), (401, 404))
                    for response in (anonymous, signed_in):
                        self.assertEqual(response.headers["content-type"].split(";")[0], "application/json")
                        self.assertEqual(response.headers["cache-control"], "no-store")
                    if method != "HEAD":
                        self.assert_error(anonymous, 401, "unauthenticated", False)
                        error = self.assert_error(signed_in, 404, "not_found", False)
                        self.assertEqual(error["message"], "There is no such API route.")

    def test_paths_that_only_start_like_the_api_are_still_the_shell(self):
        with TestClient(self.module.app) as client:
            answers = {path: client.get(path) for path in ("/apiary", "/api-docs", "/apis/x", "/nope", "/sessions/abc")}

        for path, response in answers.items():
            with self.subTest(path=path):
                self.assertEqual((response.status_code, response.text), (200, '<div id="root"></div>'))

    def test_a_request_without_a_valid_sign_in_is_refused_the_same_way_on_every_kind_of_route(self):
        good = mint()
        cases = [
            ("no header", {}),
            ("another scheme", {"Authorization": f"Basic {good}"}),
            ("no token", {"Authorization": "Bearer"}),
            ("an empty token", {"Authorization": "Bearer "}),
            ("text that is no token", bearer("not-a-token")),
            ("a token of another key", bearer(mint(key=OTHER_PRIVATE))),
            ("a key id nobody knows", bearer(mint(kid="forged"))),
            ("an expired token", bearer(mint(exp=NOW - 3600))),
            ("a token that is not valid yet", bearer(mint(nbf=NOW + 3600))),
            ("a token whose issuer is not the directory it names", bearer(mint(tid=OTHER_TENANT))),
            ("a token without a tenant", bearer(mint(tid=None))),
            ("a version 1 issuer", bearer(mint(iss=f"https://sts.windows.net/{TENANT}/"))),
            ("a token for another app", bearer(mint(aud="api://66666666-6666-6666-6666-666666666666"))),
            ("a token for another scope", bearer(mint(scp="user_impersonation"))),
            ("a token without a scope", bearer(mint(scp=None))),
            ("an app-only token", bearer(app_token())),
            ("a token of a user without an oid", bearer(mint(oid=None))),
            ("an oversized token", {"Authorization": "Bearer " + "x" * 20000}),
        ]
        routes = [
            ("GET", "/api/sessions", {}),
            ("POST", "/api/sessions", {"json": {}}),
            ("GET", "/api/sessions/abc/tasks/1/events", {"headers": {"Last-Event-ID": "2"}}),
            ("GET", "/api/health-model", {}),
            ("GET", "/api/timeline", {}),
        ]
        reached = []
        for name in ("list_sessions", "create_session", "get_session", "get_task"):
            original = getattr(self.store, name)

            async def spy(*args, _name=name, _original=original):
                reached.append(_name)
                return await _original(*args)

            setattr(self.store, name, spy)
        with TestClient(self.module.app) as client:
            for label, headers in cases:
                for method, path, extra in routes:
                    with self.subTest(case=label, route=f"{method} {path}"):
                        response = client.request(method, path, **{**extra, "headers": {**extra.get("headers", {}), **headers}})

                        error = self.assert_error(response, 401, "unauthenticated", False)
                        self.assertEqual(response.headers["www-authenticate"], "Bearer")
                        self.assertEqual(error["message"], "Sign in to continue.")
                        self.assertEqual(set(error), {"code", "message", "retryable", "operationId"})

        self.assertEqual(reached, [])

    def test_a_valid_token_reaches_the_azure_layer_as_the_user_in_it_and_owns_what_it_creates(self):
        seen = []
        original = self.health.as_user
        self.health.as_user = lambda caller: seen.append(caller) or original(caller)
        token = mint(BOB)

        with TestClient(self.module.app) as client:
            created = client.post("/api/sessions", json={}, headers=bearer(token))
            catalog = client.get("/api/health-models", headers=bearer(token))

        self.assertEqual((created.status_code, catalog.status_code), (201, 200))
        self.assertEqual([(c.oid, c.name, c.assertion) for c in seen], [(BOB, "Bob Barker", token)])
        self.assertEqual([s["id"] for s in asyncio.run(self.store.list_sessions(BOB))], [created.json()["id"]])
        self.assertEqual(asyncio.run(self.store.list_sessions(ADA)), [])

    def test_the_user_is_the_oid_whatever_its_letter_case(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client, ADA.upper())
            listed = self.call(client, "GET", "/api/sessions", ADA).json()["sessions"]

        self.assertEqual([s["id"] for s in listed], [sid])

    def test_the_key_service_being_down_is_a_retryable_503_and_not_a_bad_token(self):
        self.keys.error = URLError("down")
        with mock.patch.object(self.module.authenticator, "_keys", self.auth.signing_keys()):
            with TestClient(self.module.app) as client:
                response = client.get("/api/sessions", headers=bearer(mint()))

        self.assert_error(response, 503, "auth_unavailable", True)
        self.assertNotIn("www-authenticate", response.headers)

    def test_the_event_stream_checks_the_token_before_it_streams(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            path = f"/api/sessions/{sid}/tasks/1/events"

            refused = client.get(path)
            resumed = self.call(client, "GET", path, headers={"Last-Event-ID": "2"})

        self.assert_error(refused, 401, "unauthenticated", False)
        self.assertNotIn("text/event-stream", refused.headers["content-type"])
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.headers["content-type"].split(";")[0], "text/event-stream")
        self.assertEqual(frames(resumed.text)[0]["id"], "3")

    def test_tokens_never_reach_the_logs_or_the_responses(self):
        tokens = [mint(), mint(kid="forged"), mint(exp=NOW - 3600), mint(scp="other"), app_token()]
        with self.assertLogs("ahm-demo", level="DEBUG") as logged:
            with TestClient(self.module.app) as client:
                for token in tokens:
                    response = client.get("/api/sessions", headers=bearer(token))
                    client.post("/api/agent/token", json={"nonce": "x"}, headers=bearer(token))
                    text = response.text + str(dict(response.headers))
                    for secret in (token, token.split(".")[1], token.split(".")[2]):
                        self.assertNotIn(secret, text)

        output = "\n".join(logged.output)
        for token in tokens:
            for secret in (token, token.split(".")[1], token.split(".")[2]):
                self.assertNotIn(secret, output)


class IsolationTests(EntraCase):
    def test_every_session_and_task_route_answers_404_to_another_user_and_changes_nothing(self):
        written = []
        for name in ("write_resource", "delete_resource"):
            original = getattr(self.health, name)
            setattr(self.health, name, lambda *args, _name=name, _original=original: written.append(_name) or _original(*args))
        with TestClient(self.module.app) as client:
            sid = self.review(client, ADA)
            routes = [
                ("GET", f"/api/sessions/{sid}", None, "session_not_found"),
                ("POST", f"/api/sessions/{sid}/tasks", {"type": "review", "target": TARGET}, "session_not_found"),
                ("GET", f"/api/sessions/{sid}/tasks/1", None, "task_not_found"),
                ("GET", f"/api/sessions/{sid}/tasks/1/events", None, "task_not_found"),
                ("GET", f"/api/sessions/{sid}/tasks/1/diff", None, "diff_not_found"),
                ("POST", f"/api/sessions/{sid}/tasks/1/apply", {"changeIds": ["c1"]}, "diff_not_found"),
            ]
            for method, path, body, code in routes:
                with self.subTest(route=f"{method} {path}"):
                    other = self.call(client, method, path, BOB, **({"json": body} if body else {}))

                    self.assert_error(other, 404, code, False)
                    if method == "GET":
                        self.assertEqual(self.call(client, method, path, ADA).status_code, 200)
            theirs = self.call(client, "GET", f"/api/sessions/{sid}", ADA).json()
            diff = self.call(client, "GET", f"/api/sessions/{sid}/tasks/1/diff", ADA).json()

        self.assertEqual(asyncio.run(self.store.list_sessions(BOB)), [])
        self.assertEqual(asyncio.run(self.store.list_tasks(BOB, sid)), [])
        self.assertEqual(len(theirs["tasks"]), 1)
        self.assertEqual(diff["applies"], [])
        self.assertEqual(written, [])

    def test_users_list_only_their_own_sessions(self):
        with TestClient(self.module.app) as client:
            ada = [self.new_session(client, ADA, title=f"Ada {n}") for n in range(2)]
            bob = [self.new_session(client, BOB, title="Bob")]
            listed = {who: self.call(client, "GET", "/api/sessions", who).json()["sessions"] for who in (ADA, BOB, CY)}

        self.assertEqual({who: sorted(s["id"] for s in sessions) for who, sessions in listed.items()}, {ADA: sorted(ada), BOB: bob, CY: []})
        self.assertNotIn("Bob", json.dumps(listed[ADA]))

    def test_the_session_cap_is_per_user(self):
        with mock.patch.object(self.sessions_store, "MAX_SESSIONS", 2):
            with TestClient(self.module.app) as client:
                for _ in range(2):
                    self.new_session(client, ADA)
                refused = self.call(client, "POST", "/api/sessions", ADA, json={})
                other = self.call(client, "POST", "/api/sessions", BOB, json={})

        self.assert_error(refused, 409, "session_limit", False)
        self.assertEqual(other.status_code, 201)

    def test_unfinished_tasks_of_every_user_are_failed_when_the_app_starts(self):
        async def seed():
            sessions = {}
            for who in (ADA, BOB):
                session = await self.store.create_session(who, "Crashed")
                await self.store.create_task(who, session["id"], {"type": "review", "status": "running", "target": TARGET, "createdAt": "t"})
                sessions[who] = session["id"]
            return sessions

        sessions = asyncio.run(seed())
        with TestClient(self.module.app) as client:
            deadline = time.monotonic() + 5
            while not client.portal.call(lambda: self.module.app.state.recovery.done()) and time.monotonic() < deadline:
                time.sleep(0.01)
            tasks = {who: self.call(client, "GET", f"/api/sessions/{sid}/tasks/1", who).json() for who, sid in sessions.items()}

        for who, task in tasks.items():
            self.assertEqual((task["status"], task["error"]["code"]), ("failed", "interrupted"), who)

    def test_a_user_runs_one_task_at_a_time_and_other_users_are_not_blocked(self):
        gate, _ = self.gated()
        with TestClient(self.module.app) as client:
            first, second = self.new_session(client, ADA), self.new_session(client, ADA)
            bobs = self.new_session(client, BOB)
            running = self.start(client, first, ADA, type="review", target=TARGET)
            same = self.start(client, first, ADA, type="review", target=TARGET)
            elsewhere = self.start(client, second, ADA, type="review", target=TARGET)
            other = self.start(client, bobs, BOB, type="review", target=TARGET)
            nothing_created = self.call(client, "GET", f"/api/sessions/{second}", ADA).json()["tasks"]
            client.portal.call(gate.set)
            self.finish(client, first, ADA)
            self.finish(client, bobs, BOB)
            later = self.start(client, second, ADA, type="review", target=TARGET)
            self.finish(client, second, ADA)

        self.assertEqual((running.status_code, other.status_code, later.status_code), (202, 202, 202))
        self.assertIn("already running in this session", self.assert_error(same, 409, "task_running", True)["message"])
        self.assertIn("another session", self.assert_error(elsewhere, 409, "task_running", True)["message"])
        self.assertEqual(nothing_created, [])

    def test_runs_beyond_the_global_cap_are_refused_as_busy_and_retryable(self):
        gate, _ = self.gated()
        with mock.patch.object(self.task_runner, "MAX_CONCURRENT_RUNS", 2):
            with TestClient(self.module.app) as client:
                sids = {who: self.new_session(client, who) for who in (ADA, BOB, CY)}
                started = {who: self.start(client, sids[who], who, type="review", target=TARGET) for who in (ADA, BOB, CY)}
                nothing_created = self.call(client, "GET", f"/api/sessions/{sids[CY]}", CY).json()["tasks"]
                client.portal.call(gate.set)
                for who in (ADA, BOB):
                    self.finish(client, sids[who], who)
                later = self.start(client, sids[CY], CY, type="review", target=TARGET)
                self.finish(client, sids[CY], CY)

        self.assertEqual((started[ADA].status_code, started[BOB].status_code), (202, 202))
        self.assert_error(started[CY], 503, "agents_busy", True)
        self.assertEqual(nothing_created, [])
        self.assertEqual(later.status_code, 202)

    def test_nobody_can_follow_the_run_of_another_user(self):
        gate, _ = self.gated()
        with TestClient(self.module.app) as client:
            sid = self.new_session(client, ADA)
            self.start(client, sid, ADA, type="review", target=TARGET)
            other = self.call(client, "GET", f"/api/sessions/{sid}/tasks/1/events", BOB)
            client.portal.call(gate.set)
            own = self.finish(client, sid, ADA)

        self.assert_error(other, 404, "task_not_found", False)
        self.assertEqual(own["status"], "done")

    def test_azure_is_reached_as_the_user_who_asks_on_every_route_that_needs_it(self):
        seen = []
        original = self.health.as_user
        self.health.as_user = lambda caller: seen.append(caller.oid) or original(caller)
        with TestClient(self.module.app) as client:
            sid = self.new_session(client, CY)
            seen.clear()
            routes = [
                ("GET", "/api/health-models", None),
                ("GET", "/api/health-model", None),
                ("GET", "/api/entities/orders-api", None),
                ("GET", "/api/timeline", None),
                ("POST", "/api/entities/orders-api/health-reports", REPORT),
                ("POST", f"/api/sessions/{sid}/tasks", {"type": "review", "target": TARGET}),
            ]
            for method, path, body in routes:
                with self.subTest(route=f"{method} {path}"):
                    seen.clear()

                    response = self.call(client, method, path, CY, **({"json": body} if body else {}))

                    self.assertLess(response.status_code, 300, response.text)
                    self.assertTrue(seen and set(seen) == {CY}, seen)
            self.finish(client, sid, CY)


class DirectoryTests(EntraCase):
    def test_a_user_of_another_directory_is_served_and_is_not_the_home_user_with_the_same_object_id(self):
        token = other_directory(ADA)
        seen = []
        original = self.health.as_user
        self.health.as_user = lambda caller: seen.append(caller) or original(caller)

        with TestClient(self.module.app) as client:
            created = client.post("/api/sessions", json={"title": "Away"}, headers=bearer(token))
            home = self.new_session(client, ADA, title="Home")
            away = client.get("/api/sessions", headers=bearer(token)).json()["sessions"]
            at_home = self.call(client, "GET", "/api/sessions", ADA).json()["sessions"]
            stranger = client.get(f"/api/sessions/{home}", headers=bearer(token))
            catalog = client.get("/api/health-models", headers=bearer(token))

        self.assertEqual((created.status_code, catalog.status_code), (201, 200))
        self.assertEqual([s["title"] for s in away], ["Away"])
        self.assertEqual([s["title"] for s in at_home], ["Home"])
        self.assert_error(stranger, 404, "session_not_found", False)
        self.assertEqual([(c.oid, c.tenant_id, c.in_home_tenant) for c in seen], [(ADA, OTHER_TENANT, False)])
        self.assertEqual(asyncio.run(self.store.list_sessions(f"{OTHER_TENANT}/{ADA}"))[0]["id"], created.json()["id"])
        self.assertEqual([s["id"] for s in asyncio.run(self.store.list_sessions(ADA))], [home])

    def test_a_personal_account_is_refused_with_its_own_code_before_any_route_runs(self):
        consumers = self.config.CONSUMERS_TENANT_ID
        token = mint(tid=consumers, iss=f"https://login.microsoftonline.com/{consumers}/v2.0")
        routes = [("GET", "/api/sessions"), ("POST", "/api/sessions"), ("GET", "/api/health-models"), ("GET", "/api/health-model")]
        reached = []
        original = self.store.list_sessions
        self.store.list_sessions = lambda *args: reached.append(args) or original(*args)

        with TestClient(self.module.app) as client:
            for method, path in routes:
                with self.subTest(route=f"{method} {path}"):
                    response = client.request(method, path, headers=bearer(token), json={} if method == "POST" else None)

                    error = self.assert_error(response, 403, "personal_account", False)
                    self.assertIn("directory", error["message"])
                    self.assertNotIn("www-authenticate", response.headers)

        self.assertEqual(reached, [])

    def test_directories_can_be_limited_to_a_list_and_the_home_directory_is_always_on_it(self):
        rules = self.auth.TokenRules(TENANT, CLIENT, "access_as_user", frozenset({OTHER_TENANT}))
        third = "99999999-9999-9999-9999-999999999999"
        cases = [
            ("a listed directory", other_directory(), 200, None),
            ("the home directory", mint(), 200, None),
            ("a directory that is not listed", mint(tid=third, iss=f"https://login.microsoftonline.com/{third}/v2.0"), 403, "tenant_not_allowed"),
        ]
        with mock.patch.object(self.module, "authenticator", self.auth.Authenticator(rules, self.module.authenticator._keys)):
            with TestClient(self.module.app) as client:
                for label, token, status, code in cases:
                    with self.subTest(label=label):
                        response = client.get("/api/sessions", headers=bearer(token))

                        if code:
                            self.assert_error(response, status, code, False)
                        self.assertEqual(response.status_code, status)

    def test_the_token_broker_exchanges_in_the_directory_of_the_user_who_started_the_task(self):
        gate, sent = self.gated()
        away = other_directory(BOB)
        with TestClient(self.module.app) as client:
            home, abroad = self.new_session(client, ADA), client.post("/api/sessions", json={}, headers=bearer(away)).json()["id"]
            self.start(client, home, ADA, type="review", target=TARGET)
            first = self.nonce(sent, 1)
            client.post(f"/api/sessions/{abroad}/tasks", json={"type": "review", "target": TARGET}, headers=bearer(away))
            second = self.nonce(sent, 2)
            answers = [self.agent_call(client, {"nonce": nonce}) for nonce in (first, second)]
            client.portal.call(gate.set)
            self.finish(client, home)

        self.assertEqual([r.status_code for r in answers], [200, 200])
        self.assertEqual(self.credentials.directories, [TENANT, OTHER_TENANT])
        self.assertEqual([entry[0] for entry in self.credentials.asked], [ADA, BOB])

    def test_a_design_task_is_only_for_users_of_the_directory_the_app_belongs_to(self):
        with TestClient(self.module.app) as client:
            home = self.start(client, self.new_session(client, ADA), ADA, type="design")
            abroad_session = client.post("/api/sessions", json={}, headers=bearer(other_directory())).json()["id"]
            abroad = client.post(f"/api/sessions/{abroad_session}/tasks", json={"type": "design"}, headers=bearer(other_directory()))

        self.assertEqual(home.status_code, 202)
        self.assert_error(abroad, 403, "design_unavailable", False)

    def test_a_task_of_another_directory_cannot_name_a_model_without_a_subscription(self):
        with TestClient(self.module.app) as client:
            session = client.post("/api/sessions", json={}, headers=bearer(other_directory())).json()["id"]
            response = client.post(
                f"/api/sessions/{session}/tasks",
                json={"type": "review", "target": {"resourceGroup": GROUP, "name": MODEL}},
                headers=bearer(other_directory()),
            )

        self.assert_error(response, 400, "unknown_model", False)


class BrokerTests(EntraCase):
    def test_the_broker_checks_in_a_fixed_order(self):
        unknown = {"nonce": "n" * 43}
        cases = [
            ("no credentials, no identity, a bad body", {}, "", b"junk", 401, "unauthenticated"),
            ("a user token", bearer(mint(ADA)), AGENT, json.dumps(unknown).encode(), 401, "unauthenticated"),
            ("a token of another tenant", bearer(app_token(tid=OTHER_TENANT, iss=f"https://login.microsoftonline.com/{OTHER_TENANT}/v2.0")), AGENT, b"junk", 401, "unauthenticated"),
            ("the agent, no identity configured, a bad body", bearer(app_token()), "", b"junk", 503, "agent_identity_not_configured"),
            ("another identity, a bad body", bearer(app_token(STRANGER)), AGENT, b"junk", 403, "forbidden"),
            ("the agent, text that is no json", bearer(app_token()), AGENT, b"junk", 400, "invalid_json"),
            ("the agent, a json array", bearer(app_token()), AGENT, b"[]", 400, "invalid_json"),
            ("the agent, no nonce", bearer(app_token()), AGENT, b"{}", 400, "invalid_nonce"),
            ("the agent, an unknown nonce", bearer(app_token()), AGENT, json.dumps(unknown).encode(), 404, "unknown_task"),
        ]
        with TestClient(self.module.app) as client:
            for label, headers, principal, body, status, code in cases:
                with self.subTest(label=label), mock.patch.object(self.module, "AGENT_PRINCIPAL_ID", principal):
                    response = client.post("/api/agent/token", content=body, headers={**headers, "Content-Type": "application/json"})

                    self.assert_error(response, status, code)
                    self.assertEqual(response.headers.get("www-authenticate"), "Bearer" if status == 401 else None)

        self.assertEqual(self.credentials.asked, [])

    def test_the_agent_identity_is_compared_in_any_letter_case(self):
        cases = [
            ("the token in capitals", AGENT.upper(), AGENT),
            ("the setting in capitals", AGENT, AGENT.upper()),
            ("both in capitals", AGENT.upper(), AGENT.upper()),
            ("the setting with spaces", AGENT, f" {AGENT} "),
        ]
        with TestClient(self.module.app) as client:
            for label, oid, principal in cases:
                with self.subTest(label=label), mock.patch.object(self.module, "AGENT_PRINCIPAL_ID", principal.strip()):
                    response = self.agent_call(client, {"nonce": "n" * 43}, bearer(app_token(oid)))

                    self.assert_error(response, 404, "unknown_task")

    def test_the_body_must_carry_a_plausible_nonce(self):
        cases = [
            ("no body", b"", "application/json", 400, "invalid_nonce"),
            ("an empty nonce", b'{"nonce": ""}', "application/json", 400, "invalid_nonce"),
            ("a number", b'{"nonce": 5}', "application/json", 400, "invalid_nonce"),
            ("null", b'{"nonce": null}', "application/json", 400, "invalid_nonce"),
            ("a list", b'{"nonce": ["a"]}', "application/json", 400, "invalid_nonce"),
            ("a nonce that is too long", json.dumps({"nonce": "n" * 129}).encode(), "application/json", 400, "invalid_nonce"),
            ("a nonce that is not ascii", json.dumps({"nonce": "é" * 43}).encode(), "application/json", 400, "invalid_nonce"),
            ("a lone surrogate", b'{"nonce": "\\ud800"}', "application/json", 400, "invalid_nonce"),
            ("the longest nonce", json.dumps({"nonce": "n" * 128}).encode(), "application/json", 404, "unknown_task"),
            ("not json", b"nonce=abc", "application/json", 400, "invalid_json"),
            ("another content type", b'{"nonce": "abc"}', "text/plain", 415, "json_required"),
        ]
        with TestClient(self.module.app) as client:
            for label, body, content_type, status, code in cases:
                with self.subTest(label=label):
                    response = client.post(
                        "/api/agent/token", content=body, headers={**bearer(app_token()), "Content-Type": content_type}
                    )

                    self.assert_error(response, status, code)

    def test_the_nonce_works_while_the_task_runs_and_not_after_it_ends(self):
        gate, sent = self.gated()
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, ADA, type="review", target=TARGET)
            nonce = self.nonce(sent)
            during = self.agent_call(client, {"nonce": nonce})
            wrong = self.agent_call(client, {"nonce": nonce[:-1] + ("a" if nonce[-1] != "a" else "b")})
            client.portal.call(gate.set)
            self.finish(client, sid)
            after = self.agent_call(client, {"nonce": nonce})

        self.assertRegex(nonce, r"^[A-Za-z0-9_-]{43,}$")
        self.assertEqual(during.status_code, 200, during.text)
        self.assertEqual(during.json(), {"accessToken": f"mcp-token-of-{ADA}", "expiresOn": NOW + 3600})
        self.assertIsInstance(during.json()["expiresOn"], int)
        self.assertEqual(during.headers["cache-control"], "no-store")
        self.assert_error(wrong, 404, "unknown_task", False)
        self.assert_error(after, 404, "unknown_task", False)

    def test_a_token_is_issued_for_the_user_who_started_that_task_with_the_assertion_that_started_it(self):
        gate, sent = self.gated()
        first, newer = mint(ADA, jti="first"), mint(ADA, jti="newer")
        with TestClient(self.module.app) as client:
            ada, bob = self.new_session(client, ADA), self.new_session(client, BOB)
            client.post(f"/api/sessions/{ada}/tasks", json={"type": "review", "target": TARGET}, headers=bearer(first))
            nonces = {ADA: self.nonce(sent, 1)}
            client.get("/api/sessions", headers=bearer(newer))
            self.start(client, bob, BOB, type="review", target=TARGET)
            nonces[BOB] = self.nonce(sent, 2)
            answers = {who: self.agent_call(client, {"nonce": nonce}) for who, nonce in nonces.items()}
            client.portal.call(gate.set)
            self.finish(client, ada)
            self.finish(client, bob, BOB)

        self.assertNotEqual(*nonces.values())
        self.assertEqual({who: r.json()["accessToken"] for who, r in answers.items()}, {ADA: f"mcp-token-of-{ADA}", BOB: f"mcp-token-of-{BOB}"})
        self.assertEqual(
            self.credentials.asked,
            [(ADA, first, (MCP_SCOPE,), None), (BOB, mint(BOB), (MCP_SCOPE,), None)],
        )

    def test_the_broker_is_limited_per_task(self):
        gate, sent = self.gated()
        with mock.patch.object(self.task_runner, "BROKER_CALLS_PER_MINUTE", 2):
            with TestClient(self.module.app) as client:
                ada, bob = self.new_session(client, ADA), self.new_session(client, BOB)
                self.start(client, ada, ADA, type="review", target=TARGET)
                one = self.nonce(sent, 1)
                self.start(client, bob, BOB, type="review", target=TARGET)
                two = self.nonce(sent, 2)
                answers = [self.agent_call(client, {"nonce": one}).status_code for _ in range(3)]
                other = self.agent_call(client, {"nonce": two})
                limited = self.agent_call(client, {"nonce": one})
                client.portal.call(gate.set)
                self.finish(client, ada)
                self.finish(client, bob, BOB)

        self.assertEqual(answers, [200, 200, 429])
        self.assertEqual(other.status_code, 200)
        self.assert_error(limited, 429, "rate_limited", True)

    def test_refusals_of_the_token_exchange_reach_the_agent_with_their_own_codes(self):
        interaction = self.obo.InteractionRequired(CLAIMS)
        cases = [
            ("interaction with claims", interaction, 401, "interaction_required", CLAIMS),
            ("interaction without claims", self.obo.InteractionRequired(None), 401, "interaction_required", None),
            ("missing consent", self.obo.ConsentRequired(), 403, "consent_required", None),
            ("another refusal", ClientAuthenticationError(message="x"), 502, "token_exchange_failed", None),
            ("an exchange that cannot run", ServiceRequestError("down"), 503, "token_unavailable", None),
        ]
        gate, sent = self.gated()
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, ADA, type="review", target=TARGET)
            nonce = self.nonce(sent)
            for label, error, status, code, claims in cases:
                with self.subTest(label=label):
                    self.credentials.error = error

                    response = self.agent_call(client, {"nonce": nonce})

                    body = self.assert_error(response, status, code)
                    self.assertEqual(body.get("claims"), claims)
                    self.assertNotIn("SECRET", response.text)
                    if code == "interaction_required":
                        expected = 'Bearer error="insufficient_claims"'
                        if claims:
                            expected += f', claims="{base64.b64encode(claims.encode()).decode()}"'
                        self.assertEqual(response.headers["www-authenticate"], expected)
            self.credentials.error = None
            client.portal.call(gate.set)
            self.finish(client, sid)

    def test_a_user_token_cannot_use_the_broker_and_an_agent_token_cannot_use_user_routes(self):
        with TestClient(self.module.app) as client:
            broker = client.post("/api/agent/token", json={"nonce": "n" * 43}, headers=bearer(mint(AGENT)))
            routes = client.get("/api/sessions", headers=bearer(app_token()))

        self.assert_error(broker, 401, "unauthenticated", False)
        self.assert_error(routes, 401, "unauthenticated", False)

    def test_the_broker_hands_out_nothing_without_a_running_task_even_to_the_agent(self):
        with TestClient(self.module.app) as client:
            self.review(client)
            response = self.agent_call(client, {"nonce": "n" * 43})

        self.assert_error(response, 404, "unknown_task")
        self.assertEqual(self.credentials.asked, [])


class DelegatedAccessTests(EntraCase):
    def refusals(self):
        return [
            ("sign in again", self.obo.InteractionRequired(CLAIMS), 401, "interaction_required", CLAIMS),
            ("sign in again without claims", self.obo.InteractionRequired(None), 401, "interaction_required", None),
            ("consent", self.obo.ConsentRequired(), 403, "consent_required", None),
        ]

    def test_refusals_of_the_on_behalf_of_exchange_become_401_or_403_on_every_azure_route(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            routes = [
                ("the catalog", "GET", "/api/health-models", None),
                ("the model", "GET", "/api/health-model", None),
                ("an entity", "GET", "/api/entities/orders-api", None),
                ("the timeline", "GET", "/api/timeline", None),
                ("a health report", "POST", "/api/entities/orders-api/health-reports", REPORT),
                ("a task", "POST", f"/api/sessions/{sid}/tasks", {"type": "review", "target": TARGET}),
                ("a selected model", "GET", f"/api/health-model?model={MODEL}&resourceGroup={GROUP}", None),
            ]
            for label, error, status, code, claims in self.refusals():
                for name in ("query_models", "has_model", "client", "read_model"):
                    setattr(self.health, name, self.raiser(error))
                for route, method, path, body in routes:
                    with self.subTest(refusal=label, route=route):
                        response = self.call(client, method, path, ADA, **({"json": body} if body else {}))

                        body_error = self.assert_error(response, status, code, False)
                        self.assertEqual(body_error.get("claims"), claims)
                        challenge = response.headers.get("www-authenticate")
                        if code == "interaction_required":
                            self.assertTrue(challenge.startswith('Bearer error="insufficient_claims"'))
                            self.assertEqual("claims=" in challenge, claims is not None)
                        else:
                            self.assertIsNone(challenge)
                        self.assertEqual(asyncio.run(self.store.list_tasks(ADA, sid)), [])

    def test_an_exchange_that_cannot_run_is_a_json_503_on_every_azure_route_and_for_every_directory(self):
        named = f"?model={MODEL}&resourceGroup={GROUP}&subscription={SUB}"
        callers = [  # a user of the apps own directory falls back to the apps model when the catalog cannot be read: no error there
            ("the apps own directory, default model", bearer(mint(ADA)), "", []),
            ("the apps own directory, named model", bearer(mint(ADA)), named, []),
            ("another directory, named model", bearer(other_directory()), named, [("the catalog", "GET", "/api/health-models", None)]),
        ]
        with TestClient(self.module.app) as client:
            for name in ("query_models", "has_model", "client", "read_model"):
                setattr(self.health, name, self.raiser(ServiceRequestError("SECRET down")))
            for who, headers, selector, catalog in callers:
                sid = client.post("/api/sessions", json={}, headers=headers).json()["id"]
                routes = catalog + [
                    ("the model", "GET", f"/api/health-model{selector}", None),
                    ("the live stream", "GET", f"/api/health-model/stream{selector}", None),
                    ("an entity", "GET", f"/api/entities/orders-api{selector}", None),
                    ("the timeline", "GET", f"/api/timeline{selector}", None),
                    ("a health report", "POST", f"/api/entities/orders-api/health-reports{selector}", REPORT),
                    ("a task", "POST", f"/api/sessions/{sid}/tasks", {"type": "review", "target": TARGET}),
                ]
                for route, method, path, body in routes:
                    with self.subTest(caller=who, route=route), self.assertLogs("ahm-demo", level="WARNING"):
                        response = self.call(client, method, path, None, headers=headers, **({"json": body} if body else {}))

                        self.assert_error(response, 503, "health_model_unavailable", True)
                        self.assertNotIn("SECRET", response.text)

    def raiser(self, error):
        def raise_it(*args, **kwargs):
            raise error

        return raise_it

    def test_the_claims_challenge_is_a_base64_header_and_the_raw_text_in_the_body(self):
        self.health.query_models = self.raiser(self.obo.InteractionRequired(CLAIMS))
        with TestClient(self.module.app) as client:
            response = self.call(client, "GET", "/api/health-models")

        header = response.headers["www-authenticate"]
        encoded = re.search(r'claims="([^"]+)"', header).group(1)
        self.assertEqual(base64.b64decode(encoded).decode(), CLAIMS)
        self.assertEqual(response.json()["error"]["claims"], CLAIMS)

    def test_a_consent_refusal_names_the_admin_step(self):
        self.health.query_models = self.raiser(self.obo.ConsentRequired())
        with TestClient(self.module.app) as client:
            response = self.call(client, "GET", "/api/health-models")

        message = response.json()["error"]["message"]
        self.assertIn("administrator of your directory", message)
        self.assertNotIn("az ad", message)

    def test_a_task_whose_exchange_is_refused_while_it_runs_ends_failed_with_the_matching_code(self):
        cases = [
            ("sign in again", self.obo.InteractionRequired(CLAIMS), "interaction_required"),
            ("consent", self.obo.ConsentRequired(), "consent_required"),
        ]
        for label, error, code in cases:
            with self.subTest(label=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                self.health.read_model = self.raiser(error)
                with TestClient(self.module.app) as client:
                    sid = self.new_session(client)
                    started = self.start(client, sid, ADA, type="review", target=TARGET)
                    task = self.finish(client, sid)
                    stream = self.call(client, "GET", f"/api/sessions/{sid}/tasks/1/events")

                self.assertEqual(started.status_code, 202)
                self.assertEqual((task["status"], task["error"]["code"]), ("failed", code))
                self.assertEqual(json.loads(frames(stream.text)[-1]["data"])["error"]["code"], code)
                self.assertNotIn(CLAIMS, json.dumps(task))

    def test_other_failures_to_reach_azure_keep_their_existing_mapping(self):
        error = ClientAuthenticationError(message="SECRET")
        error.status_code = 401
        self.health.client = self.raiser(error)
        with TestClient(self.module.app) as client:
            with self.assertLogs("ahm-demo", level="WARNING"):
                response = self.call(client, "GET", "/api/health-model")

        self.assert_error(response, 503, "health_model_access_unavailable", False)
        self.assertNotIn("SECRET", response.text)


if __name__ == "__main__":
    unittest.main()
