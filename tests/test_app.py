import importlib
import json
import logging
import os
import re
import subprocess
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi.testclient import TestClient


def mimetype(response):
    return response.headers["content-type"].split(";")[0].strip()


# Split so the pattern does not match its own source and exempt this file from the sweep.
ACCOUNT_IDENTIFIER = r"ME-" r"MngEnv\w*|@microsoft\.com"


SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111"
SUBSCRIPTION_NAME = "Example Subscription"
RESOURCE_GROUP = "rg-ahm-demo"
MODEL_NAME = "hm-ahm-demo"
MODEL_LOCATION = "northeurope"
SIGNAL_NAME = "web-ui-health-report"


def ns(**values):
    return SimpleNamespace(**values)


def signal(
    name,
    state,
    reported_at,
    *,
    kind="External",
    value=None,
    additional_context=None,
):
    return ns(
        name=name,
        display_name=name.replace("-", " ").title(),
        signal_kind=kind,
        status=ns(
            health_state=state,
            value=value,
            reported_at=reported_at,
            additional_context=additional_context,
        ),
    )


def entity(
    name,
    display_name,
    state,
    impact,
    position,
    *,
    signals=(),
    discovered_by=None,
):
    groups = {}
    if signals:
        groups["external"] = ns(signals=list(signals))
    return ns(
        id=(
            f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
            f"/providers/Microsoft.CloudHealth/healthmodels/{MODEL_NAME}"
            f"/entities/{name}"
        ),
        name=name,
        properties=ns(
            display_name=display_name,
            health_state=state,
            impact=impact,
            canvas_position=(
                ns(x=position[0], y=position[1]) if position is not None else None
            ),
            discovered_by=discovered_by,
            signal_groups=groups,
        ),
    )


def relationship(name, parent, child, display_name):
    return ns(
        name=name,
        properties=ns(
            parent_entity_name=parent,
            child_entity_name=child,
            display_name=display_name,
        ),
    )


class SourceLayoutContractTests(unittest.TestCase):
    def test_authored_sources_have_one_final_layout(self):
        root = Path(__file__).parents[1]
        expected = {
            "azure.yaml",
            "infra/main.bicep",
            "infra/main.parameters.json",
            "scripts/hooks/preprovision.sh",
            "scripts/hooks/postprovision.sh",
            "src/web/Dockerfile",
            "src/web/requirements.txt",
            "src/web/app/main.py",
            "src/web/ui/package.json",
            "src/agent-web/package.json",
            "src/agent-web/src/app/page.tsx",
            "src/agent-app/src/main.py",
            "src/agent-app/tests/test_health_api.py",
        }

        self.assertEqual(
            sorted(path for path in expected if not (root / path).is_file()),
            [],
        )
        self.assertFalse((root / "app").exists())
        self.assertFalse((root / "copilot").exists())
        self.assertEqual(
            sorted(path.name for path in (root / "infra").glob("*.bicep")),
            ["main.bicep"],
        )
        self.assertEqual(
            sorted(
                str(path.relative_to(root))
                for path in (root / "scripts").rglob("*")
                if path.is_file()
            ),
            [
                "scripts/demo-failure.sh",
                "scripts/hooks/postprovision.sh",
                "scripts/hooks/preprovision.sh",
                "scripts/local-env.sh",
            ],
        )
        self.assertEqual(
            {path.name for path in (root / "tests").glob("test_*.py")},
            {"test_app.py", "test_streaming_proxy.py"},
        )


SCENE_SHOT_COUNTS = {
    "scene-1-noise.md": 4,
    "scene-2-health-models.md": 7,
    "scene-3-azure-monitor.md": 5,
    "scene-4-context-ai-ops.md": 5,
    "scene-5-closing.md": 1,
}

SCENE_3_SIGNAL_SOURCES = (
    "Application Insights",
    "Log Analytics",
    "Azure Metrics Explorer",
    "Azure Monitor workspace",
    "Resource Health",
    "Service Health",
    "Azure Resource Manager",
    "Activity Log",
)


class StoryboardSceneGuideTests(unittest.TestCase):
    def test_scene_guides_cover_every_storyboard_shot_and_signal_source(self):
        scenes = Path(__file__).parents[1] / "docs" / "scenes"

        self.assertEqual(
            sorted(path.name for path in scenes.glob("*.md")),
            sorted(["README.md", *SCENE_SHOT_COUNTS]),
        )

        missing_shots = {}
        unresolved_paths = {}
        for name, shots in SCENE_SHOT_COUNTS.items():
            body = (scenes / name).read_text(encoding="utf-8")
            headings = re.findall(r"^## Shot (\d+)\b", body, flags=re.MULTILINE)
            if headings != [str(index) for index in range(1, shots + 1)]:
                missing_shots[name] = headings
            for referenced in re.findall(
                r"(?:scripts|infra|src|docs)/[^\s`)*]+", body
            ):
                referenced = referenced.rstrip(".,:;")
                if not (Path(__file__).parents[1] / referenced).exists():
                    unresolved_paths.setdefault(name, []).append(referenced)

        unresolved_icons = {}
        for name in ["README.md", *SCENE_SHOT_COUNTS]:
            body = (scenes / name).read_text(encoding="utf-8")
            for icon in re.findall(r"\./icons/([\w.-]+\.svg)", body):
                if not (scenes / "icons" / icon).is_file():
                    unresolved_icons.setdefault(name, []).append(icon)

        self.assertEqual(missing_shots, {})
        self.assertEqual(unresolved_paths, {})
        self.assertEqual(unresolved_icons, {})
        self.assertTrue((scenes / "icons" / "README.md").is_file())

    def test_tracked_files_carry_no_real_subscription_identity(self):
        # Everything git tracks is shareable, so a subscription id or account name may only
        # appear as an obviously synthetic placeholder (one repeated hex digit).
        root = Path(__file__).parents[1]
        tracked = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=root,
            capture_output=True,
            check=True,
        ).stdout.split(b"\0")
        account = re.compile(ACCOUNT_IDENTIFIER, re.IGNORECASE)
        subscription = re.compile(
            r"SUBSCRIPTION_ID\W{0,4}"
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            re.IGNORECASE,
        )
        synthetic = re.compile(r"^([0-9a-f])\1{7}(-\1{4}){3}-\1{12}$", re.IGNORECASE)

        leaked = {}
        for raw in tracked:
            name = raw.decode()
            path = root / name
            if not name or not path.is_file() or name.startswith("docs/scenes/icons/"):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            hits = sorted(
                set(account.findall(text))
                | {
                    guid
                    for guid in subscription.findall(text)
                    if not synthetic.match(guid)
                }
            )
            if hits:
                leaked[name] = hits

        self.assertEqual(leaked, {})

    def test_scene_guides_carry_no_environment_identifiers(self):
        # The guides are handed to an external video crew, so they must describe the demo
        # without naming the account it runs in.
        forbidden = re.compile(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
            r"|" + ACCOUNT_IDENTIFIER + r""
            r"|/subscriptions/"
            r"|AZURE_MUTATION_COORDINATION_ACK",
            re.IGNORECASE,
        )
        scenes = Path(__file__).parents[1] / "docs" / "scenes"

        leaked = {
            path.name: sorted(set(forbidden.findall(path.read_text(encoding="utf-8"))))
            for path in sorted(scenes.rglob("*.md"))
            if forbidden.search(path.read_text(encoding="utf-8"))
        }

        self.assertEqual(leaked, {})

        scene_three = (scenes / "scene-3-azure-monitor.md").read_text(encoding="utf-8")
        self.assertEqual(
            [source for source in SCENE_3_SIGNAL_SOURCES if source not in scene_three],
            [],
        )

    def test_availability_test_name_agrees_across_infrastructure(self):
        modules = Path(__file__).parents[1] / "infra" / "modules"
        pattern = r"param availabilityTestName string = '([^']+)'"

        names = {
            path.name: re.search(pattern, path.read_text(encoding="utf-8")).group(1)
            for path in (
                modules / "availability-tests.bicep",
                modules / "health-model-entities.bicep",
            )
        }

        self.assertEqual(len(set(names.values())), 1, names)


def catalog_model(name, resource_group, location, provisioning_state="Succeeded"):
    return ns(
        id=(
            f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{resource_group}"
            f"/providers/Microsoft.CloudHealth/healthmodels/{name}"
        ),
        name=name,
        location=location,
        properties=ns(provisioning_state=provisioning_state),
    )


class RecordingHealthModels:
    def __init__(self, model):
        self.model = model
        self.calls = []
        self.list_calls = []
        self.error = None
        self.list_error = None
        self.catalog = [
            catalog_model("hm-zulu", RESOURCE_GROUP, MODEL_LOCATION),
            catalog_model(MODEL_NAME, RESOURCE_GROUP, MODEL_LOCATION),
            catalog_model("hm-alpha", "rg-other", "westeurope", "Creating"),
        ]

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        return self.model

    def list_by_subscription(self, *args, **kwargs):
        self.list_calls.append((args, kwargs))
        if self.list_error:
            raise self.list_error
        return iter(list(self.catalog))


class RecordingEntities:
    def __init__(self, entities):
        self.items = entities
        self.list_calls = []
        self.get_calls = []
        self.history_calls = []
        self.signal_history_calls = []
        self.ingest_calls = []
        self.list_error = None
        self.ingest_error = None
        self.signal_history_error = None
        self.history = ns(
            history=[
                ns(
                    new_state="Degraded",
                    occurred_at="2026-07-26T14:02:00Z",
                    previous_state="Healthy",
                    reason="Dependency health changed",
                ),
                ns(
                    new_state="Healthy",
                    occurred_at="2026-07-26T13:01:00Z",
                    previous_state="Unknown",
                    reason="Signals recovered",
                ),
            ],
            next_marker=None,
        )
        self.signal_history = ns(
            history=[
                ns(
                    health_state="Degraded",
                    value=0.5,
                    occurred_at="2026-07-26T14:01:30Z",
                    additional_context=json.dumps(
                        {
                            "source": "health-pulse-web",
                            "reportId": "report-correlated",
                            "reason": "Maintenance window",
                        }
                    ),
                )
            ],
            next_marker=None,
        )

    def list_by_health_model(self, *args, **kwargs):
        self.list_calls.append((args, kwargs))
        if self.list_error:
            raise self.list_error
        return list(self.items)

    def get(self, resource_group_name, health_model_name, entity_name, **kwargs):
        self.get_calls.append(
            ((resource_group_name, health_model_name, entity_name), kwargs)
        )
        for current in self.items:
            if current.name == entity_name:
                return current
        raise KeyError(entity_name)

    def get_history(self, *args, **kwargs):
        self.history_calls.append((args, kwargs))
        return self.history

    def get_signal_history(self, *args, **kwargs):
        self.signal_history_calls.append((args, kwargs))
        if self.signal_history_error:
            raise self.signal_history_error
        return self.signal_history

    def ingest_health_report(self, *args, **kwargs):
        self.ingest_calls.append((args, kwargs))
        if self.ingest_error:
            raise self.ingest_error
        return None


class RecordingRelationships:
    def __init__(self, relationships):
        self.items = relationships
        self.calls = []

    def list_by_health_model(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return list(self.items)


class RecordingCloudClient:
    def __init__(self, model, entities, relationships):
        self.health_models = RecordingHealthModels(model)
        self.entities = RecordingEntities(entities)
        self.relationships = RecordingRelationships(relationships)


class HealthReportUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.environment = {
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
            "QUEUE_URL": "https://example.queue.core.windows.net/requests",
            "POSTGRES_HOST": "pg.example.postgres.database.azure.com",
            "POSTGRES_DATABASE": "demo",
            "POSTGRES_USER": "id-ahm-demo-app",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": (
                "InstrumentationKey=00000000-0000-0000-0000-000000000000"
            ),
            "AZURE_SUBSCRIPTION_ID": SUBSCRIPTION_ID,
            "AZURE_SUBSCRIPTION_NAME": SUBSCRIPTION_NAME,
            "AZURE_RESOURCE_GROUP": RESOURCE_GROUP,
            "HEALTH_MODEL_NAME": MODEL_NAME,
            "HEALTH_MODEL_LOCATION": MODEL_LOCATION,
        }
        cls.env_patch = mock.patch.dict(os.environ, cls.environment, clear=False)
        cls.env_patch.start()

        cls.credential = mock.Mock(name="default_azure_credential")
        cls.bootstrap_cloud = mock.Mock(name="bootstrap_cloud_client")
        cls.patchers = [
            mock.patch(
                "azure.identity.DefaultAzureCredential",
                return_value=cls.credential,
            ),
            mock.patch(
                "azure.storage.queue.QueueClient.from_queue_url",
                return_value=mock.Mock(name="queue_client"),
            ),
            mock.patch(
                "azure.monitor.opentelemetry.configure_azure_monitor",
            ),
            mock.patch(
                "azure.mgmt.cloudhealth.CloudHealthMgmtClient",
                return_value=cls.bootstrap_cloud,
            ),
        ]
        for patcher in cls.patchers:
            patcher.start()

        app_path = os.path.join(
            os.path.dirname(__file__), "..", "src", "web", "app"
        )
        sys.path.insert(0, os.path.abspath(app_path))
        for name in (
            "main",
            "config",
            "dto",
            "inventory",
            "reports",
            "journey",
            "agent_proxy",
            "errors",
        ):
            sys.modules.pop(name, None)
        cls.module = importlib.import_module("main")
        cls.inventory = importlib.import_module("inventory")
        cls.config = importlib.import_module("config")

    @classmethod
    def tearDownClass(cls):
        for patcher in reversed(cls.patchers):
            patcher.stop()
        cls.env_patch.stop()

    def setUp(self):
        self.now = "2026-07-26T15:00:00Z"
        self.entities = [
            entity(
                MODEL_NAME,
                "Movie Request Experience",
                "Healthy",
                "Standard",
                (500, 40),
                signals=[
                    signal(
                        SIGNAL_NAME,
                        "Healthy",
                        "2026-07-26T14:00:00Z",
                        value=1,
                        additional_context=json.dumps(
                            {
                                "source": "health-pulse-web",
                                "reportId": "report-correlated",
                                "reason": "Recovery confirmed",
                            }
                        ),
                    ),
                    signal(
                        "database-connectivity-probe",
                        "Healthy",
                        "2026-07-26T13:59:00Z",
                        value=1,
                    ),
                ],
            ),
            entity(
                "api",
                "Request API",
                "Degraded",
                "Standard",
                (300, 220),
                signals=[
                    signal(
                        SIGNAL_NAME,
                        "Degraded",
                        "2026-07-26T14:01:00Z",
                        value=0.5,
                    )
                ],
            ),
            entity(
                "database",
                "PostgreSQL",
                "Unhealthy",
                "Standard",
                (120, 430),
                signals=[
                    signal(
                        "database-alive",
                        "Unhealthy",
                        "2026-07-26T13:58:00Z",
                        kind="AzureResourceMetric",
                        value=0,
                    )
                ],
            ),
            entity(
                "orphan-<script>",
                "Discovered <img src=x onerror=alert(1)>",
                "Unknown",
                "Suppressed",
                None,
                discovered_by="discover-app-insights",
            ),
        ]
        self.relationships = [
            relationship("r-root-api", MODEL_NAME, "api", "serves"),
            relationship("r-api-db", "api", "database", "persists"),
        ]
        self.model = ns(
            id=(
                f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/{RESOURCE_GROUP}"
                f"/providers/Microsoft.CloudHealth/healthmodels/{MODEL_NAME}"
            ),
            name=MODEL_NAME,
            location=MODEL_LOCATION,
            properties=ns(
                provisioning_state="Succeeded",
                health_state="Healthy",
            ),
        )
        self.cloud = RecordingCloudClient(
            self.model, self.entities, self.relationships
        )
        self.module.health_client = self.cloud
        self.client = TestClient(self.module.app, follow_redirects=False)

        self.enqueue = mock.patch.object(
            self.module,
            "enqueue_event",
            return_value={
                "request_id": "journey-request",
                "message_id": "queue-message",
                "created_at": self.now,
            },
        )
        self.insert = mock.patch.object(
            self.module, "insert_event_and_count", return_value=73
        )
        self.peek = mock.patch.object(
            self.module,
            "peek_queue_head",
            return_value={
                "label": "oldest visible / best-effort FIFO",
                "message_id": "oldest-message",
                "request_id": "oldest-request",
                "created_at": "2026-07-25T10:00:00Z",
                "dequeue_count": 0,
            },
        )
        self.enqueue_mock = self.enqueue.start()
        self.insert_mock = self.insert.start()
        self.peek_mock = self.peek.start()

    def tearDown(self):
        self.peek.stop()
        self.insert.stop()
        self.enqueue.stop()

    def assert_security_headers(self, response):
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(
            response.headers["Content-Security-Policy"],
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
            "frame-src 'self'; frame-ancestors 'none'",
        )

    def test_plain_root_is_side_effect_free_ui(self):
        with mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "false"}):
            response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mimetype(response), "text/html")
        body = response.text
        self.assertIn('id="root"', body)
        self.assertRegex(body, r"/assets/index-[\w-]+\.js")
        self.assertNotIn("The Health Pulse", body)
        self.assertNotIn("displayName", body)
        self.assertNotIn("'unsafe-inline'", body)
        self.enqueue_mock.assert_not_called()
        self.insert_mock.assert_not_called()
        self.peek_mock.assert_not_called()
        self.assertEqual(self.cloud.entities.list_calls, [])
        self.assert_security_headers(response)

    def test_invalid_compatibility_formats_are_safe_and_side_effect_free(self):
        cases = [
            "/?format=",
            "/?format=invalid",
            "/?format=xml",
            "/?format=JSON",
            "/?format=%20html%20",
            "/?format=json&format=html",
        ]

        class RecordingHandler(logging.Handler):
            def __init__(self):
                super().__init__()
                self.records = []

            def emit(self, record):
                self.records.append(record)

        for path in cases:
            with self.subTest(path=path):
                handler = RecordingHandler()
                self.module.logger.addHandler(handler)
                try:
                    response = self.client.get(path)
                finally:
                    self.module.logger.removeHandler(handler)

                self.assertEqual(response.status_code, 400)
                self.assertEqual(mimetype(response), "application/json")
                payload = response.json()
                self.assertEqual(payload["error"]["code"], "invalid_format")
                operation_id = payload["error"]["operationId"]
                self.assertRegex(operation_id, r"^[0-9a-f]{32}$")
                self.assertEqual(response.headers["X-Operation-ID"], operation_id)
                self.enqueue_mock.assert_not_called()
                self.insert_mock.assert_not_called()
                self.peek_mock.assert_not_called()
                self.assertEqual(self.cloud.health_models.calls, [])
                self.assertEqual(self.cloud.entities.list_calls, [])
                self.assertEqual(self.cloud.relationships.calls, [])
                self.assertFalse(
                    any(
                        record.levelno >= logging.ERROR or record.exc_info
                        for record in handler.records
                    )
                )
                self.assert_security_headers(response)

    def test_enabled_copilot_is_an_exact_origin_parent_owned_surface(self):
        with mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}):
            response = self.client.get("/")

        body = response.text
        self.assertEqual(response.status_code, 200)
        self.assertEqual(mimetype(response), "text/html")
        self.assertIn('id="root"', body)
        self.assertRegex(body, r"/assets/index-[\w-]+\.js")
        self.assertNotIn("copilot.example", body)
        self.assertNotIn("app-ahm-health-copilot", body)
        self.assertNotIn("COPILOT_URL", body)
        self.assertNotIn("//copilot", body)
        self.assert_security_headers(response)

    def test_invalid_copilot_enablement_fails_closed(self):
        for flag in ["false", "1", "yes", "enabled", "true-ish"]:
            with self.subTest(flag=flag):
                with mock.patch.dict(
                    os.environ,
                    {"HEALTH_COPILOT_ENABLED": flag},
                ):
                    shell = self.client.get("/")
                    agent = self.client.get("/agent")
                self.assertEqual(shell.status_code, 200)
                self.assertEqual(agent.status_code, 404)
                self.assertEqual(agent.json()["error"]["code"], "agent_disabled")

    def test_agent_proxy_preserves_request_response_and_strips_unsafe_headers(self):
        seen = []

        def upstream(request):
            body = request.read()
            seen.append((request, body))
            return httpx.Response(
                202,
                headers={
                    "Content-Type": "application/json",
                    "Content-Encoding": "identity",
                    "Cache-Control": "no-cache",
                    "Connection": "x-internal",
                    "X-Internal": "do-not-forward",
                    "Set-Cookie": "session=secret",
                    "Content-Length": "999",
                },
                stream=httpx.ByteStream(b'{"status":"accepted"}'),
            )

        client = httpx.Client(transport=httpx.MockTransport(upstream))
        with (
            mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}),
            mock.patch.object(
                self.module,
                "_agent_client_factory",
                return_value=client,
            ),
        ):
            response = self.client.post(
                "/agent/api/copilotkit/default/run?thread=one&thread=two",
                content=b'{"message":"hello"}',
                headers={
                    "content-type": "application/json",
                    "Cookie": "caller=secret",
                    "X-Forwarded-Host": "evil.example",
                    "Connection": "x-caller",
                    "X-Caller": "do-not-forward",
                },
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.content, b'{"status":"accepted"}')
        self.assertEqual(response.headers["Content-Type"], "application/json")
        self.assertEqual(response.headers["Content-Encoding"], "identity")
        self.assertEqual(response.headers["Cache-Control"], "no-cache")
        for name in [
            "Connection",
            "X-Internal",
            "Set-Cookie",
            "Content-Length",
        ]:
            self.assertNotIn(name, response.headers)
        self.assertEqual(len(seen), 1)
        request, body = seen[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.host, "127.0.0.1")
        self.assertEqual(request.url.port, 3000)
        self.assertEqual(request.url.path, "/agent/api/copilotkit/default/run")
        self.assertEqual(
            list(request.url.params.multi_items()),
            [("thread", "one"), ("thread", "two")],
        )
        self.assertEqual(body, b'{"message":"hello"}')
        self.assertEqual(request.headers["host"], "127.0.0.1:3000")
        for name in ["cookie", "x-forwarded-host", "x-caller"]:
            self.assertNotIn(name, request.headers)

    def test_agent_proxy_streams_raw_sse_in_order_and_closes(self):
        class DelayedStream(httpx.SyncByteStream):
            def __init__(self):
                self.closed = False

            def __iter__(self):
                yield b"event: start\ndata: one\n\n"
                time.sleep(0.08)
                yield b"event: finish\ndata: two\n\n"

            def close(self):
                self.closed = True

        stream = DelayedStream()

        def upstream(_request):
            return httpx.Response(
                200,
                headers={
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache",
                },
                stream=stream,
            )

        client = httpx.Client(transport=httpx.MockTransport(upstream))
        with (
            mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}),
            mock.patch.object(
                self.module,
                "_agent_client_factory",
                return_value=client,
            ),
        ):
            with self.client.stream(
                "GET", "/agent/api/copilotkit/default/run"
            ) as response:
                chunks = list(response.iter_raw())

        self.assertEqual(
            b"".join(chunks),
            (
                b"event: start\ndata: one\n\n"
                b"event: finish\ndata: two\n\n"
            ),
        )
        self.assertTrue(stream.closed)

    def test_agent_proxy_disconnect_closes_upstream_stream(self):
        class OpenStream(httpx.SyncByteStream):
            def __init__(self):
                self.closed = False

            def __iter__(self):
                yield b"event: RUN_STARTED\ndata: one\n\n"
                yield b"event: TEXT_MESSAGE_CONTENT\ndata: two\n\n"

            def close(self):
                self.closed = True

        stream = OpenStream()
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200,
                    headers={"Content-Type": "text/event-stream"},
                    stream=stream,
                )
            )
        )
        with (
            mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}),
            mock.patch.object(
                self.module,
                "_agent_client_factory",
                return_value=client,
            ),
        ):
            with self.client.stream(
                "GET", "/agent/api/copilotkit/default/run"
            ) as response:
                iterator = response.iter_raw()
                self.assertIn(b"RUN_STARTED", next(iterator))

        self.assertTrue(stream.closed)

    def test_agent_proxy_rejects_unapproved_inputs_before_upstream(self):
        upstream = mock.Mock(
            side_effect=AssertionError("upstream must not be reached")
        )
        client = httpx.Client(transport=httpx.MockTransport(upstream))
        cases = [
            ("method", "OPTIONS", "/agent", None, None, 405),
            ("path", "GET", "/agent/private", None, None, 404),
            (
                "content-type",
                "POST",
                "/agent/api/copilotkit/default/run",
                b"body",
                "text/plain",
                415,
            ),
            (
                "body-size",
                "POST",
                "/agent/api/copilotkit/default/run",
                b"x" * (1_048_576 + 1),
                "application/json",
                413,
            ),
        ]
        for label, method, path, body, content_type, expected in cases:
            with self.subTest(label=label):
                with (
                    mock.patch.dict(
                        os.environ,
                        {"HEALTH_COPILOT_ENABLED": "true"},
                    ),
                    mock.patch.object(
                        self.module,
                        "_agent_client_factory",
                        return_value=client,
                    ),
                ):
                    headers = (
                        {"content-type": content_type} if content_type else None
                    )
                    response = self.client.request(
                        method,
                        path,
                        content=body,
                        headers=headers,
                    )
                self.assertEqual(response.status_code, expected)
        upstream.assert_not_called()

    def test_agent_proxy_saturation_is_bounded_before_upstream(self):
        slots = mock.Mock()
        slots.acquire.return_value = False
        with (
            mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}),
            mock.patch.object(self.module, "_agent_proxy_slots", slots),
            mock.patch.object(
                self.module,
                "_agent_client_factory",
                side_effect=AssertionError("upstream must not be reached"),
            ),
        ):
            response = self.client.get("/agent")

        payload = response.json()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["error"]["code"], "agent_proxy_saturated")
        self.assertTrue(payload["error"]["retryable"])
        self.assertRegex(payload["error"]["operationId"], r"^[0-9a-f]{32}$")

    def test_agent_proxy_sanitizes_redirects_and_bounds_upstream_failure(self):
        cases = [
            (
                "same-upstream",
                httpx.Response(
                    307,
                    headers={
                        "Location": (
                            "http://127.0.0.1:3000/agent"
                            "/api/copilotkit?resume=1"
                        )
                    },
                    stream=httpx.ByteStream(b""),
                ),
                307,
                "/agent/api/copilotkit?resume=1",
            ),
            (
                "foreign-upstream",
                httpx.Response(
                    302,
                    headers={"Location": "https://evil.example/steal"},
                    stream=httpx.ByteStream(b""),
                ),
                502,
                None,
            ),
        ]
        for label, upstream_response, expected_status, expected_location in cases:
            with self.subTest(label=label):
                client = httpx.Client(
                    transport=httpx.MockTransport(
                        lambda _request, value=upstream_response: value
                    )
                )
                with (
                    mock.patch.dict(
                        os.environ,
                        {"HEALTH_COPILOT_ENABLED": "true"},
                    ),
                    mock.patch.object(
                        self.module,
                        "_agent_client_factory",
                        return_value=client,
                    ),
                ):
                    response = self.client.get("/agent")
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(
                    response.headers.get("Location"),
                    expected_location,
                )
                self.assertNotIn("127.0.0.1", response.text)
                self.assertNotIn("evil.example", response.text)

        failing_client = mock.Mock()
        failing_client.build_request.return_value = mock.sentinel.request
        failing_client.send.side_effect = httpx.ConnectError(
            "secret upstream detail",
            request=httpx.Request("GET", "http://127.0.0.1:3000/agent"),
        )
        with (
            mock.patch.dict(os.environ, {"HEALTH_COPILOT_ENABLED": "true"}),
            mock.patch.object(
                self.module,
                "_agent_client_factory",
                return_value=failing_client,
            ),
        ):
            response = self.client.get("/agent")
        payload = response.json()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(payload["error"]["code"], "agent_web_unavailable")
        self.assertRegex(payload["error"]["operationId"], r"^[0-9a-f]{32}$")
        self.assertNotIn("secret upstream detail", response.text)

    def test_model_read_returns_rich_dynamic_inventory_once(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["model"],
            {
                "id": self.model.id,
                "name": MODEL_NAME,
                "location": MODEL_LOCATION,
                "provisioningState": "Succeeded",
                "healthState": "Healthy",
            },
        )
        self.assertEqual(
            [item["name"] for item in payload["entities"]],
            [MODEL_NAME, "api", "database", "orphan-<script>"],
        )
        root, api, database, orphan = payload["entities"]
        self.assertEqual(root["canvasPosition"], {"x": 500, "y": 40})
        self.assertEqual(root["parents"], [])
        self.assertEqual(root["children"], ["api"])
        self.assertEqual(root["latestEvaluationAt"], "2026-07-26T14:00:00Z")
        self.assertTrue(root["report"]["eligible"])
        self.assertEqual(root["report"]["signalName"], SIGNAL_NAME)
        reserved = next(
            item
            for item in root["signals"]
            if item["name"] == "database-connectivity-probe"
        )
        self.assertFalse(reserved["writable"])
        self.assertEqual(api["parents"], [MODEL_NAME])
        self.assertEqual(database["parents"], ["api"])
        self.assertIsNone(orphan["canvasPosition"])
        self.assertTrue(orphan["unlinked"])
        self.assertEqual(orphan["displayName"], "Discovered <img src=x onerror=alert(1)>")
        self.assertEqual(orphan["healthState"], "Unknown")
        self.assertEqual(
            payload["relationships"],
            [
                {
                    "name": "r-root-api",
                    "displayName": "serves",
                    "parentEntityName": MODEL_NAME,
                    "childEntityName": "api",
                },
                {
                    "name": "r-api-db",
                    "displayName": "persists",
                    "parentEntityName": "api",
                    "childEntityName": "database",
                },
            ],
        )
        self.assertEqual(
            payload["reportOptions"]["healthStates"],
            ["Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"],
        )
        self.assertEqual(payload["reportOptions"]["values"], [None, 0, 0.5, 1])
        self.assertEqual(payload["reportOptions"]["expiries"], [1, 5, 15, 30, 60, 120])
        self.assertEqual(len(self.cloud.health_models.calls), 1)
        self.assertEqual(len(self.cloud.entities.list_calls), 1)
        self.assertEqual(len(self.cloud.relationships.calls), 1)
        self.enqueue_mock.assert_not_called()
        self.insert_mock.assert_not_called()
        self.peek_mock.assert_not_called()
        self.assert_security_headers(response)

    def test_model_read_is_fresh_and_does_not_persist(self):
        first = self.client.get("/api/health-model")
        second = self.client.get("/api/health-model")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(len(self.cloud.health_models.calls), 2)
        self.assertEqual(len(self.cloud.entities.list_calls), 2)
        self.assertEqual(len(self.cloud.relationships.calls), 2)
        self.enqueue_mock.assert_not_called()
        self.insert_mock.assert_not_called()
        self.peek_mock.assert_not_called()

    def test_detail_uses_exact_entity_and_server_owned_history_window(self):
        response = self.client.get("/api/entities/api")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["entity"]["name"], "api")
        self.assertEqual(payload["canonicalSignal"]["name"], SIGNAL_NAME)
        self.assertEqual(
            payload["canonicalSignal"]["history"][0]["reportId"],
            "report-correlated",
        )
        self.assertEqual(
            payload["transitions"][0]["occurredAt"],
            "2026-07-26T14:02:00Z",
        )
        self.assertEqual(len(self.cloud.entities.list_calls), 1)
        self.assertEqual(len(self.cloud.entities.get_calls), 1)
        self.assertEqual(len(self.cloud.entities.history_calls), 1)
        self.assertEqual(len(self.cloud.entities.signal_history_calls), 1)
        history_args, history_kwargs = self.cloud.entities.history_calls[0]
        signal_args, signal_kwargs = self.cloud.entities.signal_history_calls[0]
        self.assertEqual(history_args[:3], (RESOURCE_GROUP, MODEL_NAME, "api"))
        self.assertEqual(signal_args[:3], (RESOURCE_GROUP, MODEL_NAME, "api"))
        history_request = history_args[3]
        signal_request = signal_args[3]
        self.assertNotIn("nextMarker", history_request)
        self.assertNotIn("nextMarker", signal_request)
        self.assertLessEqual(history_request["top"], 50)
        self.assertLessEqual(signal_request["top"], 50)
        self.assertEqual(signal_request["signalName"], SIGNAL_NAME)
        self.assertEqual(history_kwargs, {})
        self.assertEqual(signal_kwargs, {})
        self.assert_security_headers(response)

    def test_detail_rejects_caller_owned_history_controls(self):
        response = self.client.get(
            "/api/entities/api?signalName=database-connectivity-probe"
            "&startAt=2000-01-01&action=delete&nextMarker=caller"
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.cloud.entities.history_calls, [])
        self.assertEqual(self.cloud.entities.signal_history_calls, [])

    def test_unknown_entity_detail_returns_404_without_history(self):
        response = self.client.get("/api/entities/vanished")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "entity_not_found")
        self.assertEqual(self.cloud.entities.history_calls, [])
        self.assertEqual(self.cloud.entities.signal_history_calls, [])

    def test_valid_reports_make_exactly_one_ingest_call(self):
        cases = [
            ("Healthy", None, 1, "maintenance", None),
            ("Degraded", 0, 30, "investigating", None),
            ("Unhealthy", 0.5, 120, "custom", "Operator saw <script>alert(1)</script>"),
            ("Unknown", 1, 5, "demo-test", None),
            ("Deleted", None, 15, "recovery", None),
        ]

        for state, value, expiry, preset, custom_reason in cases:
            with self.subTest(
                state=state, value=value, expiry=expiry, preset=preset
            ):
                self.cloud.entities.ingest_calls.clear()
                body = {
                    "signalName": SIGNAL_NAME,
                    "healthState": state,
                    "value": value,
                    "expiresInMinutes": expiry,
                    "reasonPreset": preset,
                }
                if custom_reason is not None:
                    body["customReason"] = custom_reason

                response = self.client.post(
                    "/api/entities/api/health-reports",
                    json=body,
                )

                self.assertEqual(response.status_code, 202)
                payload = response.json()
                self.assertEqual(payload["status"], "accepted")
                self.assertEqual(payload["entityName"], "api")
                self.assertEqual(payload["signalName"], SIGNAL_NAME)
                self.assertEqual(payload["requestedState"], state)
                self.assertEqual(len(self.cloud.entities.ingest_calls), 1)
                args, kwargs = self.cloud.entities.ingest_calls[0]
                self.assertEqual(args[:3], (RESOURCE_GROUP, MODEL_NAME, "api"))
                report = args[3] if len(args) == 4 else kwargs["body"]
                self.assertEqual(report["signalName"], SIGNAL_NAME)
                self.assertEqual(report["healthState"], state)
                self.assertEqual(report["value"], value)
                self.assertEqual(report["expiresInMinutes"], expiry)
                self.assertNotIn("evaluationRules", report)
                context = json.loads(report["additionalContext"])
                self.assertEqual(context["source"], "health-pulse-web")
                self.assertEqual(context["reportId"], payload["reportId"])
                if custom_reason is not None:
                    self.assertEqual(context["reason"], custom_reason)
                self.assertLessEqual(len(report["additionalContext"]), 4096)
                self.assert_security_headers(response)

    def test_quick_report_buttons_send_one_complete_report_per_click(self):
        single_click = [
            ("Healthy", 1),
            ("Degraded", 0.5),
            ("Unhealthy", 0),
        ]
        panel_overrides = [
            ("Unhealthy", None, "investigating", 5),
            ("Degraded", 1, "maintenance", 60),
            ("Healthy", 0, "recovery", 120),
        ]

        for state, value in single_click:
            with self.subTest(click=state):
                self.cloud.entities.ingest_calls.clear()

                response = self.client.post(
                    "/api/entities/api/health-reports",
                    json={
                        "signalName": SIGNAL_NAME,
                        "healthState": state,
                        "value": value,
                        "expiresInMinutes": 30,
                        "reasonPreset": "demo-test",
                    },
                )

                self.assertEqual(response.status_code, 202)
                self.assertEqual(len(self.cloud.entities.ingest_calls), 1)
                report = self.cloud.entities.ingest_calls[0][0][3]
                self.assertEqual(report["healthState"], state)
                self.assertEqual(report["value"], value)
                self.assertEqual(report["expiresInMinutes"], 30)

        for state, value, preset, expiry in panel_overrides:
            with self.subTest(panel=state, preset=preset):
                self.cloud.entities.ingest_calls.clear()

                response = self.client.post(
                    "/api/entities/api/health-reports",
                    json={
                        "signalName": SIGNAL_NAME,
                        "healthState": state,
                        "value": value,
                        "expiresInMinutes": expiry,
                        "reasonPreset": preset,
                    },
                )

                self.assertEqual(response.status_code, 202)
                self.assertEqual(len(self.cloud.entities.ingest_calls), 1)
                report = self.cloud.entities.ingest_calls[0][0][3]
                self.assertEqual(report["healthState"], state)
                self.assertEqual(report["value"], value)
                self.assertEqual(report["expiresInMinutes"], expiry)

    def test_report_reason_transport_is_exact_and_legacy_presets_stay_compatible(self):
        self.cloud.entities.ingest_calls.clear()
        response = self.client.post(
            "/api/entities/api/health-reports",
            json={
                "signalName": SIGNAL_NAME,
                "healthState": "Healthy",
                "value": 1,
                "expiresInMinutes": 30,
                "reasonPreset": "recovery",
            },
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(len(self.cloud.entities.ingest_calls), 1)
        args, kwargs = self.cloud.entities.ingest_calls[0]
        report = args[3] if len(args) == 4 else kwargs["body"]
        context = json.loads(report["additionalContext"])
        self.assertEqual(context["reason"], "Recovery confirmed")

        self.cloud.entities.ingest_calls.clear()
        rejected = self.client.post(
            "/api/entities/api/health-reports",
            json={
                "signalName": SIGNAL_NAME,
                "healthState": "Healthy",
                "value": 1,
                "expiresInMinutes": 30,
                "reasonPreset": "maintenance",
                "reason": "Model supplied conflicting maintenance detail",
            },
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.json()["error"]["code"], "unknown_field")
        self.assertEqual(self.cloud.entities.ingest_calls, [])

    def test_invalid_reports_never_call_ingest(self):
        valid = {
            "signalName": SIGNAL_NAME,
            "healthState": "Healthy",
            "value": 1,
            "expiresInMinutes": 30,
            "reasonPreset": "maintenance",
        }
        cases = [
            ("content-type", "api", valid, "text/plain", 415),
            ("entity", "not-present", valid, "application/json", 404),
            (
                "signal",
                "api",
                {**valid, "signalName": "database-connectivity-probe"},
                "application/json",
                400,
            ),
            (
                "state",
                "api",
                {**valid, "healthState": "Error"},
                "application/json",
                400,
            ),
            (
                "value",
                "api",
                {**valid, "value": 0.25},
                "application/json",
                400,
            ),
            (
                "expiry",
                "api",
                {**valid, "expiresInMinutes": 1440},
                "application/json",
                400,
            ),
            (
                "unknown-key",
                "api",
                {**valid, "subscriptionId": SUBSCRIPTION_ID},
                "application/json",
                400,
            ),
            (
                "action",
                "api",
                {**valid, "action": "delete"},
                "application/json",
                400,
            ),
            (
                "model",
                "api",
                {**valid, "healthModelName": MODEL_NAME},
                "application/json",
                400,
            ),
            (
                "custom-reason-without-custom",
                "api",
                {**valid, "customReason": "caller text"},
                "application/json",
                400,
            ),
            (
                "missing-custom-reason",
                "api",
                {**valid, "reasonPreset": "custom"},
                "application/json",
                400,
            ),
        ]

        for label, entity_name, body, content_type, expected_status in cases:
            with self.subTest(label=label):
                self.cloud.entities.ingest_calls.clear()
                response = self.client.post(
                    f"/api/entities/{entity_name}/health-reports",
                    content=json.dumps(body),
                    headers={"content-type": content_type},
                )
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(self.cloud.entities.ingest_calls, [])

    def test_deleted_current_entity_is_not_reportable(self):
        self.entities[1].properties.health_state = "Deleted"

        response = self.client.post(
            "/api/entities/api/health-reports",
            json={
                "signalName": SIGNAL_NAME,
                "healthState": "Healthy",
                "value": 1,
                "expiresInMinutes": 30,
                "reasonPreset": "recovery",
            },
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.cloud.entities.ingest_calls, [])

    def test_demo_and_legacy_routes_preserve_write_contract(self):
        for method, path in [
            ("post", "/api/demo-request"),
            ("get", "/?format=json"),
            ("get", "/?format=html"),
        ]:
            with self.subTest(method=method, path=path):
                self.enqueue_mock.reset_mock()
                self.insert_mock.reset_mock()
                self.peek_mock.reset_mock()

                response = getattr(self.client, method)(path)

                self.assertEqual(response.status_code, 200)
                if path.endswith("html"):
                    self.assertEqual(mimetype(response), "text/html")
                else:
                    self.assertEqual(
                        set(response.json()),
                        {"request_id", "just_enqueued", "queue_head", "row_count"},
                    )
                self.enqueue_mock.assert_called_once()
                self.insert_mock.assert_called_once()
                self.peek_mock.assert_called_once()
                self.assert_security_headers(response)

    def test_sdk_errors_are_mapped_without_azure_details(self):
        from azure.core.exceptions import HttpResponseError

        cases = [
            (401, 503, False),
            (403, 503, False),
            (404, 404, False),
            (409, 409, True),
            (429, 503, True),
            (500, 503, True),
            (503, 503, True),
        ]
        for azure_status, expected_status, retryable in cases:
            with self.subTest(azure_status=azure_status):
                error = HttpResponseError(message="SECRET_AZURE_BODY token=do-not-leak")
                error.status_code = azure_status
                self.cloud.health_models.error = error
                with self.assertLogs("ahm-demo", level="WARNING") as captured:
                    response = self.client.get("/api/health-model")
                self.cloud.health_models.error = None

                self.assertEqual(response.status_code, expected_status)
                payload = response.json()
                self.assertEqual(payload["error"]["retryable"], retryable)
                self.assertEqual(len(payload["error"]["operationId"]), 32)
                self.assertNotIn("SECRET_AZURE_BODY", response.text)
                self.assertNotIn("do-not-leak", response.text)
                self.assertNotIn("SECRET_AZURE_BODY", "\n".join(captured.output))
                self.assertNotIn("do-not-leak", "\n".join(captured.output))

    def test_html_like_names_remain_data_and_headers_are_restrictive(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["entities"][-1]["displayName"],
            "Discovered <img src=x onerror=alert(1)>",
        )
        root = self.client.get("/")
        self.assertNotIn("unsafe-inline", root.headers["Content-Security-Policy"])
        self.assert_security_headers(root)

    def test_missing_runtime_config_fails_at_import_and_names_every_gap(self):
        exact = dict(self.environment)
        required = self.module.require_runtime_config(exact)
        self.assertEqual(
            required,
            {
                "subscription_id": SUBSCRIPTION_ID,
                "resource_group": RESOURCE_GROUP,
                "model_name": MODEL_NAME,
            },
        )

        for key in (
            "APPLICATIONINSIGHTS_CONNECTION_STRING",
            "AZURE_RESOURCE_GROUP",
            "AZURE_SUBSCRIPTION_ID",
            "HEALTH_MODEL_NAME",
            "POSTGRES_HOST",
            "POSTGRES_USER",
            "QUEUE_URL",
        ):
            for label, blanked in (("absent", None), ("blank", "   ")):
                with self.subTest(key=key, case=label):
                    candidate = dict(exact)
                    if blanked is None:
                        candidate.pop(key)
                    else:
                        candidate[key] = blanked
                    with self.assertRaises(RuntimeError) as caught:
                        self.module.require_runtime_config(candidate)
                    self.assertIn(key, str(caught.exception))

        stripped = {
            key: value
            for key, value in exact.items()
            if key not in self.config.REQUIRED_ENV
        }
        with self.assertRaises(RuntimeError) as caught:
            self.module.require_runtime_config(stripped)
        message = str(caught.exception)
        for key in self.config.REQUIRED_ENV:
            self.assertIn(key, message)

    def test_arm_id_yields_its_resource_group_or_nothing(self):
        cases = [
            (
                f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-other"
                f"/providers/Microsoft.CloudHealth/healthmodels/hm-alpha",
                "rg-other",
            ),
            (
                f"/subscriptions/{SUBSCRIPTION_ID}/resourcegroups/rg-lower"
                f"/providers/Microsoft.CloudHealth/healthmodels/hm-alpha",
                "rg-lower",
            ),
            (f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups", None),
            ("", None),
            (None, None),
        ]

        for resource_id, expected in cases:
            with self.subTest(resource_id=resource_id):
                self.assertEqual(
                    self.inventory.resource_group_from_id(resource_id), expected
                )

    def test_catalog_lists_every_visible_model_in_stable_order(self):
        response = self.client.get("/api/health-models")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload), {"models", "default"})
        self.assertEqual(
            payload["default"],
            {"resourceGroup": RESOURCE_GROUP, "name": MODEL_NAME},
        )
        self.assertEqual(
            [(item["resourceGroup"], item["name"]) for item in payload["models"]],
            [
                (RESOURCE_GROUP, MODEL_NAME),
                (RESOURCE_GROUP, "hm-zulu"),
                ("rg-other", "hm-alpha"),
            ],
        )
        self.assertEqual(
            set(payload["models"][0]),
            {"id", "name", "resourceGroup", "location", "provisioningState"},
        )
        self.assertEqual(payload["models"][2]["location"], "westeurope")
        self.assertEqual(payload["models"][2]["provisioningState"], "Creating")

    def test_unreadable_or_empty_catalog_degrades_to_the_configured_model(self):
        from azure.core.exceptions import HttpResponseError

        forbidden = HttpResponseError(message="forbidden")
        forbidden.status_code = 403
        unauthorized = HttpResponseError(message="unauthorized")
        unauthorized.status_code = 401
        cases = [
            ("forbidden", forbidden, None),
            ("unauthorized", unauthorized, None),
            ("empty", None, []),
        ]

        for label, error, catalog in cases:
            with self.subTest(label=label):
                self.cloud.health_models.list_error = error
                if catalog is not None:
                    self.cloud.health_models.catalog = catalog
                response = self.client.get("/api/health-models")
                self.cloud.health_models.list_error = None

                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(
                    payload["models"],
                    [
                        {
                            "id": None,
                            "name": MODEL_NAME,
                            "resourceGroup": RESOURCE_GROUP,
                            "location": None,
                            "provisioningState": None,
                        }
                    ],
                )
                self.assertEqual(
                    payload["default"],
                    {"resourceGroup": RESOURCE_GROUP, "name": MODEL_NAME},
                )

    def test_selected_model_retargets_every_read_and_write(self):
        selector = "?model=hm-alpha&resourceGroup=rg-other"

        model = self.client.get(f"/api/health-model{selector}")
        self.assertEqual(model.status_code, 200)
        self.assertEqual(
            self.cloud.entities.list_calls[-1][0][:2], ("rg-other", "hm-alpha")
        )
        self.assertEqual(
            self.cloud.relationships.calls[-1][0][:2], ("rg-other", "hm-alpha")
        )

        detail = self.client.get(f"/api/entities/api{selector}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(
            self.cloud.entities.get_calls[-1][0][:2], ("rg-other", "hm-alpha")
        )
        self.assertEqual(
            self.cloud.entities.history_calls[-1][0][:2], ("rg-other", "hm-alpha")
        )

        report = self.client.post(
            f"/api/entities/api/health-reports{selector}",
            json={
                "signalName": SIGNAL_NAME,
                "healthState": "Healthy",
                "value": 1,
                "expiresInMinutes": 30,
                "reasonPreset": "recovery",
            },
        )
        self.assertEqual(report.status_code, 202)
        self.assertEqual(
            self.cloud.entities.ingest_calls[-1][0][:2], ("rg-other", "hm-alpha")
        )

    def test_undiscoverable_model_is_rejected_before_any_sdk_call(self):
        cases = [
            ("unknown name", "?model=hm-ghost&resourceGroup=rg-other"),
            ("wrong group", f"?model={MODEL_NAME}&resourceGroup=rg-ghost"),
            ("group only", "?resourceGroup=rg-other"),
            ("name only", "?model=hm-alpha"),
        ]

        for label, selector in cases:
            with self.subTest(label=label):
                self.cloud.entities.list_calls.clear()
                self.cloud.entities.ingest_calls.clear()
                self.cloud.entities.history_calls.clear()

                response = self.client.get(f"/api/health-model{selector}")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "unknown_model")

                report = self.client.post(
                    f"/api/entities/api/health-reports{selector}",
                    json={
                        "signalName": SIGNAL_NAME,
                        "healthState": "Healthy",
                        "value": 1,
                        "expiresInMinutes": 30,
                        "reasonPreset": "recovery",
                    },
                )
                self.assertEqual(report.status_code, 400)
                self.assertEqual(report.json()["error"]["code"], "unknown_model")

                self.assertEqual(self.cloud.entities.list_calls, [])
                self.assertEqual(self.cloud.entities.ingest_calls, [])
                self.assertEqual(self.cloud.entities.history_calls, [])

    def test_absent_selector_keeps_the_configured_model(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.cloud.entities.list_calls[-1][0][:2], (RESOURCE_GROUP, MODEL_NAME)
        )
        self.assertEqual(self.cloud.health_models.list_calls, [])

    def test_detail_allows_only_the_model_selector_query(self):
        cases = [
            ("history control", "?top=5", 400),
            ("model only", "?model=hm-alpha", 400),
            ("group only", "?resourceGroup=rg-other", 400),
            ("valid selector", "?model=hm-alpha&resourceGroup=rg-other", 200),
            (
                "selector plus extra",
                "?model=hm-alpha&resourceGroup=rg-other&top=5",
                400,
            ),
        ]

        for label, selector, expected in cases:
            with self.subTest(label=label):
                response = self.client.get(f"/api/entities/api{selector}")
                self.assertEqual(response.status_code, expected)
                if expected == 400 and label in ("history control", "selector plus extra"):
                    self.assertEqual(
                        response.json()["error"]["code"], "unsupported_query"
                    )

    def test_ac10_success_and_error_payload_contracts_match_baseline(self):
        model = self.client.get("/api/health-model")
        self.assertEqual(model.status_code, 200)
        self.assertEqual(
            set(model.json()),
            {"model", "observedAt", "entities", "relationships", "reportOptions"},
        )

        detail = self.client.get("/api/entities/api")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(
            set(detail.json()),
            {"entity", "observedAt", "transitions", "canonicalSignal"},
        )

        report = self.client.post(
            "/api/entities/api/health-reports",
            json={
                "signalName": SIGNAL_NAME,
                "healthState": "Healthy",
                "value": 1,
                "expiresInMinutes": 30,
                "reasonPreset": "recovery",
            },
        )
        self.assertEqual(report.status_code, 202)
        self.assertEqual(
            set(report.json()),
            {
                "status",
                "reportId",
                "entityName",
                "signalName",
                "requestedState",
                "submittedAt",
                "expiresAt",
            },
        )

        journey = self.client.post("/api/demo-request")
        self.assertEqual(journey.status_code, 200)
        self.assertEqual(
            set(journey.json()),
            {"request_id", "just_enqueued", "queue_head", "row_count"},
        )

        from azure.core.exceptions import HttpResponseError

        error = HttpResponseError(message="boom")
        error.status_code = 500
        self.cloud.health_models.error = error
        with self.assertLogs("ahm-demo", level="WARNING"):
            failure = self.client.get("/api/health-model")
        self.cloud.health_models.error = None

        self.assertEqual(failure.status_code, 503)
        self.assertEqual(set(failure.json()), {"error"})
        self.assertEqual(
            set(failure.json()["error"]),
            {"code", "message", "retryable", "operationId"},
        )


if __name__ == "__main__":
    unittest.main()
