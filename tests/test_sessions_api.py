import asyncio
import importlib
import inspect
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from azure.core.exceptions import HttpResponseError, ServiceRequestError, ServiceResponseError
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind

SUB = "11111111-1111-1111-1111-111111111111"
OTHER_SUB = "22222222-2222-2222-2222-222222222222"
GROUP = "rg-ahm-demo"
MODEL = "hm-ahm-demo"
DESIGN = "hm-ahm-demo-design"
TARGET = {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL}
APP_MODULES = (
    "main", "config", "dto", "inventory", "reports", "errors", "healthmodels", "model_diff", "activity",
    "sessions_store", "foundry_agent", "fake_agent", "fixture_models", "task_runner", "apply", "auth", "obo",
)
TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ4In0.c2lnbmF0dXJl"
OWNER = "local"


def frames(body):
    result = []
    for block in body.split("\n\n"):
        if not block.strip():
            continue
        frame = {}
        for line in block.split("\n"):
            if line.startswith(":"):
                frame.setdefault("comments", []).append(line)
            elif ":" in line:
                name, value = line.split(":", 1)
                frame[name] = value.lstrip(" ")
        result.append(frame)
    return result


def azure_error(status):
    error = HttpResponseError(message="SECRET_AZURE_BODY")
    error.status_code = status
    return error


class ApiCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dist = tempfile.TemporaryDirectory()
        dist = Path(cls.dist.name)
        (dist / "assets").mkdir()
        (dist / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
        cls.environment = {
            "AUTH_MODE": "local",
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": "InstrumentationKey=00000000-0000-0000-0000-000000000000",
            "AZURE_SUBSCRIPTION_ID": SUB,
            "AZURE_RESOURCE_GROUP": GROUP,
            "HEALTH_MODEL_NAME": MODEL,
            "HEALTH_MODEL_DESIGN_NAME": DESIGN,
            "SESSIONS_CONTAINER_URL": "memory:",
            "FOUNDRY_PROJECT_ENDPOINT": "fake:",
            "FOUNDRY_AGENT_NAME": "health-model-agent",
            "UI_DIST_DIR": str(dist),
        }
        cls.env_patch = mock.patch.dict(os.environ, cls.environment)
        cls.env_patch.start()
        cls.spans = InMemorySpanExporter()
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
        provider.add_span_processor(SimpleSpanProcessor(cls.spans))
        cls.patchers = [
            mock.patch("azure.identity.DefaultAzureCredential", return_value=mock.Mock()),
            mock.patch("azure.monitor.opentelemetry.configure_azure_monitor"),
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
        self.spans.clear()

    def install(self, agent):
        self.store = self.sessions_store.MemorySessionsStore()
        self.health = self.fixture_models.FixtureHealthModels((SUB, GROUP, MODEL), (SUB, GROUP, DESIGN))
        self.agent = agent
        self.module.store, self.module.agent, self.module.health = self.store, agent, self.health
        self.module.runner = self.task_runner.TaskRunner(self.store, agent, self.health)

    def new_session(self, client, **body):
        response = client.post("/api/sessions", json=body)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def start(self, client, sid, **body):
        return client.post(f"/api/sessions/{sid}/tasks", json=body)

    def finish(self, client, sid, seq=1):
        client.get(f"/api/sessions/{sid}/tasks/{seq}/events")
        return client.get(f"/api/sessions/{sid}/tasks/{seq}").json()

    def post_apply(self, client, sid, ids, seq=1):
        return client.post(f"/api/sessions/{sid}/tasks/{seq}/apply", json={"changeIds": ids})

    def review(self, client):
        sid = self.new_session(client)
        self.assertEqual(self.start(client, sid, type="review", target=TARGET).status_code, 202)
        task = self.finish(client, sid)
        self.assertEqual(task["status"], "done", task.get("error"))
        return sid

    def recovered(self, client):
        async def wait():
            await self.module.app.state.recovery

        client.portal.call(wait)

    def seed_task(self, status="running", age=600, events=1, title="Crashed"):
        async def seed():
            session = await self.store.create_session(OWNER, title)
            created = self.dto.iso(datetime.now(timezone.utc) - timedelta(seconds=age))
            await self.store.create_task(OWNER, session["id"], {"type": "review", "status": status, "target": TARGET, "instruction": "", "createdAt": created})
            for seq in range(1, events + 1):
                await self.store.append_event(OWNER, session["id"], 1, {"seq": seq, "ts": created, "kind": "status", "summary": f"e{seq}", "payload": {}})
            return session["id"]

        return asyncio.run(seed())

    def spy(self, names):
        calls = []
        for name in names:
            original = getattr(self.health, name)

            def wrapper(*args, _name=name, _original=original, **kwargs):
                calls.append((_name, args, threading.get_ident()))
                return _original(*args, **kwargs)

            setattr(self.health, name, wrapper)
        return calls


class SessionRouteTests(ApiCase):
    def test_creating_a_session_defaults_the_title_and_returns_the_summary(self):
        with TestClient(self.module.app) as client:
            created = client.post("/api/sessions", json={})
            named = client.post("/api/sessions", json={"title": "  Quarterly review  "})
            bare = client.post("/api/sessions")

        self.assertEqual(created.status_code, 201)
        body = created.json()
        self.assertEqual(set(body), {"id", "title", "createdAt", "taskCount", "lastTaskAt"})
        self.assertRegex(body["id"], r"^[0-9a-f]{12}$")
        self.assertRegex(body["title"], r"^Session \d{4}-\d\d-\d\d \d\d:\d\d$")
        self.assertEqual((body["taskCount"], body["lastTaskAt"]), (0, None))
        self.assertEqual(named.json()["title"], "Quarterly review")
        self.assertEqual(bare.status_code, 201)
        self.assertNotIn("conversationId", json.dumps(body))

    def test_invalid_session_requests_are_rejected_without_creating_anything(self):
        cases = [
            ("title not text", {"json": {"title": 5}}, 400, "invalid_title"),
            ("title only blanks", {"json": {"title": "   "}}, 400, "invalid_title"),
            ("title too long", {"json": {"title": "x" * 121}}, 400, "invalid_title"),
            ("title with a lone surrogate", {"content": json.dumps({"title": "half \ud83d"}).encode(), "headers": {"content-type": "application/json"}}, 400, "invalid_title"),
            ("not json content type", {"content": b"{}", "headers": {"content-type": "text/plain"}}, 415, "json_required"),
            ("invalid json", {"content": b"{oops", "headers": {"content-type": "application/json"}}, 400, "invalid_json"),
            ("json array", {"content": b"[]", "headers": {"content-type": "application/json"}}, 400, "invalid_json"),
        ]
        with TestClient(self.module.app) as client:
            for label, arguments, status, code in cases:
                with self.subTest(label=label):
                    response = client.post("/api/sessions", **arguments)

                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json()["error"]["code"], code)
            self.assertEqual(client.get("/api/sessions").json(), {"sessions": []})

    def test_a_listed_session_names_its_running_task_so_no_task_has_to_be_scanned_for(self):
        with TestClient(self.module.app) as client:
            quiet = self.new_session(client, title="Quiet")
            running = self.seed_task(status="running")
            done = self.seed_task(status="done", title="Done")
            listed = {item["id"]: item for item in client.get("/api/sessions").json()["sessions"]}

        self.assertEqual({sid: item["openTask"] for sid, item in listed.items()}, {quiet: None, running: 1, done: None})

    def test_exactly_120_characters_are_allowed(self):
        with TestClient(self.module.app) as client:
            self.assertEqual(client.post("/api/sessions", json={"title": "x" * 120}).status_code, 201)

    def test_sessions_are_listed_most_recent_first_with_counts(self):
        with TestClient(self.module.app) as client:
            older = self.new_session(client, title="Older")
            time.sleep(0.01)
            newer = self.new_session(client, title="Newer")
            first = client.get("/api/sessions").json()["sessions"]
            time.sleep(0.01)
            self.start(client, older, type="review", target=TARGET)
            self.finish(client, older)
            second = client.get("/api/sessions").json()["sessions"]

        self.assertEqual([s["id"] for s in first], [newer, older])
        self.assertEqual([s["id"] for s in second], [older, newer])
        self.assertEqual((second[0]["taskCount"], second[1]["taskCount"]), (1, 0))
        self.assertIsNotNone(second[0]["lastTaskAt"])

    def test_a_session_shows_its_tasks_without_their_results(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            detail = client.get(f"/api/sessions/{sid}")

        body = detail.json()
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(set(body), {"session", "tasks"})
        self.assertEqual(body["session"]["taskCount"], 1)
        self.assertIsNotNone(body["session"]["lastTaskAt"])
        (task,) = body["tasks"]
        self.assertEqual(task["status"], "done")
        self.assertNotIn("result", task)
        self.assertIn("base", task)

    def test_unknown_or_malformed_ids_are_not_found(self):
        paths = [
            "/api/sessions/nope",
            "/api/sessions/bad.id",
            "/api/sessions/nope/tasks/1",
            "/api/sessions/nope/tasks/1/events",
            "/api/sessions/nope/tasks/1/diff",
        ]
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            paths += [f"/api/sessions/{sid}/tasks/1", f"/api/sessions/{sid}/tasks/abc", f"/api/sessions/{sid}/tasks/-1",
                      f"/api/sessions/{sid}/tasks/1.5", f"/api/sessions/{sid}/tasks/%C2%B2", f"/api/sessions/{sid}/tasks/1/diff"]
            for path in paths:
                with self.subTest(path=path):
                    response = client.get(path)

                    self.assertEqual(response.status_code, 404)
                    self.assertIn(response.json()["error"]["code"], {"session_not_found", "task_not_found", "diff_not_found"})
            self.assertEqual(client.post("/api/sessions/nope/tasks", json={"type": "review"}).status_code, 404)

    def test_malformed_ids_never_reach_the_store(self):
        reached = []
        for name in ("get_session", "get_task", "list_tasks", "read_events", "load_base", "read_applies"):
            original = getattr(self.store, name)

            async def spy(*args, _name=name, _original=original):
                reached.append((_name, args))
                return await _original(*args)

            setattr(self.store, name, spy)
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            reached.clear()
            for path in ("/api/sessions/bad.id", "/api/sessions/bad.id/tasks/1", "/api/sessions/a..b/tasks/1/events",
                         f"/api/sessions/{sid}/tasks/abc", f"/api/sessions/{sid}/tasks/1x/diff", f"/api/sessions/{sid}/tasks/%C2%B2",
                         f"/api/sessions/{sid}%0A", f"/api/sessions/{sid}%0A/tasks/1", f"/api/sessions/{sid}/tasks/1%0A",
                         f"/api/sessions/{sid}/tasks/{'9' * 5000}", f"/api/sessions/{sid}/tasks/1234567890/events"):
                with self.subTest(path=path):
                    self.assertEqual(client.get(path).status_code, 404)
            self.assertEqual(client.post("/api/sessions/bad.id/tasks", json={"type": "review"}).status_code, 404)
            self.assertEqual(client.post(f"/api/sessions/{sid}/tasks/x/apply", json={"changeIds": ["c1"]}).status_code, 404)

        self.assertEqual(reached, [])

    def test_a_failing_store_is_a_clear_retryable_503(self):
        async def broken(*args):
            raise self.sessions_store.StoreUnavailable("list_sessions")

        self.store.list_sessions = broken
        with self.assertLogs("ahm-demo", level="WARNING"):
            with TestClient(self.module.app) as client:
                response = client.get("/api/sessions")

        error = response.json()["error"]
        self.assertEqual(response.status_code, 503)
        self.assertEqual((error["code"], error["retryable"]), ("sessions_unavailable", True))
        self.assertRegex(error["operationId"], r"^[0-9a-f]{32}$")
        self.assertEqual(response.headers["cache-control"], "no-store")


class TaskValidationTests(ApiCase):
    def check(self, client, sid, body, status, code=None):
        response = client.post(f"/api/sessions/{sid}/tasks", json=body)

        self.assertEqual(response.status_code, status, response.text)
        if code:
            self.assertEqual(response.json()["error"]["code"], code)
        return response

    def test_an_instruction_with_a_lone_surrogate_is_refused_before_anything_is_stored(self):
        bodies = [
            ("a review", {"type": "review", "target": TARGET}),
            ("a design", {"type": "design", "workload": {"resourceGroup": GROUP}}),
        ]
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            for label, body in bodies:
                with self.subTest(label):
                    response = client.post(
                        f"/api/sessions/{sid}/tasks",
                        content=json.dumps({**body, "instruction": "half \ud83d"}).encode(),
                        headers={"content-type": "application/json"},
                    )

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "invalid_instruction"))
            self.assertEqual(client.get(f"/api/sessions/{sid}").json()["tasks"], [])

    def test_every_task_request_rule(self):
        long_ok, long_bad = "x" * 2000, "x" * 2001
        cases = [
            ("no type", {}, 400, "invalid_task_type"),
            ("unknown type", {"type": "chat", "target": TARGET}, 400, "invalid_task_type"),
            ("type not text", {"type": ["review"], "target": TARGET}, 400, "invalid_task_type"),
            ("review without target", {"type": "review"}, 400, "unknown_model"),
            ("target not an object", {"type": "review", "target": "hm"}, 400, "unknown_model"),
            ("target without name", {"type": "review", "target": {"resourceGroup": GROUP}}, 400, "unknown_model"),
            ("target without group", {"type": "review", "target": {"name": MODEL}}, 400, "unknown_model"),
            ("unknown model", {"type": "review", "target": {**TARGET, "name": "hm-ghost"}}, 400, "unknown_model"),
            ("unknown group", {"type": "review", "target": {**TARGET, "resourceGroup": "rg-ghost"}}, 400, "unknown_model"),
            ("unseen subscription", {"type": "review", "target": {**TARGET, "subscriptionId": OTHER_SUB}}, 400, "unknown_model"),
            ("subscription not text", {"type": "review", "target": {**TARGET, "subscriptionId": 5}}, 400, "unknown_model"),
            ("name not text", {"type": "review", "target": {**TARGET, "name": 5}}, 400, "unknown_model"),
            ("blank name and group", {"type": "review", "target": {"name": "", "resourceGroup": ""}}, 400, "unknown_model"),
            ("blank name", {"type": "review", "target": {**TARGET, "name": ""}}, 400, "unknown_model"),
            ("empty target", {"type": "review", "target": {}}, 400, "unknown_model"),
            ("blank subscription falls back to the configured one", {"type": "review", "target": {**TARGET, "subscriptionId": ""}}, 202, None),
            ("review ok", {"type": "review", "target": TARGET}, 202, None),
            ("subscription defaults to the configured one", {"type": "review", "target": {"resourceGroup": GROUP, "name": MODEL}}, 202, None),
            ("design model is reviewable", {"type": "review", "target": {**TARGET, "name": DESIGN}}, 202, None),
            ("instruction at the limit", {"type": "review", "target": TARGET, "instruction": long_ok}, 202, None),
            ("instruction too long", {"type": "review", "target": TARGET, "instruction": long_bad}, 400, "invalid_instruction"),
            ("instruction not text", {"type": "review", "target": TARGET, "instruction": 5}, 400, "invalid_instruction"),
            ("instruction null", {"type": "review", "target": TARGET, "instruction": None}, 202, None),
            ("explain without entity", {"type": "explain", "target": TARGET}, 400, "entity_required"),
            ("explain blank entity", {"type": "explain", "target": {**TARGET, "entity": "  "}}, 400, "entity_required"),
            ("explain entity not text", {"type": "explain", "target": {**TARGET, "entity": 3}}, 400, "entity_required"),
            ("explain unknown entity", {"type": "explain", "target": {**TARGET, "entity": "ghost"}}, 400, "unknown_entity"),
            ("explain ok", {"type": "explain", "target": {**TARGET, "entity": "orders-api"}}, 202, None),
            ("explain with unknown model", {"type": "explain", "target": {**TARGET, "name": "hm-ghost", "entity": "x"}}, 400, "unknown_model"),
            ("design without workload", {"type": "design"}, 202, None),
            ("design with a null workload", {"type": "design", "workload": None}, 202, None),
            ("design workload not an object", {"type": "design", "workload": "rg"}, 400, "invalid_workload"),
            ("design other group", {"type": "design", "workload": {"resourceGroup": "rg-other"}}, 400, "invalid_workload"),
            ("design group not text", {"type": "design", "workload": {"resourceGroup": 5}}, 400, "invalid_workload"),
            ("design group in other case", {"type": "design", "workload": {"resourceGroup": GROUP.upper()}}, 202, None),
            ("subscription is not a guid", {"type": "review", "target": {**TARGET, "subscriptionId": "not-a-guid"}}, 400, "unknown_model"),
            ("subscription with a trailing newline", {"type": "review", "target": {**TARGET, "subscriptionId": SUB + "\n"}}, 400, "unknown_model"),
            ("model with a trailing newline", {"type": "review", "target": {**TARGET, "name": MODEL + "\n"}}, 400, "unknown_model"),
            ("group with a trailing newline", {"type": "review", "target": {**TARGET, "resourceGroup": GROUP + "\n"}}, 400, "unknown_model"),
            ("group with a slash", {"type": "review", "target": {**TARGET, "resourceGroup": "rg/x"}}, 400, "unknown_model"),
            ("group of 91 characters", {"type": "review", "target": {**TARGET, "resourceGroup": "g" * 91}}, 400, "unknown_model"),
            ("model of 261 characters", {"type": "review", "target": {**TARGET, "name": "m" * 261}}, 400, "unknown_model"),
            ("model of one character", {"type": "review", "target": {**TARGET, "name": "m"}}, 400, "unknown_model"),
            ("model starting with a hyphen", {"type": "review", "target": {**TARGET, "name": "-hm"}}, 400, "unknown_model"),
        ]
        for url in ("https://github.com/o/r", "https://github.com/o/r.git", "https://github.com/o-1/r_x.y/", "https://github.com/9/_r", ""):
            cases.append((f"design repository {url!r}", {"type": "design", "workload": {"resourceGroup": GROUP, "repositoryUrl": url}}, 202, None))
        for url in ("http://github.com/o/r", "https://gitlab.com/o/r", "https://github.com/o", "https://github.com/o/r?x=1",
                    "https://github.com/o/r; rm -rf /", "https://github.com/o/r$(id)", "git@github.com:o/r.git", "https://github.com/o/r/tree/main",
                    "https://github.com.evil.example/o/r", "https://github.com/o/r\nnext", "https://github.com/o/r\n", "https://github.com/o/r.git\n", 5,
                    "https://github.com/-o/r", "https://github.com/o_1/r", "https://github.com/o.1/r", "https://github.com/o/.r", "https://github.com/o/-r",
                    "https://github.com/o/.git", "https://github.com/ o/r", " https://github.com/o/r"):
            cases.append((f"design repository {url!r}", {"type": "design", "workload": {"resourceGroup": GROUP, "repositoryUrl": url}}, 400, "invalid_repository_url"))

        for label, body, status, code in cases:
            with self.subTest(label=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.new_session(client)

                    self.check(client, sid, body, status, code)

                    self.assertEqual(len(self.run_tasks(sid)), 1 if status == 202 else 0)

    def run_tasks(self, sid):
        return asyncio.run(self.store.list_tasks(OWNER, sid))

    def test_an_accepted_task_is_returned_as_running_with_its_resolved_target(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            response = self.check(client, sid, {"type": "explain", "target": {"resourceGroup": GROUP, "name": MODEL, "entity": "orders-api"}, "instruction": "why?"}, 202)

        task = response.json()
        self.assertEqual(
            {k: v for k, v in task.items() if k != "createdAt"},
            {
                "id": "1", "sessionId": sid, "seq": 1, "type": "explain", "status": "running", "instruction": "why?",
                "target": {"subscriptionId": SUB, "resourceGroup": GROUP, "name": MODEL, "entity": "orders-api"},
            },
        )
        self.assertRegex(task["createdAt"], r"Z$")

    def test_a_design_task_ignores_the_clients_target_and_keeps_a_clean_workload(self):
        body = {"type": "design", "target": {"name": "hm-other", "resourceGroup": "rg-other", "subscriptionId": OTHER_SUB},
                "workload": {"resourceGroup": GROUP, "repositoryUrl": "https://github.com/o/r", "extra": "dropped"}}
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            task = self.check(client, sid, body, 202).json()

        self.assertEqual(task["target"], {"subscriptionId": SUB, "resourceGroup": GROUP, "name": DESIGN})
        self.assertEqual(task["workload"], {"resourceGroup": GROUP, "repositoryUrl": "https://github.com/o/r"})

    def test_a_design_task_without_a_repository_has_no_repository_key(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            task = self.check(client, sid, {"type": "design", "workload": {"resourceGroup": GROUP, "repositoryUrl": ""}}, 202).json()

        self.assertEqual(task["workload"], {"resourceGroup": GROUP})

    def test_only_json_objects_are_accepted(self):
        cases = [
            ("empty body", {}, 400, "invalid_task_type"),
            ("wrong content type", {"content": b'{"type": "review"}', "headers": {"content-type": "text/plain"}}, 415, "json_required"),
            ("invalid json", {"content": b"{", "headers": {"content-type": "application/json"}}, 400, "invalid_json"),
            ("array", {"content": b"[1]", "headers": {"content-type": "application/json"}}, 400, "invalid_json"),
        ]
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            for label, arguments, status, code in cases:
                with self.subTest(label=label):
                    response = client.post(f"/api/sessions/{sid}/tasks", **arguments)

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))

    def test_azure_problems_while_checking_the_target_are_mapped_not_hidden(self):
        original_client = self.health.client
        cases = [
            ("model lookup 500", "has_model", 500, 503, "health_model_unavailable"),
            ("model lookup 401", "has_model", 401, 503, "health_model_access_unavailable"),
            ("model lookup 429", "has_model", 429, 503, "health_model_busy"),
            ("entity lookup 403", "client", 403, 403, "forbidden"),
            ("entity lookup 500", "client", 500, 503, "health_model_unavailable"),
        ]
        for label, where, azure_status, status, code in cases:
            with self.subTest(label=label):
                def fail(*args, **kwargs):
                    raise azure_error(azure_status)

                self.health.has_model = type(self.health).has_model.__get__(self.health)
                self.health.client = original_client
                setattr(self.health, where, fail)
                body = {"type": "review" if where == "has_model" else "explain", "target": {**TARGET, "entity": "orders-api"}}
                with TestClient(self.module.app) as client:
                    sid = self.new_session(client)
                    with self.assertLogs("ahm-demo", level="WARNING"):
                        response = client.post(f"/api/sessions/{sid}/tasks", json=body)

                self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))
                self.assertNotIn("SECRET", response.text)
                self.install(self.fake_agent.FakeAgent(delay=0))

    def test_a_second_task_is_refused_while_one_runs_then_allowed(self):
        gate = asyncio.Event()

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        with TestClient(self.module.app) as client:
            sid, other = self.new_session(client), self.new_session(client)
            first = self.start(client, sid, type="review", target=TARGET)
            second = self.start(client, sid, type="review", target=TARGET)
            elsewhere = self.start(client, other, type="review", target=TARGET)
            detail = client.get(f"/api/sessions/{sid}").json()
            nothing_created = client.get(f"/api/sessions/{other}").json()["tasks"]
            client.portal.call(gate.set)
            self.finish(client, sid)
            third = self.start(client, sid, type="explain", target={**TARGET, "entity": "orders-api"})
            self.finish(client, sid, 2)
            later = self.start(client, other, type="review", target=TARGET)
            self.finish(client, other)

        self.assertEqual(first.status_code, 202)
        for label, refused, message in [
            ("in the same session", second, "already running in this session"),
            ("in another session of the same user", elsewhere, "another session"),
        ]:
            with self.subTest(label=label):
                error = refused.json()["error"]
                self.assertEqual(refused.status_code, 409)
                self.assertEqual((error["code"], error["retryable"]), ("task_running", True))
                self.assertIn(message, error["message"])
        self.assertEqual(len(detail["tasks"]), 1)
        self.assertEqual(nothing_created, [])
        self.assertEqual(third.status_code, 202)
        self.assertEqual(third.json()["seq"], 2)
        self.assertEqual(later.status_code, 202)

    def test_a_failing_store_while_creating_a_task_is_a_503_and_leaves_nothing_running(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)

            async def broken(*args, **kwargs):
                raise self.sessions_store.StoreUnavailable("create_task")

            original = self.store.create_task
            self.store.create_task = broken
            with self.assertLogs("ahm-demo", level="WARNING"):
                failed = self.start(client, sid, type="review", target=TARGET)
            self.store.create_task = original
            retry = self.start(client, sid, type="review", target=TARGET)

        self.assertEqual((failed.status_code, failed.json()["error"]["code"]), (503, "sessions_unavailable"))
        self.assertEqual(retry.status_code, 202)


class EventStreamTests(ApiCase):
    def test_a_finished_task_replays_every_event_then_done(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            response = client.get(f"/api/sessions/{sid}/tasks/1/events")

        parsed = frames(response.text)
        activity, done = parsed[:-1], parsed[-1]
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertTrue(all(f["event"] == "activity" for f in activity))
        self.assertEqual([int(f["id"]) for f in activity], list(range(1, len(activity) + 1)))
        events = [json.loads(f["data"]) for f in activity]
        self.assertEqual([e["seq"] for e in events], [int(f["id"]) for f in activity])
        self.assertEqual(events[0]["summary"], "Review task started")
        self.assertEqual({"status", "text", "tool_call", "tool_result", "result"}, {e["kind"] for e in events})
        self.assertEqual(events[-1]["summary"], "Result verified")
        self.assertEqual(done, {"event": "done", "data": '{"status":"done"}'})
        self.assertNotIn("id", done)

    def test_replay_resumes_after_the_last_event_id_from_the_header_or_the_query(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            total = len(frames(client.get(f"/api/sessions/{sid}/tasks/1/events").text)) - 1
            url = f"/api/sessions/{sid}/tasks/1/events"
            cases = [
                ("header", client.get(url, headers={"Last-Event-ID": "5"}), 5),
                ("query", client.get(f"{url}?lastEventId=7"), 7),
                ("header wins", client.get(f"{url}?lastEventId=2", headers={"Last-Event-ID": "9"}), 9),
                ("everything seen", client.get(url, headers={"Last-Event-ID": str(total)}), total),
                ("beyond the end", client.get(url, headers={"Last-Event-ID": "999"}), 999),
                ("nothing", client.get(url, headers={"Last-Event-ID": ""}), 0),
                ("nine digits", client.get(url, headers={"Last-Event-ID": "999999999"}), 999999999),
            ]

        for label, response, after in cases:
            with self.subTest(label=label):
                parsed = frames(response.text)

                self.assertEqual(parsed[-1]["event"], "done")
                self.assertEqual([int(f["id"]) for f in parsed[:-1]], list(range(after + 1, total + 1)))

    def test_a_failed_task_ends_with_done_carrying_the_error(self):
        class Failing(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                yield self.foundry_agent.StreamEvent("response.failed", {"response": {"error": {"code": "tool_start_failed", "message": "The MCP child exited."}}})

        self.install(Failing(delay=0))
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            with self.assertLogs("ahm-demo", level="WARNING"):
                self.start(client, sid, type="review", target=TARGET)
                parsed = frames(client.get(f"/api/sessions/{sid}/tasks/1/events").text)
            task = client.get(f"/api/sessions/{sid}/tasks/1").json()

        done = json.loads(parsed[-1]["data"])
        self.assertEqual(parsed[-1]["event"], "done")
        self.assertEqual(done, {"status": "failed", "error": {"code": "agent_failed", "message": "The MCP child exited."}})
        self.assertEqual(task["error"], done["error"])
        self.assertEqual([json.loads(f["data"])["kind"] for f in parsed[:-1]][-1], "error")

    def test_a_running_task_is_followed_live_with_keep_alives_until_it_ends(self):
        gate = asyncio.Event()

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                yield self.foundry_agent.StreamEvent("response.created", {"response": {"id": "r"}})
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        with mock.patch.object(self.module, "SSE_KEEP_ALIVE_SECONDS", 0.05):
            with TestClient(self.module.app) as client:
                sid = self.new_session(client)
                self.start(client, sid, type="review", target=TARGET)
                result = {}
                reader = threading.Thread(
                    target=lambda: result.update(response=client.get(f"/api/sessions/{sid}/tasks/1/events"))
                )
                reader.start()
                time.sleep(0.4)
                still_open = reader.is_alive()
                client.portal.call(gate.set)
                reader.join(10)

        body = result["response"].text
        parsed = frames(body)
        self.assertTrue(still_open)
        self.assertGreaterEqual(body.count(": keep-alive"), 2)
        events = [json.loads(f["data"]) for f in parsed if f.get("event") == "activity"]
        self.assertEqual([e["seq"] for e in events], list(range(1, len(events) + 1)))
        self.assertEqual(events[-1]["summary"], "Result verified")
        self.assertEqual(parsed[-1], {"event": "done", "data": '{"status":"done"}'})
        self.assertEqual(sum(1 for f in parsed if f.get("event") == "done"), 1)

    def test_a_reader_that_joins_late_gets_the_replay_without_duplicates_then_the_live_rest(self):
        gate = asyncio.Event()

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                yield self.foundry_agent.StreamEvent("response.created", {"response": {"id": "r"}})
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, type="review", target=TARGET)
            time.sleep(0.2)
            result = {}
            reader = threading.Thread(target=lambda: result.update(r=client.get(f"/api/sessions/{sid}/tasks/1/events", headers={"Last-Event-ID": "1"})))
            reader.start()
            time.sleep(0.2)
            client.portal.call(gate.set)
            reader.join(10)

        ids = [int(f["id"]) for f in frames(result["r"].text) if "id" in f]
        self.assertEqual(ids, list(range(2, ids[-1] + 1)))
        self.assertEqual(len(ids), len(set(ids)))


class DiffAndApplyCase(ApiCase):
    def written(self):
        calls = []
        for name in ("write_resource", "delete_resource"):
            original = getattr(self.health, name)

            def wrapper(sub, group, model, kind, resource, *rest, _name=name, _original=original):
                calls.append((_name, model, kind, resource))
                return _original(sub, group, model, kind, resource, *rest)

            setattr(self.health, name, wrapper)
        return calls

    def stored_diff(self, changes, target=None, base=None, status="done"):
        async def create():
            session = await self.store.create_session(OWNER, "Stored")
            base_raw = base or self.fixture_models.fixture_model(SUB, GROUP, MODEL)
            result = {"kind": "diff", "summary": "s", "changes": changes, "verification": [], "findings": []}
            task = await self.store.create_task(OWNER, session["id"], {
                "type": "review", "target": target or TARGET, "instruction": "", "createdAt": "2026-11-10T10:00:00Z",
                "status": status, "result": result,
                "base": {"modelId": "x", "fingerprint": self.model_diff.fingerprint(base_raw), "capturedAt": "t"},
            })
            await self.store.save_base(OWNER, session["id"], task["seq"], base_raw)
            return session["id"]

        return asyncio.run(create())


class DiffRouteTests(DiffAndApplyCase):
    def test_the_diff_of_a_finished_review_has_the_contract_shape(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            diff = client.get(f"/api/sessions/{sid}/tasks/1/diff")

        body = diff.json()
        self.assertEqual(diff.status_code, 200)
        self.assertEqual(set(body), {"base", "proposed", "changes", "verification", "findings", "summary", "target", "appliable", "applies"})
        self.assertEqual(body["target"], TARGET)
        self.assertTrue(body["appliable"])
        self.assertEqual(body["applies"], [])
        self.assertEqual((len(body["base"]["entities"]), len(body["proposed"]["entities"])), (5, 6))
        self.assertEqual([c["id"] for c in body["changes"]], ["c1", "c2", "c3", "c4"])
        by_id = {c["id"]: c for c in body["changes"]}
        self.assertEqual(by_id["c3"]["dependsOn"], ["c2", "c4"])
        self.assertEqual(by_id["c1"]["before"]["displayName"], "Orders API")
        self.assertEqual(by_id["c1"]["details"], [{"path": "displayName", "before": "Orders API", "after": "Orders API (reviewed)"}])
        self.assertEqual([r["entity"] for r in by_id["c3"]["verification"]], ["order-queue"])
        self.assertEqual({e["name"]: e["healthState"] for e in body["proposed"]["entities"]}["order-queue"], "Unknown")
        self.assertEqual(body["summary"], "Name the API clearly, and watch the order queue that sits behind it.")

    def test_properties_the_agent_never_sees_are_not_shown_as_removed(self):
        change = {"id": "c1", "op": "change", "kind": "entity", "name": "payments", "after": {"displayName": "Renamed"}, "reason": "r"}
        sid = self.stored_diff([change])
        with TestClient(self.module.app) as client:
            diff = client.get(f"/api/sessions/{sid}/tasks/1/diff").json()

        proposed = {e["name"]: e for e in diff["proposed"]["entities"]}["payments"]
        view = diff["changes"][0]
        self.assertEqual(proposed["canvasPosition"], {"x": 600, "y": 400})
        self.assertEqual(view["after"]["canvasPosition"], {"x": 600, "y": 400})
        self.assertEqual([d for d in view["details"] if d["path"].startswith("canvasPosition")], [])

    def test_only_a_finished_diff_task_has_a_diff(self):
        gate = asyncio.Event()

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, type="review", target=TARGET)
            running = client.get(f"/api/sessions/{sid}/tasks/1/diff")
            client.portal.call(gate.set)
            self.finish(client, sid)
            self.start(client, sid, type="explain", target={**TARGET, "entity": "orders-api"})
            self.finish(client, sid, 2)
            explain = client.get(f"/api/sessions/{sid}/tasks/2/diff")
            done = client.get(f"/api/sessions/{sid}/tasks/1/diff")

        self.assertEqual((running.status_code, running.json()["error"]["code"]), (404, "diff_not_found"))
        self.assertEqual((explain.status_code, explain.json()["error"]["code"]), (404, "diff_not_found"))
        self.assertEqual(done.status_code, 200)

    def test_a_failed_task_has_no_diff(self):
        sid = self.stored_diff([], status="failed")
        with TestClient(self.module.app) as client:
            self.assertEqual(client.get(f"/api/sessions/{sid}/tasks/1/diff").status_code, 404)

    def test_every_finished_diff_is_appliable_whatever_its_target(self):
        change = {"id": "c1", "op": "change", "kind": "entity", "name": "payments", "after": {"displayName": "x"}, "reason": "r"}
        cases = [
            ("other subscription", {**TARGET, "subscriptionId": OTHER_SUB}),
            ("other group", {**TARGET, "resourceGroup": "rg-elsewhere"}),
            ("same group in other case", {**TARGET, "resourceGroup": GROUP.upper()}),
            ("the design model", {**TARGET, "name": DESIGN}),
        ]
        for label, target in cases:
            with self.subTest(label=label):
                sid = self.stored_diff([change], target=target)
                with TestClient(self.module.app) as client:
                    diff = client.get(f"/api/sessions/{sid}/tasks/1/diff")

                self.assertEqual(diff.status_code, 200)
                self.assertIs(diff.json()["appliable"], True)


class OptionalFieldRouteTests(ApiCase):
    VALUES = {
        "confidence": {"level": "high", "why": ["two signals agree", {"nested": None}]},
        "window": {"from": "2026-11-11T09:00:00Z", "to": "2026-11-11T10:00:00Z", "hours": 1},
    }

    def agent_adding_optional_fields(self):
        values = self.VALUES

        class Adding(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                async for event in super().stream_response(conversation_id, text):
                    item = event.data.get("item") if isinstance(event.data, dict) else None
                    if event.name == "response.output_item.done" and item and item.get("type") == "function_call" and item.get("name") == "submit_result":
                        arguments = json.loads(item["arguments"])
                        result = arguments["result"]
                        result["confidence"] = values["confidence"]
                        if result["kind"] == "explain":
                            result["window"] = values["window"]
                        event = event._replace(data={**event.data, "item": {**item, "arguments": json.dumps(arguments)}})
                    yield event

        return Adding(delay=0)

    def schema_open_to_the_optional_fields(self):
        schema = json.loads(self.model_diff.SCHEMA_PATH.read_text(encoding="utf-8"))
        for kind, names in (("diff", ("confidence",)), ("explain", ("confidence", "window"))):
            schema["$defs"][kind]["properties"].update({name: {} for name in names})
        return Draft202012Validator(schema)

    def test_confidence_and_window_reach_the_stored_task_the_task_route_and_the_diff_untouched(self):
        with mock.patch.object(self.model_diff, "VALIDATOR", self.schema_open_to_the_optional_fields()):
            self.install(self.agent_adding_optional_fields())
            with TestClient(self.module.app) as client:
                reviewed = self.review(client)
                review_task = client.get(f"/api/sessions/{reviewed}/tasks/1").json()
                diff = client.get(f"/api/sessions/{reviewed}/tasks/1/diff").json()
                explained = self.new_session(client)
                self.assertEqual(self.start(client, explained, type="explain", target={**TARGET, "entity": "orders-api"}).status_code, 202)
                explain_task = self.finish(client, explained)
                stored = {
                    "review": asyncio.run(self.store.get_task(OWNER, reviewed, 1)),
                    "explain": asyncio.run(self.store.get_task(OWNER, explained, 1)),
                }

        self.assertEqual((review_task["status"], explain_task["status"]), ("done", "done"))
        self.assertEqual(review_task["result"]["confidence"], self.VALUES["confidence"])
        self.assertNotIn("window", review_task["result"])
        self.assertEqual(diff["confidence"], self.VALUES["confidence"])
        self.assertEqual((explain_task["result"]["confidence"], explain_task["result"]["window"]), (self.VALUES["confidence"], self.VALUES["window"]))
        self.assertEqual(stored["review"]["result"], review_task["result"])
        self.assertEqual(stored["explain"]["result"], explain_task["result"])

    def test_without_the_optional_fields_neither_the_task_nor_the_diff_gains_them(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            task = client.get(f"/api/sessions/{sid}/tasks/1").json()
            diff = client.get(f"/api/sessions/{sid}/tasks/1/diff").json()

        self.assertNotIn("confidence", task["result"])
        self.assertNotIn("confidence", diff)


class ApplyRouteTests(DiffAndApplyCase):
    def test_a_selection_is_expanded_and_written_in_dependency_order(self):
        cases = [
            ("a relationship brings its entity and definition", ["c4"], ["c2", "c3", "c4"]),
            ("everything, writes ordered by kind", ["c1", "c2", "c3", "c4"], ["c2", "c1", "c3", "c4"]),
            ("a lone definition", ["c2"], ["c2"]),
            ("a lone change", ["c1"], ["c1"]),
            ("an entity brings the rest", ["c3"], ["c2", "c3", "c4"]),
        ]
        for label, selected, order in cases:
            with self.subTest(label=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.review(client)
                    calls = self.written()

                    response = self.post_apply(client, sid, selected)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json(), {"outcome": "applied", "written": order, "failed": None, "expanded": order})
                names = {"c1": "orders-api", "c2": "sd-queue-depth", "c3": "order-queue", "c4": "orders-api-order-queue"}
                self.assertEqual([c[3] for c in calls], [names[i] for i in order])
                self.assertTrue(all(c[0] == "write_resource" for c in calls))

    def test_the_model_really_changes_and_the_apply_is_recorded_on_the_diff(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            before = self.model_diff.fingerprint(self.health.read_model(SUB, GROUP, MODEL))

            response = self.post_apply(client, sid, ["c1", "c2", "c3", "c4"])
            diff = client.get(f"/api/sessions/{sid}/tasks/1/diff").json()

        live = self.health.read_model(SUB, GROUP, MODEL)
        self.assertNotEqual(self.model_diff.fingerprint(live), before)
        self.assertEqual(len(live["entities"]), 6)
        self.assertEqual({e["name"]: e["properties"]["displayName"] for e in live["entities"]}["orders-api"], "Orders API (reviewed)")
        (recorded,) = diff["applies"]
        self.assertEqual(set(recorded), {"at", "changeIds", "expanded", "outcome", "written", "failed"})
        self.assertEqual((recorded["outcome"], recorded["changeIds"], recorded["written"]), ("applied", ["c1", "c2", "c3", "c4"], response.json()["written"]))
        self.assertRegex(recorded["at"], r"Z$")

    def test_a_second_apply_of_the_same_task_is_refused_by_the_fingerprint(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            first = self.post_apply(client, sid, ["c1"])
            calls = self.written()
            second = self.post_apply(client, sid, ["c2"])

        self.assertEqual(first.status_code, 200)
        self.assertEqual((second.status_code, second.json()["error"]["code"]), (409, "base_changed"))
        self.assertFalse(second.json()["error"]["retryable"])
        self.assertEqual(calls, [])

    def test_a_model_changed_since_the_snapshot_is_refused_without_writing(self):
        def edit_threshold(sub, group, model):
            definition = self.health.read_model(sub, group, model)["signalDefinitions"][0]
            definition["properties"]["evaluationRules"]["degradedRule"]["threshold"] = 42
            self.health.write_resource(sub, group, model, "signalDefinition", definition["name"], definition["properties"])

        def rename_entity(sub, group, model):
            entity = self.health.read_model(sub, group, model)["entities"][1]
            self.health.write_resource(sub, group, model, "entity", entity["name"], {**entity["properties"], "displayName": "Edited by someone"})

        def delete_relationship(sub, group, model):
            self.health.delete_resource(sub, group, model, "relationship", "orders-api-payments")

        for label, edit in [("definition", edit_threshold), ("entity", rename_entity), ("relationship", delete_relationship)]:
            with self.subTest(label=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.review(client)
                    edit(SUB, GROUP, MODEL)
                    calls = self.written()

                    response = self.post_apply(client, sid, ["c1", "c2", "c3", "c4"])

                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "base_changed"))
                self.assertEqual(calls, [])

    def test_system_noise_in_the_live_model_does_not_count_as_a_change(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            for entity in self.health._model(SUB, GROUP, MODEL)["entities"].values():
                entity["properties"]["healthState"] = "Unhealthy"
                entity["systemData"] = {"lastModifiedAt": "2031-01-01T00:00:00Z"}
                for group in entity["properties"]["signalGroups"].values():
                    for signal in group.get("signals", []):
                        signal["status"] = {"healthState": "Unhealthy", "value": 1234, "reportedAt": "2031-01-01T00:00:00Z"}

            response = self.post_apply(client, sid, ["c1"])

        self.assertEqual(response.status_code, 200, response.text)

    def test_a_model_outside_the_deployment_is_applied_like_any_other_with_the_users_own_rights(self):
        elsewhere = (OTHER_SUB, "rg-elsewhere", MODEL)
        target = {"subscriptionId": OTHER_SUB, "resourceGroup": "rg-elsewhere", "name": MODEL}
        self.health = self.fixture_models.FixtureHealthModels(elsewhere, (SUB, GROUP, DESIGN))
        self.module.health = self.health
        change = {"id": "c1", "op": "change", "kind": "entity", "name": "orders-api", "after": {"displayName": "Edited"}, "reason": "r"}
        sid = self.stored_diff([change], target=target, base=self.fixture_models.fixture_model(*elsewhere))
        calls = self.written()

        with TestClient(self.module.app) as client:
            response = self.post_apply(client, sid, ["c1"])

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["outcome"], "applied")
        self.assertEqual(calls, [("write_resource", MODEL, "entity", "orders-api")])

    def test_the_request_body_is_validated(self):
        cases = [
            ("no body", {}, 400, "invalid_change_ids"),
            ("empty object", {"json": {}}, 400, "invalid_change_ids"),
            ("empty list", {"json": {"changeIds": []}}, 400, "invalid_change_ids"),
            ("not a list", {"json": {"changeIds": "c1"}}, 400, "invalid_change_ids"),
            ("not text", {"json": {"changeIds": [1]}}, 400, "invalid_change_ids"),
            ("unknown id", {"json": {"changeIds": ["nope"]}}, 400, "invalid_change_ids"),
            ("known and unknown", {"json": {"changeIds": ["c1", "nope"]}}, 400, "invalid_change_ids"),
            ("wrong content type", {"content": b'{"changeIds": ["c1"]}', "headers": {"content-type": "text/plain"}}, 415, "json_required"),
            ("invalid json", {"content": b"{", "headers": {"content-type": "application/json"}}, 400, "invalid_json"),
        ]
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            calls = self.written()
            for label, arguments, status, code in cases:
                with self.subTest(label=label):
                    response = client.post(f"/api/sessions/{sid}/tasks/1/apply", **arguments)

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))
            self.assertEqual(calls, [])
            self.start(client, sid, type="explain", target={**TARGET, "entity": "orders-api"})
            self.finish(client, sid, 2)
            explain = client.post(f"/api/sessions/{sid}/tasks/2/apply", json={"changeIds": ["c1"]})
            missing = client.post(f"/api/sessions/{sid}/tasks/9/apply", json={"changeIds": ["c1"]})

        self.assertEqual((explain.status_code, explain.json()["error"]["code"]), (404, "diff_not_found"))
        self.assertEqual(missing.status_code, 404)

    def test_it_stops_at_the_first_failure_and_reports_what_was_written(self):
        cases = [
            (400, "change_rejected"), (403, "forbidden"), (404, "not_found"), (409, "conflict"),
            (429, "unavailable"), (500, "unavailable"), (503, "unavailable"),
        ]
        for status, code in cases:
            with self.subTest(status=status):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.review(client)
                    attempts = []
                    original = self.health.write_resource

                    def flaky(sub, group, model, kind, name, properties):
                        attempts.append(name)
                        if len(attempts) == 2:
                            raise azure_error(status)
                        return original(sub, group, model, kind, name, properties)

                    self.health.write_resource = flaky
                    with self.assertLogs("ahm-demo", level="WARNING"):
                        response = self.post_apply(client, sid, ["c1", "c2", "c3", "c4"])
                    diff = client.get(f"/api/sessions/{sid}/tasks/1/diff").json()

                body = response.json()
                self.assertEqual(response.status_code, 200)
                self.assertEqual((body["outcome"], body["written"]), ("partial", ["c2"]))
                self.assertEqual(body["expanded"], ["c2", "c1", "c3", "c4"])
                self.assertEqual(body["failed"]["changeId"], "c1")
                self.assertEqual(body["failed"]["code"], code)
                self.assertIn("Azure did not accept the change of entity orders-api", body["failed"]["message"])
                self.assertIn(f"HTTP {status}", body["failed"]["message"])
                self.assertNotIn("SECRET", response.text)
                self.assertEqual(attempts, ["sd-queue-depth", "orders-api"])
                self.assertEqual(diff["applies"][0]["outcome"], "partial")
                self.assertEqual(diff["applies"][0]["failed"], body["failed"])

    def test_a_failure_on_the_very_first_write_writes_nothing(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            self.health.write_resource = mock.Mock(side_effect=azure_error(403))
            with self.assertLogs("ahm-demo", level="WARNING"):
                body = self.post_apply(client, sid, ["c2"]).json()

        self.assertEqual((body["outcome"], body["written"], body["failed"]["changeId"]), ("partial", [], "c2"))

    def test_azure_error_codes_are_named_in_the_failure_message(self):
        error = azure_error(400)
        error.error = type("E", (), {"code": "InvalidRequestContent"})()
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            self.health.write_resource = mock.Mock(side_effect=error)
            with self.assertLogs("ahm-demo", level="WARNING"):
                body = self.post_apply(client, sid, ["c2"]).json()

        self.assertIn("(InvalidRequestContent)", body["failed"]["message"])

    def test_writes_use_the_properties_without_read_only_fields(self):
        noisy = {"displayName": "Edited", "healthState": "Healthy", "provisioningState": "Succeeded", "discoveredBy": "rule",
                 "signalGroups": {"external": {"signals": []}, "azureResource": {"azureResourceId": "x", "signals": [{"name": "cpu", "status": {"value": 1}, "refreshInterval": "PT1M"}]}}}
        sid = self.stored_diff([{"id": "c1", "op": "change", "kind": "entity", "name": "payments", "after": noisy, "reason": "r"}])
        sent = []
        original = self.health.write_resource
        self.health.write_resource = lambda *args: (sent.append(args), original(*args))[1]
        with TestClient(self.module.app) as client:
            self.post_apply(client, sid, ["c1"])

        (arguments,) = sent
        self.assertEqual(arguments[3:5], ("entity", "payments"))
        self.assertEqual(
            arguments[5],
            {"displayName": "Edited", "signalGroups": {"azureResource": {"azureResourceId": "x", "signals": [{"name": "cpu", "refreshInterval": "PT1M"}]}}, "canvasPosition": {"x": 600, "y": 400}},
        )
        self.assertIn("status", noisy["signalGroups"]["azureResource"]["signals"][0])

    def test_writes_come_first_then_removals_in_reverse(self):
        changes = [
            {"id": "r1", "op": "remove", "kind": "signalDefinition", "name": "sd-db-cpu", "after": None, "reason": "r"},
            {"id": "r2", "op": "remove", "kind": "entity", "name": "orders-db", "after": None, "reason": "r"},
            {"id": "r3", "op": "remove", "kind": "relationship", "name": "orders-api-orders-db", "after": None, "reason": "r"},
            {"id": "a1", "op": "add", "kind": "relationship", "name": "payments-extra", "after": {"parentEntityName": "payments", "childEntityName": "extra-thing"}, "reason": "r"},
            {"id": "a2", "op": "add", "kind": "entity", "name": "extra-thing", "after": {"displayName": "Extra"}, "reason": "r"},
            {"id": "a3", "op": "add", "kind": "signalDefinition", "name": "sd-extra", "after": self.fixture_models.metric_definition("Extra", "X", 1, 2), "reason": "r"},
        ]
        sid = self.stored_diff(changes)
        calls = self.written()
        with TestClient(self.module.app) as client:
            response = self.post_apply(client, sid, ["r1", "r2", "r3", "a1", "a2", "a3"])

        self.assertEqual(response.json()["outcome"], "applied", response.text)
        self.assertEqual(
            [(c[0], c[2], c[3]) for c in calls],
            [
                ("write_resource", "signalDefinition", "sd-extra"),
                ("write_resource", "entity", "extra-thing"),
                ("write_resource", "relationship", "payments-extra"),
                ("delete_resource", "relationship", "orders-api-orders-db"),
                ("delete_resource", "entity", "orders-db"),
                ("delete_resource", "signalDefinition", "sd-db-cpu"),
            ],
        )
        live = self.health.read_model(SUB, GROUP, MODEL)
        self.assertNotIn("orders-db", [e["name"] for e in live["entities"]])

    def test_deleting_something_already_gone_counts_as_written(self):
        change = {"id": "r1", "op": "remove", "kind": "relationship", "name": "orders-api-payments", "after": None, "reason": "r"}
        sid = self.stored_diff([change])
        original = self.health.delete_resource

        def gone(*args):
            original(*args)
            raise azure_error(404)

        self.health.delete_resource = gone
        with TestClient(self.module.app) as client:
            body = self.post_apply(client, sid, ["r1"]).json()

        self.assertEqual((body["outcome"], body["written"]), ("applied", ["r1"]))

    def test_a_design_task_applies_into_the_design_model(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, type="design", workload={"resourceGroup": GROUP})
            task = self.finish(client, sid)
            self.assertEqual(task["status"], "done", task.get("error"))
            response = self.post_apply(client, sid, ["c2"])

        body = response.json()
        self.assertEqual(body["outcome"], "applied", body)
        self.assertEqual(body["written"], ["c1", "c2", "c3", "c4", "c5"])
        design = self.health.read_model(SUB, GROUP, DESIGN)
        self.assertEqual(sorted(e["name"] for e in design["entities"]), sorted([DESIGN, "catalog-api", "catalog-db"]))
        self.assertEqual(len(self.health.read_model(SUB, GROUP, MODEL)["entities"]), 5)

    def test_azure_problems_reading_the_live_model_are_mapped(self):
        cases = [
            (azure_error(403), 403, "forbidden"),
            (azure_error(500), 503, "health_model_unavailable"),
            (azure_error(404), 404, "not_found"),
            (ServiceRequestError("SECRET_AZURE_BODY"), 503, "health_model_unavailable"),
            (ServiceResponseError("SECRET_AZURE_BODY"), 503, "health_model_unavailable"),
        ]
        for error, status, code in cases:
            with self.subTest(error=type(error).__name__, status=getattr(error, "status_code", None)):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.review(client)
                    self.health.read_model = mock.Mock(side_effect=error)
                    with self.assertLogs("ahm-demo", level="WARNING"):
                        response = self.post_apply(client, sid, ["c1"])

                self.assertEqual((response.status_code, response.json()["error"]["code"]), (status, code))
                self.assertNotIn("SECRET", response.text)

    def test_the_outcome_is_still_returned_when_it_cannot_be_recorded(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)

            async def broken(*args):
                raise self.sessions_store.StoreUnavailable("append_apply")

            self.store.append_apply = broken
            with self.assertLogs("ahm-demo", level="ERROR"):
                response = self.post_apply(client, sid, ["c1"])

        self.assertEqual((response.status_code, response.json()["outcome"]), (200, "applied"))

    def test_two_simultaneous_applies_of_one_task_cannot_both_write(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            original = self.health.write_resource
            self.health.write_resource = lambda *args: (time.sleep(0.05), original(*args))[1]
            results = []
            threads = [threading.Thread(target=lambda: results.append(self.post_apply(client, sid, ["c1", "c2", "c3", "c4"]))) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(20)

        self.assertEqual(sorted(r.status_code for r in results), [200, 409])
        self.assertEqual(len(self.health.read_model(SUB, GROUP, MODEL)["entities"]), 6)


class LimitRouteTests(ApiCase):
    def gated(self):
        gate = asyncio.Event()

        class Gated(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                await gate.wait()
                async for event in super().stream_response(conversation_id, text):
                    yield event

        self.install(Gated(delay=0))
        return gate

    def test_the_session_cap_answers_409_and_creates_nothing(self):
        with mock.patch.object(self.sessions_store, "MAX_SESSIONS", 2):
            with TestClient(self.module.app) as client:
                self.new_session(client)
                self.new_session(client)
                refused = client.post("/api/sessions", json={})
                listed = client.get("/api/sessions").json()["sessions"]

        error = refused.json()["error"]
        self.assertEqual(refused.status_code, 409)
        self.assertEqual((error["code"], error["retryable"]), ("session_limit", False))
        self.assertEqual(len(listed), 2)

    def test_the_task_cap_answers_409_for_that_session_only_and_leaves_nothing_running(self):
        with mock.patch.object(self.sessions_store, "MAX_TASKS_PER_SESSION", 2):
            with TestClient(self.module.app) as client:
                sid, other = self.new_session(client), self.new_session(client)
                for seq in (1, 2):
                    self.assertEqual(self.start(client, sid, type="review", target=TARGET).status_code, 202)
                    self.finish(client, sid, seq)
                refused = self.start(client, sid, type="review", target=TARGET)
                again = self.start(client, sid, type="review", target=TARGET)
                elsewhere = self.start(client, other, type="review", target=TARGET)
                self.finish(client, other)
                detail = client.get(f"/api/sessions/{sid}").json()

        for response in (refused, again):
            error = response.json()["error"]
            self.assertEqual(response.status_code, 409)
            self.assertEqual((error["code"], error["retryable"]), ("task_limit", False))
        self.assertEqual(elsewhere.status_code, 202)
        self.assertEqual(len(detail["tasks"]), 2)

    def test_followers_of_one_task_are_capped_with_a_503(self):
        gate = self.gated()
        with mock.patch.object(self.task_runner, "MAX_SUBSCRIBERS_PER_TASK", 2):
            with TestClient(self.module.app) as client:
                sid = self.new_session(client)
                self.start(client, sid, type="review", target=TARGET)
                results = []
                readers = [threading.Thread(target=lambda: results.append(client.get(f"/api/sessions/{sid}/tasks/1/events"))) for _ in range(2)]
                for reader in readers:
                    reader.start()
                deadline = time.monotonic() + 5
                while client.portal.call(lambda: len(self.module.runner._running[(OWNER, sid)].subscribers)) < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
                third = client.get(f"/api/sessions/{sid}/tasks/1/events")
                client.portal.call(gate.set)
                for reader in readers:
                    reader.join(10)
                after = client.get(f"/api/sessions/{sid}/tasks/1/events")

        error = third.json()["error"]
        self.assertEqual(third.status_code, 503)
        self.assertEqual((error["code"], error["retryable"]), ("too_many_subscribers", True))
        self.assertEqual(third.headers["cache-control"], "no-store")
        self.assertEqual([r.status_code for r in results], [200, 200])
        self.assertTrue(all(frames(r.text)[-1]["event"] == "done" for r in results))
        self.assertEqual(after.status_code, 200)

    def test_a_follower_that_never_starts_streaming_gives_its_slot_back(self):
        gate = self.gated()
        with mock.patch.object(self.task_runner, "MAX_SUBSCRIBERS_PER_TASK", 1):
            with TestClient(self.module.app) as client:
                sid = self.new_session(client)
                self.start(client, sid, type="review", target=TARGET)

                async def abandon():
                    request = mock.Mock(headers={}, query_params={})
                    response = await self.module.task_events(sid, "1", request, self.module.LOCAL_CALLER)
                    held = len(self.module.runner._running[(OWNER, sid)].subscribers)
                    await response.background()
                    return held, len(self.module.runner._running[(OWNER, sid)].subscribers)

                held, released = client.portal.call(abandon)
                client.portal.call(gate.set)
                self.finish(client, sid)

        self.assertEqual((held, released), (1, 0))


class BodyLimitTests(ApiCase):
    LIMIT = 64 * 1024

    def padded(self, size):
        body = json.dumps({"title": "T", "pad": ""}).encode()
        return json.dumps({"title": "T", "pad": "p" * (size - len(body))}).encode()

    def test_bodies_over_64_kb_are_refused_on_every_route_before_anything_runs(self):
        reached = []
        for name in ("create_session", "create_task", "get_task", "list_sessions"):
            original = getattr(self.store, name)

            async def spy(*args, _name=name, _original=original):
                reached.append(_name)
                return await _original(*args)

            setattr(self.store, name, spy)
        calls = self.spy(["has_model", "client", "read_model", "write_resource"])
        bodies = [
            ("a declared length over the limit", lambda: b"x" * (self.LIMIT + 1)),
            ("a streamed body without a length", lambda: (b"x" * 1000 for _ in range(self.LIMIT // 1000 + 1))),
            ("a huge body", lambda: b"x" * 5_000_000),
        ]
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            reached.clear()
            routes = [
                ("POST", "/api/sessions"),
                ("POST", f"/api/sessions/{sid}/tasks"),
                ("POST", f"/api/sessions/{sid}/tasks/1/apply"),
                ("POST", "/api/entities/orders-api/health-reports"),
                ("GET", "/api/sessions"),
                ("GET", "/api/health-model"),
                ("GET", f"/api/sessions/{sid}/tasks/1/events"),
                ("GET", "/"),
                ("GET", "/assets/anything.js"),
                ("GET", "/some/deep/link"),
                ("PUT", "/api/sessions"),
            ]
            for method, path in routes:
                for label, make in bodies:
                    with self.subTest(route=f"{method} {path}", body=label):
                        response = client.request(method, path, content=make(), headers={"content-type": "application/json"})

                        error = response.json()["error"]
                        self.assertEqual(response.status_code, 413)
                        self.assertEqual((error["code"], error["retryable"]), ("payload_too_large", False))
                        self.assertRegex(error["operationId"], r"^[0-9a-f]{32}$")
                        self.assertEqual(response.headers["cache-control"], "no-store")
                        self.assertIn("default-src 'self'", response.headers["content-security-policy"])

        self.assertEqual(reached, [])
        self.assertEqual(calls, [])

    def test_a_body_of_exactly_64_kb_is_still_read(self):
        def chunks(size):
            data = self.padded(size)
            return iter([data[start:start + 1000] for start in range(0, len(data), 1000)])

        headers = {"content-type": "application/json"}
        with TestClient(self.module.app) as client:
            whole = client.post("/api/sessions", content=self.padded(self.LIMIT), headers=headers)
            one_over = client.post("/api/sessions", content=self.padded(self.LIMIT + 1), headers=headers)
            streamed = client.post("/api/sessions", content=chunks(self.LIMIT), headers=headers)
            streamed_over = client.post("/api/sessions", content=chunks(self.LIMIT + 1), headers=headers)
            empty = client.post("/api/sessions")

        self.assertEqual(len(self.padded(self.LIMIT)), self.LIMIT)
        self.assertEqual([r.status_code for r in (whole, streamed, empty)], [201, 201, 201])
        self.assertEqual([r.status_code for r in (one_over, streamed_over)], [413, 413])

    def test_the_app_still_sees_a_disconnect_after_the_body_was_read(self):
        received = []

        async def app(scope, receive, send):
            received.append(await receive())
            received.append(await receive())

        messages = iter([
            {"type": "http.request", "body": b"ab", "more_body": True},
            {"type": "http.request", "body": b"cd", "more_body": False},
            {"type": "http.disconnect"},
        ])

        async def receive():
            return next(messages)

        asyncio.run(self.module.BodyLimitMiddleware(app)({"type": "http", "headers": []}, receive, None))

        self.assertEqual(received, [{"type": "http.request", "body": b"abcd", "more_body": False}, {"type": "http.disconnect"}])

    def test_a_declared_length_over_the_limit_is_refused_without_reading_the_body(self):
        reads, sent = [], []

        async def receive():
            reads.append(1)
            return {"type": "http.request", "body": b"x", "more_body": True}

        async def send(message):
            sent.append(message)

        async def app(scope, receive, send):
            raise AssertionError("the app must not run")

        cases = [
            ("one byte over", b"65537"),
            ("a huge length", b"99999999999999999999"),
            ("five thousand digits", b"9" * 5000),
            ("not a number", b"many"),
            ("a sign", b"-1"),
            ("other digits", "\u00b2".encode("latin-1")),
        ]
        for label, length in cases:
            with self.subTest(label=label):
                reads.clear()
                sent.clear()

                asyncio.run(self.module.BodyLimitMiddleware(app)({"type": "http", "method": "POST", "path": "/", "headers": [(b"content-length", length)]}, receive, send))

                self.assertEqual(reads, [])
                self.assertEqual(sent[0]["status"], 413)

    def test_other_protocols_pass_through_untouched(self):
        seen = []

        async def app(scope, receive, send):
            seen.append(scope["type"])

        asyncio.run(self.module.BodyLimitMiddleware(app)({"type": "lifespan"}, None, None))

        self.assertEqual(seen, ["lifespan"])

    def test_the_repository_url_follows_the_limits_of_the_address_the_agent_clones(self):
        cases = [
            ("an owner of 39 characters", f"https://github.com/{'o' * 39}/r", 202),
            ("an owner of 40 characters", f"https://github.com/{'o' * 40}/r", 400),
            ("a repository of 100 characters", f"https://github.com/o/{'r' * 100}", 202),
            ("a repository of 100 characters and .git", f"https://github.com/o/{'r' * 100}.git/", 202),
            ("a repository of 101 characters", f"https://github.com/o/{'r' * 101}", 400),
            ("very long", f"https://github.com/o/{'r' * 5000}", 400),
        ]
        for label, url, status in cases:
            with self.subTest(label=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    sid = self.new_session(client)

                    response = self.start(client, sid, type="design", workload={"resourceGroup": GROUP, "repositoryUrl": url})

                self.assertEqual(response.status_code, status)
                if status == 400:
                    error = response.json()["error"]
                    self.assertEqual(error["code"], "invalid_repository_url")
                    self.assertEqual(error["message"], "Enter a public GitHub repository, such as https://github.com/owner/repository.")


class MalformedInputTests(ApiCase):
    def test_overlong_or_malformed_task_numbers_and_resume_markers_are_client_errors(self):
        huge = "9" * 5000
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            events = f"/api/sessions/{sid}/tasks/1/events"
            cases = [
                ("task number of 9 digits that does not exist", "get", f"/api/sessions/{sid}/tasks/999999999", {}, 404, "task_not_found"),
                ("task number of 10 digits", "get", f"/api/sessions/{sid}/tasks/1234567890", {}, 404, "task_not_found"),
                ("task number of 5000 digits", "get", f"/api/sessions/{sid}/tasks/{huge}", {}, 404, "task_not_found"),
                ("leading zeros past nine characters", "get", f"/api/sessions/{sid}/tasks/0000000001", {}, 404, "task_not_found"),
                ("5000 digits on the stream", "get", f"/api/sessions/{sid}/tasks/{huge}/events", {}, 404, "task_not_found"),
                ("5000 digits on the diff", "get", f"/api/sessions/{sid}/tasks/{huge}/diff", {}, 404, "diff_not_found"),
                ("5000 digits on apply", "post", f"/api/sessions/{sid}/tasks/{huge}/apply", {"json": {"changeIds": ["c1"]}}, 404, "diff_not_found"),
                ("resume marker of 5000 digits in the query", "get", f"{events}?lastEventId={huge}", {}, 400, "invalid_last_event_id"),
                ("resume marker of 5000 digits in the header", "get", events, {"headers": {"Last-Event-ID": huge}}, 400, "invalid_last_event_id"),
                ("resume marker of 10 digits", "get", f"{events}?lastEventId=1234567890", {}, 400, "invalid_last_event_id"),
                ("resume marker that is no number", "get", events, {"headers": {"Last-Event-ID": "abc"}}, 400, "invalid_last_event_id"),
                ("negative resume marker", "get", events, {"headers": {"Last-Event-ID": "-3"}}, 400, "invalid_last_event_id"),
                ("decimal resume marker", "get", f"{events}?lastEventId=1.5", {}, 400, "invalid_last_event_id"),
                ("resume marker in other digits", "get", f"{events}?lastEventId=%C2%B2", {}, 400, "invalid_last_event_id"),
                ("resume marker with a newline", "get", f"{events}?lastEventId=1%0A", {}, 400, "invalid_last_event_id"),
                ("resume marker of 9 digits", "get", f"{events}?lastEventId=999999999", {}, 200, None),
                ("blank resume marker", "get", f"{events}?lastEventId=", {}, 200, None),
            ]
            for label, method, path, arguments, status, code in cases:
                with self.subTest(label=label):
                    response = getattr(client, method)(path, **arguments)

                    self.assertEqual(response.status_code, status)
                    if code:
                        self.assertEqual(response.json()["error"]["code"], code)
                        self.assertFalse(response.json()["error"]["retryable"])

    def test_ids_and_selectors_with_a_trailing_newline_are_not_accepted(self):
        reached = self.spy(["has_model", "client", "read_model"])
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            reached.clear()
            for path in (f"/api/sessions/{sid}%0A", f"/api/sessions/{sid}%0A/tasks/1", f"/api/sessions/{sid}%0A/tasks/1/events"):
                with self.subTest(path=path):
                    self.assertEqual(client.get(path).status_code, 404)
            posted = client.post(f"/api/sessions/{sid}%0A/tasks", json={"type": "review", "target": TARGET})
            for selector in (f"?model={MODEL}%0A&resourceGroup={GROUP}", f"?model={MODEL}&resourceGroup={GROUP}%0A", f"?model={MODEL}&resourceGroup={GROUP}&subscription={SUB}%0A"):
                with self.subTest(selector=selector):
                    response = client.get(f"/api/health-model{selector}")

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "unknown_model"))

        self.assertEqual(posted.status_code, 404)
        self.assertEqual(reached, [])


class OrphanRouteTests(ApiCase):
    def test_a_running_task_nobody_runs_reads_as_interrupted_on_every_read_path(self):
        def task(client, sid):
            return client.get(f"/api/sessions/{sid}/tasks/1").json()["status"]

        def detail(client, sid):
            return client.get(f"/api/sessions/{sid}").json()["tasks"][0]["status"]

        def events(client, sid):
            parsed = frames(client.get(f"/api/sessions/{sid}/tasks/1/events").text)
            self.assertEqual(json.loads(parsed[-2]["data"])["kind"], "error")
            self.assertEqual(json.loads(parsed[-1]["data"])["error"]["code"], "interrupted")
            return json.loads(parsed[-1]["data"])["status"]

        def diff(client, sid):
            self.assertEqual(client.get(f"/api/sessions/{sid}/tasks/1/diff").status_code, 404)
            return "failed"

        def apply(client, sid):
            self.assertEqual(self.post_apply(client, sid, ["c1"]).status_code, 404)
            return "failed"

        for label, read in [("task", task), ("session detail", detail), ("events", events), ("diff", diff), ("apply", apply)]:
            with self.subTest(read=label):
                self.install(self.fake_agent.FakeAgent(delay=0))
                with TestClient(self.module.app) as client:
                    self.recovered(client)
                    sid = self.seed_task(age=600, events=2)

                    shown = read(client, sid)

                stored = asyncio.run(self.store.get_task(OWNER, sid, 1))
                events_after = asyncio.run(self.store.read_events(OWNER, sid, 1))
                self.assertEqual(shown, "failed")
                self.assertEqual((stored["status"], stored["error"]["code"]), ("failed", "interrupted"))
                self.assertEqual([e["seq"] for e in events_after], [1, 2, 3])

    def test_a_task_that_may_still_be_starting_is_left_alone_by_plain_reads(self):
        with TestClient(self.module.app) as client:
            self.recovered(client)
            sid = self.seed_task(age=1)

            task = client.get(f"/api/sessions/{sid}/tasks/1").json()
            detail = client.get(f"/api/sessions/{sid}").json()

        self.assertEqual((task["status"], detail["tasks"][0]["status"]), ("running", "running"))
        self.assertEqual(asyncio.run(self.store.get_task(OWNER, sid, 1))["status"], "running")

    def test_a_stream_for_such_a_task_waits_for_the_window_then_ends_as_failed(self):
        with mock.patch.object(self.task_runner, "INTERRUPTED_GRACE_SECONDS", 0.4), mock.patch.object(self.module, "SSE_KEEP_ALIVE_SECONDS", 0.05):
            with TestClient(self.module.app) as client:
                self.recovered(client)
                sid = self.seed_task(age=0)

                response = client.get(f"/api/sessions/{sid}/tasks/1/events")

        parsed = frames(response.text)
        self.assertGreaterEqual(response.text.count(": keep-alive"), 2)
        self.assertEqual([f["event"] for f in parsed if f.get("event") == "done"], ["done"])
        self.assertEqual(json.loads(parsed[-1]["data"])["status"], "failed")
        self.assertNotIn('"status":"running"', response.text)

    def test_a_run_whose_final_save_was_lost_never_ends_its_stream_as_running(self):
        original = self.store.save_task

        async def lossy(owner, sid, task):
            if task["status"] in ("done", "failed"):
                raise self.sessions_store.StoreUnavailable("save_task")
            return await original(owner, sid, task)

        self.store.save_task = lossy
        patches = [
            mock.patch.object(self.task_runner, "FINAL_SAVE_DELAYS", (0, 0, 0)),
            mock.patch.object(self.task_runner, "INTERRUPTED_GRACE_SECONDS", 0.3),
            mock.patch.object(self.module, "SSE_KEEP_ALIVE_SECONDS", 0.05),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, type="review", target=TARGET)

            with self.assertLogs("ahm-demo", level="WARNING"):
                response = client.get(f"/api/sessions/{sid}/tasks/1/events")
                task = client.get(f"/api/sessions/{sid}/tasks/1").json()

        done = json.loads(frames(response.text)[-1]["data"])
        self.assertEqual(done["status"], "failed")
        self.assertEqual(done["error"]["code"], "interrupted")
        self.assertNotIn('"status":"running"', response.text)
        self.assertEqual(sum(1 for f in frames(response.text) if f.get("event") == "done"), 1)
        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "interrupted"))

    def test_replay_never_repeats_or_reorders_a_sequence_number(self):
        async def seed():
            session = await self.store.create_session(OWNER, "Dupes")
            await self.store.create_task(OWNER, session["id"], {"type": "review", "status": "done", "target": TARGET, "createdAt": "2026-11-10T10:00:00Z"})
            for seq in (1, 2, 2, 3, 2, 5, 4, 5):
                await self.store.append_event(OWNER, session["id"], 1, {"seq": seq, "ts": "t", "kind": "status", "summary": f"e{seq}", "payload": {}})
            return session["id"]

        sid = asyncio.run(seed())
        with TestClient(self.module.app) as client:
            whole = client.get(f"/api/sessions/{sid}/tasks/1/events")
            resumed = client.get(f"/api/sessions/{sid}/tasks/1/events", headers={"Last-Event-ID": "2"})

        self.assertEqual([int(f["id"]) for f in frames(whole.text) if "id" in f], [1, 2, 3, 5])
        self.assertEqual([int(f["id"]) for f in frames(resumed.text) if "id" in f], [3, 5])


class MessageRouteTests(ApiCase):
    def test_long_and_secret_agent_messages_are_clipped_and_redacted_in_every_view(self):
        message = f"{'m' * 1000} {TOKEN}"

        class Failing(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                yield self.foundry_agent.StreamEvent("response.failed", {"response": {"error": {"code": "denied", "message": message}}})

        self.install(Failing(delay=0))
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            with self.assertLogs("ahm-demo", level="WARNING") as logged:
                self.start(client, sid, type="review", target=TARGET)
                stream = client.get(f"/api/sessions/{sid}/tasks/1/events").text
            task = client.get(f"/api/sessions/{sid}/tasks/1").json()
            detail = client.get(f"/api/sessions/{sid}").json()

        parsed = frames(stream)
        done = json.loads(parsed[-1]["data"])
        error_event = json.loads(parsed[-2]["data"])
        for view in (stream, json.dumps(task), json.dumps(detail)):
            self.assertNotIn("eyJ", view)
        self.assertLessEqual(len(done["error"]["message"]), 300)
        self.assertLessEqual(len(task["error"]["message"]), 300)
        self.assertLessEqual(len(error_event["payload"]["message"]), 300)
        self.assertIn("m" * 1000, "\n".join(logged.output))
        self.assertNotIn("eyJ", "\n".join(logged.output))


class LifespanTests(ApiCase):
    def test_unfinished_tasks_are_failed_as_interrupted_when_the_app_starts(self):
        async def seed():
            session = await self.store.create_session(OWNER, "Crashed")
            task = await self.store.create_task(OWNER, session["id"], {"type": "review", "status": "running", "target": TARGET, "instruction": "", "createdAt": "t"})
            await self.store.append_event(OWNER, session["id"], 1, {"seq": 1, "ts": "t", "kind": "status", "summary": "x", "payload": {}})
            return session["id"]

        sid = asyncio.run(seed())
        with TestClient(self.module.app) as client:
            self.recovered(client)
            task = client.get(f"/api/sessions/{sid}/tasks/1").json()
            parsed = frames(client.get(f"/api/sessions/{sid}/tasks/1/events").text)

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "interrupted"))
        self.assertEqual(json.loads(parsed[-1]["data"])["error"]["code"], "interrupted")
        self.assertEqual(json.loads(parsed[-2]["data"])["kind"], "error")

    def test_a_store_that_is_down_at_startup_does_not_stop_the_app(self):
        async def broken(*args):
            raise self.sessions_store.StoreUnavailable("list_sessions")

        self.store.unfinished_tasks = broken
        with self.assertLogs("ahm-demo", level="ERROR"):
            with TestClient(self.module.app) as client:
                self.recovered(client)
                self.assertEqual(client.get("/").status_code, 200)

    def test_startup_does_not_wait_for_recovery(self):
        release = asyncio.Event()

        async def slow():
            await release.wait()

        self.module.runner.recover = slow
        with TestClient(self.module.app) as client:
            reachable = [client.get("/").status_code, client.get("/api/sessions").status_code]
            running = not client.portal.call(lambda: self.module.app.state.recovery.done())
            client.portal.call(release.set)
            self.recovered(client)

        self.assertEqual(reachable, [200, 200])
        self.assertTrue(running)

    def test_shutdown_cancels_a_recovery_that_is_still_running(self):
        async def forever():
            await asyncio.Event().wait()

        self.module.runner.recover = forever
        with TestClient(self.module.app):
            recovery = self.module.app.state.recovery

        self.assertTrue(recovery.cancelled())

    def test_recovery_leaves_finished_tasks_alone_and_lists_nothing(self):
        async def seed():
            quiet = await self.store.create_session(OWNER, "Quiet")
            for status in ("done", "failed", "done"):
                await self.store.create_task(OWNER, quiet["id"], {"type": "review", "status": status, "createdAt": "t"})
            busy = await self.store.create_session(OWNER, "Busy")
            await self.store.create_task(OWNER, busy["id"], {"type": "review", "status": "running", "createdAt": "t"})
            return quiet["id"], busy["id"]

        quiet, busy = asyncio.run(seed())
        calls = []
        for name in ("list_sessions", "list_tasks", "get_task", "save_task"):
            original = getattr(self.store, name)

            async def spy(*args, _name=name, _original=original):
                calls.append((_name, *args[:2]))
                return await _original(*args)

            setattr(self.store, name, spy)
        with TestClient(self.module.app) as client:
            self.recovered(client)

        self.assertEqual(sorted(calls), [("get_task", OWNER, busy), ("save_task", OWNER, busy)])
        self.assertEqual([t["status"] for t in asyncio.run(self.store.list_tasks(OWNER, quiet))], ["done", "failed", "done"])

    def test_running_tasks_are_interrupted_when_the_app_stops(self):
        gate = asyncio.Event()

        class Hanging(self.fake_agent.FakeAgent):
            async def stream_response(inner, conversation_id, text):
                await gate.wait()
                yield

        self.install(Hanging(delay=0))
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.start(client, sid, type="review", target=TARGET)
            time.sleep(0.1)
        task = asyncio.run(self.store.get_task(OWNER, sid, 1))

        self.assertEqual((task["status"], task["error"]["code"]), ("failed", "interrupted"))


class EventLoopTests(ApiCase):
    def test_blocking_calls_never_run_on_the_event_loop_thread(self):
        names = ["has_model", "client", "query_models", "read_model", "write_resource"]
        with TestClient(self.module.app) as client:
            loop_thread = client.portal.call(threading.get_ident)
            calls = self.spy(names)
            sid = self.new_session(client)
            routes = [
                ("catalog", lambda: client.get("/api/health-models")),
                ("model", lambda: client.get("/api/health-model")),
                ("selected model", lambda: client.get(f"/api/health-model?model={MODEL}&resourceGroup={GROUP}")),
                ("entity", lambda: client.get("/api/entities/orders-api")),
                ("report", lambda: client.post("/api/entities/orders-api/health-reports", json={"signalName": "web-ui-health-report", "healthState": "Healthy", "value": 1, "expiresInMinutes": 30, "reasonPreset": "recovery"})),
                ("review task", lambda: self.start(client, sid, type="review", target=TARGET)),
            ]
            for label, call in routes:
                with self.subTest(route=label):
                    calls.clear()

                    response = call()
                    if label == "review task":
                        self.finish(client, sid)

                    self.assertLess(response.status_code, 300, response.text)
                    self.assertTrue(calls, label)
                    self.assertTrue(all(thread != loop_thread for _, _, thread in calls), (label, calls))
            calls.clear()
            self.post_apply(client, sid, ["c1"])
            self.assertTrue(calls)
            self.assertTrue(all(thread != loop_thread for _, _, thread in calls))

    def test_handlers_that_call_azure_are_not_coroutines(self):
        for name in ("health_models", "entity_detail", "_ingest_health_report", "_resolve_target"):
            with self.subTest(handler=name):
                self.assertFalse(inspect.iscoroutinefunction(getattr(self.module, name)))


class TelemetryTests(ApiCase):
    def test_session_routes_have_one_server_span_with_the_store_spans_beneath_it(self):
        with TestClient(self.module.app) as client:
            self.spans.clear()
            client.get("/api/sessions")
            spans = self.spans.get_finished_spans()

        (server,) = [s for s in spans if s.kind == SpanKind.SERVER]
        self.assertEqual(server.name, "GET /api/sessions")
        self.assertEqual(Counter(s.name for s in spans if s.kind == SpanKind.CLIENT), {"sessions.store.list_sessions": 1})
        self.assertTrue(all(s.context.trace_id == server.context.trace_id for s in spans))

    def test_the_event_stream_is_one_server_span_that_ends_with_the_stream(self):
        with TestClient(self.module.app) as client:
            sid = self.review(client)
            self.spans.clear()
            client.get(f"/api/sessions/{sid}/tasks/1/events")
            spans = self.spans.get_finished_spans()

        servers = [s for s in spans if s.kind == SpanKind.SERVER]
        self.assertEqual([s.name for s in servers], ["GET /api/sessions/{sid}/tasks/{tid}/events"])
        self.assertTrue({"sessions.store.get_task", "sessions.store.read_events"} <= {s.name for s in spans})

    def test_each_task_run_is_one_agent_span_correlated_with_the_request_that_started_it(self):
        with TestClient(self.module.app) as client:
            sid = self.new_session(client)
            self.spans.clear()
            self.start(client, sid, type="review", target=TARGET)
            self.finish(client, sid)
            spans = self.spans.get_finished_spans()

        (agent,) = [s for s in spans if s.name == "foundry.agent.respond"]
        post = [s for s in spans if s.kind == SpanKind.SERVER and s.name.startswith("POST /api/sessions/")]
        self.assertEqual(agent.kind, SpanKind.CLIENT)
        self.assertEqual(len(post), 1)


class LocalModeTests(ApiCase):
    def test_the_config_names_no_tenant_client_or_scope(self):
        with TestClient(self.module.app) as client:
            response = client.get("/api/config")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"authMode": "local", "clientId": None, "apiScope": None})

    def test_requests_need_no_token_and_always_belong_to_the_one_local_user(self):
        cases = [
            ("no header", {}),
            ("a token that is garbage", {"Authorization": "Bearer garbage"}),
            ("another scheme", {"Authorization": "Basic abc"}),
        ]
        with TestClient(self.module.app) as client:
            for label, headers in cases:
                with self.subTest(label=label):
                    created = client.post("/api/sessions", json={}, headers=headers)
                    listed = client.get("/api/sessions", headers=headers)

                    self.assertEqual((created.status_code, listed.status_code), (201, 200))
                    self.assertIn(created.json()["id"], [s["id"] for s in listed.json()["sessions"]])
        self.assertEqual(len(asyncio.run(self.store.list_sessions(OWNER))), len(cases))
        self.assertEqual(self.auth.LOCAL_CALLER.oid, OWNER)

    def test_azure_is_reached_with_the_developers_own_credential_for_every_request(self):
        seen = []
        original = self.health.as_user
        self.health.as_user = lambda caller: seen.append(caller) or original(caller)
        with TestClient(self.module.app) as client:
            client.get("/api/health-models")

        self.assertEqual(seen, [self.auth.LOCAL_CALLER])
        self.assertEqual(self.auth.LOCAL_CALLER.assertion, "")

    def test_unknown_api_paths_answer_a_404_envelope_and_never_the_shell(self):
        cases = [
            ("GET", "/api/nope"),
            ("GET", "/api/"),
            ("GET", "/api"),
            ("POST", "/api/nope"),
            ("PUT", "/api/sessions"),
            ("DELETE", "/api/sessions/x"),
            ("GET", "/api/sessions/x/tasks"),
            ("POST", "/api/config"),
            ("GET", "/api/openapi.json"),
            ("OPTIONS", "/api/nope"),
            ("HEAD", "/api/nope"),
        ]
        with TestClient(self.module.app) as client:
            for method, path in cases:
                with self.subTest(route=f"{method} {path}"):
                    response = client.request(method, path)

                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(response.headers["content-type"].split(";")[0], "application/json")
                    self.assertEqual(response.headers["cache-control"], "no-store")
                    if method != "HEAD":
                        error = response.json()["error"]
                        self.assertEqual((error["code"], error["retryable"]), ("not_found", False))
                        self.assertRegex(error["operationId"], r"^[0-9a-f]{32}$")
            shell = [client.get(path) for path in ("/apiary", "/nope", "/sessions/abc")]

        self.assertEqual([(r.status_code, r.text) for r in shell], [(200, '<div id="root"></div>')] * 3)

    def test_the_built_in_documentation_routes_do_not_exist_and_fall_through_to_the_shell(self):
        with TestClient(self.module.app) as client:
            answers = [client.get(path) for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect")]

        self.assertEqual((self.module.app.docs_url, self.module.app.redoc_url, self.module.app.openapi_url), (None, None, None))
        self.assertEqual([(r.status_code, r.text) for r in answers], [(200, '<div id="root"></div>')] * 4)

    def test_there_is_no_token_broker(self):
        with TestClient(self.module.app) as client:
            answers = [
                client.post("/api/agent/token", json={"nonce": "n" * 43}),
                client.post("/api/agent/token", json={"nonce": "n" * 43}, headers={"Authorization": f"Bearer {TOKEN}"}),
                client.post("/api/agent/token", content=b"junk"),
            ]

        for response in answers:
            error = response.json()["error"]
            self.assertEqual((response.status_code, error["code"], error["retryable"]), (404, "not_found", False))


if __name__ == "__main__":
    unittest.main()
