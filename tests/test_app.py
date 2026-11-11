import importlib
import json
import os
import re
import sys
import tempfile
import unittest
from collections import Counter
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from azure.core.exceptions import HttpResponseError
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind


def mimetype(response):
    return response.headers["content-type"].split(";")[0].strip()


SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111"
OTHER_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222"
RESOURCE_GROUP = "rg-ahm-demo"
MODEL_NAME = "hm-ahm-demo"
MODEL_LOCATION = "northeurope"
SIGNAL_NAME = "web-ui-health-report"
REMOVED_ENV = (
    "QUEUE_URL",
    "POSTGRES_HOST",
    "POSTGRES_DATABASE",
    "POSTGRES_USER",
    "HEALTH_COPILOT_ENABLED",
    "AGENT_WEB_ORIGIN",
)
VALID_REPORT = {
    "signalName": SIGNAL_NAME,
    "healthState": "Healthy",
    "value": 1,
    "expiresInMinutes": 30,
    "reasonPreset": "recovery",
}


def ns(**values):
    return SimpleNamespace(**values)


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def azure_error(status):
    error = HttpResponseError(message="SECRET_AZURE_BODY token=do-not-leak")
    error.status_code = status
    return error


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


def model_id(name, resource_group, subscription_id=SUBSCRIPTION_ID):
    return (
        f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.CloudHealth/healthmodels/{name}"
    )


def graph_row(
    name,
    resource_group,
    location,
    provisioning_state="Succeeded",
    subscription_id=SUBSCRIPTION_ID,
):
    return {
        "id": model_id(name, resource_group, subscription_id),
        "name": name,
        "location": location,
        "provisioningState": provisioning_state,
    }


def catalog_rows():
    return [
        graph_row("hm-zulu", RESOURCE_GROUP, MODEL_LOCATION),
        graph_row(MODEL_NAME, RESOURCE_GROUP, MODEL_LOCATION),
        graph_row("hm-alpha", "rg-other", "westeurope", "Creating"),
        graph_row(
            "hm-remote",
            "rg-remote",
            "swedencentral",
            subscription_id=OTHER_SUBSCRIPTION_ID,
        ),
    ]


class RecordingHealthModels:
    def __init__(self, model, known):
        self.model = model
        self.known = set(known)
        self.calls = []
        self.error = None

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
        if args[:2] not in self.known:
            raise azure_error(404)
        return self.model


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
    def __init__(self, model, entities, relationships, known):
        self.health_models = RecordingHealthModels(model, known)
        self.entities = RecordingEntities(entities)
        self.relationships = RecordingRelationships(relationships)

    def reads_and_writes(self):
        return [
            self.entities.list_calls,
            self.entities.get_calls,
            self.entities.history_calls,
            self.entities.signal_history_calls,
            self.entities.ingest_calls,
            self.relationships.calls,
        ]


class RecordingResourceGraph:
    def __init__(self, pages):
        self.pages = pages
        self.requests = []
        self.error = None

    def resources(self, request, **kwargs):
        self.requests.append(request)
        if self.error:
            raise self.error
        rows, skip_token = self.pages[len(self.requests) - 1]
        return ns(data=list(rows), skip_token=skip_token)


class HealthReportUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dist = tempfile.TemporaryDirectory()
        dist = Path(cls.dist.name)
        (dist / "assets").mkdir()
        (dist / "index.html").write_text(
            '<!doctype html><html><body><div id="root"></div>'
            '<script type="module" src="/assets/index-test.js"></script></body></html>',
            encoding="utf-8",
        )
        (dist / "assets" / "index-test.js").write_text(
            "console.log('shell');", encoding="utf-8"
        )

        cls.environment = {
            "AUTH_MODE": "local",
            "AZURE_CLIENT_ID": "00000000-0000-0000-0000-000000000001",
            "APPLICATIONINSIGHTS_CONNECTION_STRING": (
                "InstrumentationKey=00000000-0000-0000-0000-000000000000"
            ),
            "AZURE_SUBSCRIPTION_ID": SUBSCRIPTION_ID,
            "AZURE_RESOURCE_GROUP": RESOURCE_GROUP,
            "HEALTH_MODEL_NAME": MODEL_NAME,
            "HEALTH_MODEL_DESIGN_NAME": f"{MODEL_NAME}-design",
            "SESSIONS_CONTAINER_URL": "memory:",
            "FOUNDRY_PROJECT_ENDPOINT": "fake:",
            "FOUNDRY_AGENT_NAME": "health-model-agent",
            "UI_DIST_DIR": str(dist),
        }
        cls.env_patch = mock.patch.dict(os.environ, cls.environment, clear=False)
        cls.env_patch.start()
        for name in REMOVED_ENV:
            os.environ.pop(name, None)

        cls.spans = InMemorySpanExporter()
        provider = trace.get_tracer_provider()
        if not isinstance(provider, TracerProvider):
            provider = TracerProvider()
            trace.set_tracer_provider(provider)
        provider.add_span_processor(SimpleSpanProcessor(cls.spans))

        cls.credential = mock.Mock(name="default_azure_credential")
        cls.patchers = {
            "credential": mock.patch(
                "azure.identity.DefaultAzureCredential",
                return_value=cls.credential,
            ),
            "monitor": mock.patch(
                "azure.monitor.opentelemetry.configure_azure_monitor",
            ),
        }
        cls.mocks = {name: patcher.start() for name, patcher in cls.patchers.items()}

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
            "errors",
            "healthmodels",
        ):
            sys.modules.pop(name, None)
        cls.module = importlib.import_module("main")
        cls.inventory = importlib.import_module("inventory")
        cls.config = importlib.import_module("config")
        cls.healthmodels = importlib.import_module("healthmodels")
        cls.obo = importlib.import_module("obo")
        cls.credentials = cls.obo.Developer(cls.credential)

    @classmethod
    def tearDownClass(cls):
        for patcher in reversed(list(cls.patchers.values())):
            patcher.stop()
        cls.env_patch.stop()
        cls.dist.cleanup()

    def setUp(self):
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
            id=model_id(MODEL_NAME, RESOURCE_GROUP),
            name=MODEL_NAME,
            location=MODEL_LOCATION,
            properties=ns(
                provisioning_state="Succeeded",
                health_state="Healthy",
            ),
        )
        self.cloud = RecordingCloudClient(
            self.model,
            self.entities,
            self.relationships,
            known=[
                (RESOURCE_GROUP, MODEL_NAME),
                ("rg-other", "hm-alpha"),
                (RESOURCE_GROUP, "hm-zulu"),
            ],
        )
        self.remote_cloud = RecordingCloudClient(
            self.model,
            self.entities,
            self.relationships,
            known=[("rg-remote", "hm-remote")],
        )
        self.clouds = {
            SUBSCRIPTION_ID: self.cloud,
            OTHER_SUBSCRIPTION_ID: self.remote_cloud,
        }
        self.created = []
        self.graph = RecordingResourceGraph([(catalog_rows(), None)])
        for patcher in (
            mock.patch.object(
                self.healthmodels, "ResourceGraphClient", return_value=self.graph
            ),
            mock.patch.object(
                self.healthmodels,
                "CloudHealthMgmtClient",
                side_effect=self.create_cloud_client,
            ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.module.health = self.healthmodels.HealthModels(self.credentials)
        self.client = TestClient(self.module.app, follow_redirects=False)
        self.spans.clear()

    def create_cloud_client(self, credential, subscription_id, **kwargs):
        self.created.append((credential, subscription_id, kwargs))
        return self.clouds.get(subscription_id) or RecordingCloudClient(
            self.model, [], [], known=[]
        )

    def assert_security_headers(self, response):
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(
            response.headers["Content-Security-Policy"],
            "default-src 'self'; script-src 'self'; "
            "style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='; "
            "img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com; base-uri 'none'; "
            "frame-ancestors 'none'",
        )

    def assert_no_azure_calls(self):
        self.assertEqual(self.created, [])
        self.assertEqual(self.graph.requests, [])
        for cloud in self.clouds.values():
            self.assertEqual(cloud.health_models.calls, [])
            self.assertEqual(cloud.reads_and_writes(), [[]] * 6)

    def test_plain_root_is_side_effect_free_ui(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mimetype(response), "text/html")
        body = response.text
        self.assertIn('id="root"', body)
        self.assertRegex(body, r"/assets/index-[\w-]+\.js")
        self.assert_no_azure_calls()
        self.assert_security_headers(response)

    def test_shell_and_assets_come_from_the_ui_dist_dir(self):
        cases = [
            ("/", 'id="root"'),
            ("/sessions/abc", 'id="root"'),
            ("/assets/index-test.js", "console.log('shell');"),
        ]

        for path, expected in cases:
            with self.subTest(path=path):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 200)
                self.assertIn(expected, response.text)
                self.assert_no_azure_calls()
                self.assert_security_headers(response)

    def test_request_journey_surface_is_gone(self):
        cases = [
            ("get", "/?format=json", 200),
            ("get", "/?format=html", 200),
            ("get", "/?format=", 200),
            ("get", "/?format=invalid", 200),
            ("get", "/?format=json&format=html", 200),
            ("post", "/api/demo-request", 404),
            ("get", "/api/demo-request", 404),
        ]

        for method, path, status in cases:
            with self.subTest(method=method, path=path):
                response = getattr(self.client, method)(path)

                self.assertEqual(response.status_code, status)
                if status == 200:
                    self.assertIn('id="root"', response.text)
                else:
                    self.assertEqual(response.json()["error"]["code"], "not_found")
                self.assert_no_azure_calls()

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
            ["Healthy", "Degraded", "Unhealthy", "Unknown"],
        )
        self.assertEqual(payload["reportOptions"]["values"], [None, 0, 0.5, 1])
        self.assertEqual(payload["reportOptions"]["expiries"], [1, 5, 15, 30, 60, 120])
        self.assertEqual(len(self.cloud.health_models.calls), 1)
        self.assertEqual(len(self.cloud.entities.list_calls), 1)
        self.assertEqual(len(self.cloud.relationships.calls), 1)
        self.assert_security_headers(response)

    def test_model_read_is_fresh_and_does_not_persist(self):
        first = self.client.get("/api/health-model")
        second = self.client.get("/api/health-model")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(len(self.cloud.health_models.calls), 2)
        self.assertEqual(len(self.cloud.entities.list_calls), 2)
        self.assertEqual(len(self.cloud.relationships.calls), 2)

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
                "state-removed-from-the-service",
                "api",
                {**valid, "healthState": "Deleted"},
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

    def test_a_reason_preset_that_is_not_text_is_the_usual_validation_error(self):
        for preset in ([], {}, ["recovery"], {"recovery": 1}, [[]], 5, 1.5, True, None):
            with self.subTest(preset=preset):
                response = self.client.post("/api/entities/api/health-reports", json={**VALID_REPORT, "reasonPreset": preset})

                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["code"], "invalid_reason")
                self.assertEqual(self.cloud.entities.ingest_calls, [])

    def test_malformed_selectors_are_rejected_before_any_azure_call(self):
        guid = OTHER_SUBSCRIPTION_ID
        malformed = [
            ("subscription that is no guid", f"?model=hm-alpha&resourceGroup=rg-other&subscription=not-a-guid"),
            ("subscription with a trailing newline", f"?model=hm-alpha&resourceGroup=rg-other&subscription={guid}%0A"),
            ("subscription without hyphens", f"?model=hm-alpha&resourceGroup=rg-other&subscription={guid.replace('-', '')}"),
            ("subscription in braces", f"?model=hm-alpha&resourceGroup=rg-other&subscription=%7B{guid}%7D"),
            ("subscription with non hex digits", f"?model=hm-alpha&resourceGroup=rg-other&subscription={'z' * 8}-{'z' * 4}-{'z' * 4}-{'z' * 4}-{'z' * 12}"),
            ("group with a slash", "?model=hm-alpha&resourceGroup=rg%2Fother"),
            ("group with a blank", "?model=hm-alpha&resourceGroup=rg%20other"),
            ("group with a trailing newline", "?model=hm-alpha&resourceGroup=rg-other%0A"),
            ("group of 91 characters", f"?model=hm-alpha&resourceGroup={'r' * 91}"),
            ("group with a semicolon", "?model=hm-alpha&resourceGroup=rg;other"),
            ("model of one character", "?model=m&resourceGroup=rg-other"),
            ("model starting with a hyphen", "?model=-hm&resourceGroup=rg-other"),
            ("model ending with a hyphen", "?model=hm-&resourceGroup=rg-other"),
            ("model with a trailing newline", "?model=hm-alpha%0A&resourceGroup=rg-other"),
            ("model of 261 characters", f"?model={'m' * 261}&resourceGroup=rg-other"),
            ("model with an underscore", "?model=hm_alpha&resourceGroup=rg-other"),
            ("model with a blank", "?model=hm%20alpha&resourceGroup=rg-other"),
            ("model with a slash", "?model=hm%2Falpha&resourceGroup=rg-other"),
        ]
        routes = [
            ("get", "/api/health-model", {}),
            ("get", "/api/entities/api", {}),
            ("post", "/api/entities/api/health-reports", {"json": VALID_REPORT}),
        ]
        for label, selector in malformed:
            for method, path, arguments in routes:
                with self.subTest(label=label, route=f"{method} {path}"):
                    response = getattr(self.client, method)(f"{path}{selector}", **arguments)

                    self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "unknown_model"))
                    self.assert_no_azure_calls()

    def test_well_formed_selectors_at_the_limits_still_reach_azure(self):
        selectors = [
            ("underscores dots and parentheses", "?model=hm-alpha&resourceGroup=rg_a.b(c)-d"),
            ("a group of 90 characters", f"?model=hm-alpha&resourceGroup={'r' * 90}"),
            ("a model of 3 characters", "?model=abc&resourceGroup=rg-other"),
            ("a model of 260 characters", f"?model={'m' * 260}&resourceGroup=rg-other"),
            ("a guid in capitals", f"?model=hm-alpha&resourceGroup=rg-other&subscription={OTHER_SUBSCRIPTION_ID.upper()}"),
        ]
        for label, selector in selectors:
            with self.subTest(label=label):
                self.cloud.health_models.calls.clear()
                self.remote_cloud.health_models.calls.clear()

                response = self.client.get(f"/api/health-model{selector}")

                self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "unknown_model"))
                self.assertEqual(len(self.cloud.health_models.calls) + len(self.remote_cloud.health_models.calls), 1)

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

    def test_sdk_errors_are_mapped_without_azure_details(self):
        cases = [
            (401, 503, False, "health_model_access_unavailable"),
            (403, 403, False, "forbidden"),
            (404, 404, False, "not_found"),
            (409, 409, True, "health_model_conflict"),
            (429, 503, True, "health_model_busy"),
            (500, 503, True, "health_model_unavailable"),
            (503, 503, True, "health_model_unavailable"),
        ]
        for azure_status, expected_status, retryable, code in cases:
            with self.subTest(azure_status=azure_status):
                self.cloud.health_models.error = azure_error(azure_status)
                with self.assertLogs("ahm-demo", level="WARNING") as captured:
                    response = self.client.get("/api/health-model")
                self.cloud.health_models.error = None

                self.assertEqual(response.status_code, expected_status)
                payload = response.json()
                self.assertEqual(payload["error"]["code"], code)
                self.assertEqual(payload["error"]["retryable"], retryable)
                self.assertEqual(len(payload["error"]["operationId"]), 32)
                self.assertNotIn("SECRET_AZURE_BODY", response.text)
                self.assertNotIn("do-not-leak", response.text)
                self.assertNotIn("SECRET_AZURE_BODY", "\n".join(captured.output))
                self.assertNotIn("do-not-leak", "\n".join(captured.output))

    def test_report_without_write_access_is_a_clear_forbidden(self):
        self.remote_cloud.entities.ingest_error = azure_error(403)

        with self.assertLogs("ahm-demo", level="WARNING"):
            response = self.client.post(
                "/api/entities/api/health-reports"
                f"?model=hm-remote&resourceGroup=rg-remote&subscription={OTHER_SUBSCRIPTION_ID}",
                json=VALID_REPORT,
            )

        self.assertEqual(response.status_code, 403)
        error = response.json()["error"]
        self.assertEqual(error["code"], "forbidden")
        self.assertFalse(error["retryable"])
        self.assertNotIn("SECRET_AZURE_BODY", response.text)
        self.assertEqual(len(self.remote_cloud.entities.ingest_calls), 1)
        self.assertEqual(self.cloud.entities.ingest_calls, [])

    def test_html_like_names_remain_data_and_headers_are_restrictive(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["entities"][-1]["displayName"],
            "Discovered <img src=x onerror=alert(1)>",
        )
        root = self.client.get("/")
        self.assertNotIn("unsafe-inline", root.headers["Content-Security-Policy"])
        self.assertNotIn("frame-src", root.headers["Content-Security-Policy"])
        self.assert_security_headers(root)

    def test_the_policy_is_the_one_the_ui_specs_run_under(self):
        spec = Path(__file__).resolve().parents[1] / "src" / "web" / "ui" / "tests" / "graph-ux.spec.ts"
        declaration = re.search(r'const SERVED_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);', spec.read_text(encoding="utf-8"))

        self.assertIsNotNone(declaration, "SERVED_CSP is no longer a plain string expression in graph-ux.spec.ts")
        served = "".join(re.findall(r'"([^"]*)"', declaration.group(1)))
        self.assertEqual(self.config.SECURITY_POLICY, served)
        self.assertIn("style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='", served)

    def test_the_policy_allows_nothing_inline_beyond_the_empty_style_element(self):
        directives = dict(part.strip().split(" ", 1) for part in self.config.SECURITY_POLICY.split(";"))

        self.assertNotIn("unsafe-inline", self.config.SECURITY_POLICY)
        self.assertNotIn("unsafe-eval", self.config.SECURITY_POLICY)
        self.assertEqual(directives["script-src"], "'self'")
        self.assertEqual(directives["style-src"].split(), ["'self'", "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"])
        self.assertEqual(directives["connect-src"].split(), ["'self'", "https://login.microsoftonline.com"])

    def test_runtime_needs_only_the_eight_required_variables(self):
        required = {
            "APPLICATIONINSIGHTS_CONNECTION_STRING",
            "AZURE_RESOURCE_GROUP",
            "AZURE_SUBSCRIPTION_ID",
            "HEALTH_MODEL_NAME",
            "HEALTH_MODEL_DESIGN_NAME",
            "SESSIONS_CONTAINER_URL",
            "FOUNDRY_PROJECT_ENDPOINT",
            "FOUNDRY_AGENT_NAME",
        }
        exact = dict(self.environment)
        self.assertEqual(set(self.config.REQUIRED_ENV), required)
        self.assertEqual(
            self.module.require_runtime_config(exact),
            {
                "subscription_id": SUBSCRIPTION_ID,
                "resource_group": RESOURCE_GROUP,
                "model_name": MODEL_NAME,
                "design_model_name": f"{MODEL_NAME}-design",
                "sessions_container_url": "memory:",
                "foundry_project_endpoint": "fake:",
                "foundry_agent_name": "health-model-agent",
                "auth_mode": "local",
                "tenant_id": None,
                "client_id": None,
                "api_scope": None,
                "mcp_scope": None,
                "agent_principal_id": "",
                "managed_identity_client_id": self.environment["AZURE_CLIENT_ID"],
            },
        )

        for key in sorted(required):
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

    def test_the_auth_mode_decides_which_variables_are_required_and_where_local_is_allowed(self):
        base = {key: value for key, value in self.environment.items() if key not in ("AUTH_MODE", "UI_DIST_DIR")}
        entra = {
            "ENTRA_TENANT_ID": "33333333-3333-3333-3333-333333333333",
            "ENTRA_CLIENT_ID": "44444444-4444-4444-4444-444444444444",
            "ENTRA_API_SCOPE": "api://44444444-4444-4444-4444-444444444444/access_as_user",
            "MCP_SCOPE": "api://55555555-5555-5555-5555-555555555555/Mcp.Tools.ReadWrite",
        }
        without = lambda environment, name: {key: value for key, value in environment.items() if key != name}
        cases = [
            ("no mode means entra and wants its variables", base, ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_API_SCOPE", "MCP_SCOPE"]),
            ("entra with its variables", {**base, **entra}, "entra"),
            ("entra named out loud", {**base, **entra, "AUTH_MODE": "entra"}, "entra"),
            ("entra named in capitals with spaces", {**base, **entra, "AUTH_MODE": " ENTRA "}, "entra"),
            ("entra without the agent identity yet", {**base, **entra, "FOUNDRY_AGENT_PRINCIPAL_ID": ""}, "entra"),
            ("entra without the managed identity", without({**base, **entra}, "AZURE_CLIENT_ID"), ["AZURE_CLIENT_ID"]),
            ("entra without the tenant", without({**base, **entra}, "ENTRA_TENANT_ID"), ["ENTRA_TENANT_ID"]),
            ("entra without the api scope", without({**base, **entra}, "ENTRA_API_SCOPE"), ["ENTRA_API_SCOPE"]),
            ("entra without the mcp scope", without({**base, **entra}, "MCP_SCOPE"), ["MCP_SCOPE"]),
            ("entra with a blank client id", {**base, **entra, "ENTRA_CLIENT_ID": "  "}, ["ENTRA_CLIENT_ID"]),
            ("entra inside a container app", {**base, **entra, "CONTAINER_APP_NAME": "ca-web"}, "entra"),
            ("local needs no entra variables", {**base, "AUTH_MODE": "local"}, "local"),
            ("local needs no managed identity", {**without(base, "AZURE_CLIENT_ID"), "AUTH_MODE": "local"}, "local"),
            ("local in capitals", {**base, "AUTH_MODE": "LOCAL"}, "local"),
            ("local with a blank container app name", {**base, "AUTH_MODE": "local", "CONTAINER_APP_NAME": " "}, "local"),
            ("local inside a container app", {**base, "AUTH_MODE": "local", "CONTAINER_APP_NAME": "ca-web"}, ["Container App"]),
            ("an unknown mode", {**base, **entra, "AUTH_MODE": "none"}, ["AUTH_MODE must be one of"]),
            ("a blank mode means entra", {**base, "AUTH_MODE": " "}, ["ENTRA_TENANT_ID"]),
        ]
        for label, environment, expected in cases:
            with self.subTest(label=label):
                if isinstance(expected, list):
                    with self.assertRaises(RuntimeError) as caught:
                        self.module.require_runtime_config(environment)
                    for fragment in expected:
                        self.assertIn(fragment, str(caught.exception))
                    continue
                configured = self.module.require_runtime_config(environment)

                self.assertEqual(configured["auth_mode"], expected)
                if expected == "entra":
                    self.assertEqual(
                        (configured["tenant_id"], configured["client_id"], configured["api_scope"], configured["mcp_scope"]),
                        tuple(entra.values()),
                    )
                    self.assertEqual(configured["agent_principal_id"], environment.get("FOUNDRY_AGENT_PRINCIPAL_ID", ""))

    def test_the_agent_principal_is_read_trimmed_and_may_be_empty(self):
        base = {key: value for key, value in self.environment.items() if key != "UI_DIST_DIR"}
        for label, value, expected in [("set", " 66666666-6666-6666-6666-666666666666 ", "66666666-6666-6666-6666-666666666666"), ("empty", "", ""), ("absent", None, "")]:
            with self.subTest(label=label):
                environment = dict(base)
                if value is not None:
                    environment["FOUNDRY_AGENT_PRINCIPAL_ID"] = value

                self.assertEqual(self.module.require_runtime_config(environment)["agent_principal_id"], expected)

    def test_catalog_is_served_without_the_removed_variables(self):
        self.assertEqual(set(REMOVED_ENV) & set(os.environ), set())

        response = self.client.get("/api/health-models")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["models"]), 4)

    def test_azure_monitor_and_identity_are_configured_from_the_environment(self):
        self.mocks["credential"].assert_any_call(
            managed_identity_client_id=self.environment["AZURE_CLIENT_ID"]
        )
        self.mocks["credential"].assert_any_call(exclude_managed_identity_credential=True)
        self.mocks["monitor"].assert_called_once_with(
            connection_string=self.environment["APPLICATIONINSIGHTS_CONNECTION_STRING"],
            credential=self.credential,
            enable_live_metrics=False,
        )

    def test_every_route_emits_exactly_one_server_span(self):
        cases = [
            ("get", "/", "GET /", 0),
            ("get", "/sessions/abc", "GET /{full_path:path}", 0),
            ("get", "/assets/index-test.js", None, 0),
            ("get", "/api/health-models", "GET /api/health-models", 1),
            ("get", "/api/health-model", "GET /api/health-model", 1),
            (
                "get",
                f"/api/health-model?model=hm-remote&resourceGroup=rg-remote"
                f"&subscription={OTHER_SUBSCRIPTION_ID}",
                "GET /api/health-model",
                1,
            ),
            ("get", "/api/health-model?model=hm-ghost&resourceGroup=rg-other", "GET /api/health-model", 0),
            ("get", "/api/entities/api", "GET /api/entities/{entity_name:path}", 1),
            ("get", "/api/entities/api?top=5", "GET /api/entities/{entity_name:path}", 0),
            (
                "post",
                "/api/entities/api/health-reports",
                "POST /api/entities/{entity_name:path}/health-reports",
                1,
            ),
            ("post", "/api/demo-request", None, 0),
        ]

        for method, path, name, client_spans in cases:
            with self.subTest(method=method, path=path):
                self.spans.clear()
                self.graph.pages = [(catalog_rows(), None)]
                self.graph.requests.clear()

                kwargs = {"json": VALID_REPORT} if method == "post" else {}
                getattr(self.client, method)(path, **kwargs)

                finished = self.spans.get_finished_spans()
                self.assertEqual(
                    Counter(span.kind for span in finished),
                    Counter({SpanKind.SERVER: 1, SpanKind.CLIENT: client_spans}),
                )
                (server,) = [span for span in finished if span.kind == SpanKind.SERVER]
                if name is not None:
                    self.assertEqual(server.name, name)
                for span in finished:
                    self.assertEqual(span.context.trace_id, server.context.trace_id)

    def test_error_operation_ids_are_the_trace_ids_of_the_request(self):
        response = self.client.get("/api/entities/api?top=5")

        (server,) = [
            span
            for span in self.spans.get_finished_spans()
            if span.kind == SpanKind.SERVER
        ]
        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["error"]["operationId"],
            f"{server.context.trace_id:032x}",
        )

    def test_arm_id_yields_its_subscription_and_resource_group_or_nothing(self):
        cases = [
            (
                f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-other"
                f"/providers/Microsoft.CloudHealth/healthmodels/hm-alpha",
                SUBSCRIPTION_ID,
                "rg-other",
            ),
            (
                f"/subscriptions/{SUBSCRIPTION_ID}/resourcegroups/rg-lower"
                f"/providers/Microsoft.CloudHealth/healthmodels/hm-alpha",
                SUBSCRIPTION_ID,
                "rg-lower",
            ),
            (
                f"/SUBSCRIPTIONS/{OTHER_SUBSCRIPTION_ID}/RESOURCEGROUPS/RG-UPPER"
                f"/providers/Microsoft.CloudHealth/healthmodels/hm-alpha",
                OTHER_SUBSCRIPTION_ID,
                "RG-UPPER",
            ),
            (f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups", SUBSCRIPTION_ID, None),
            ("/providers/Microsoft.CloudHealth/healthmodels/hm-alpha", None, None),
            ("", None, None),
            (None, None, None),
        ]

        for resource_id, subscription_id, resource_group in cases:
            with self.subTest(resource_id=resource_id):
                self.assertEqual(
                    self.inventory.subscription_from_id(resource_id), subscription_id
                )
                self.assertEqual(
                    self.inventory.resource_group_from_id(resource_id), resource_group
                )

    def test_catalog_row_becomes_a_ref_or_nothing(self):
        cases = [
            (
                "complete row",
                graph_row("hm-alpha", "rg-other", "westeurope", "Creating"),
                {
                    "id": model_id("hm-alpha", "rg-other"),
                    "name": "hm-alpha",
                    "resourceGroup": "rg-other",
                    "subscriptionId": SUBSCRIPTION_ID,
                    "location": "westeurope",
                    "provisioningState": "Creating",
                },
            ),
            (
                "group casing comes from the id, not from the lowercased column",
                {
                    **graph_row("hm-case", "rg-Mixed-Case", "northeurope"),
                    "resourceGroup": "rg-mixed-case",
                },
                {
                    "id": model_id("hm-case", "rg-Mixed-Case"),
                    "name": "hm-case",
                    "resourceGroup": "rg-Mixed-Case",
                    "subscriptionId": SUBSCRIPTION_ID,
                    "location": "northeurope",
                    "provisioningState": "Succeeded",
                },
            ),
            (
                "empty provisioning state",
                graph_row("hm-blank", "rg-other", "westeurope", ""),
                {
                    "id": model_id("hm-blank", "rg-other"),
                    "name": "hm-blank",
                    "resourceGroup": "rg-other",
                    "subscriptionId": SUBSCRIPTION_ID,
                    "location": "westeurope",
                    "provisioningState": None,
                },
            ),
            ("no name", {**graph_row("x", "rg-other", "westeurope"), "name": None}, None),
            ("no id", {"name": "hm-alpha", "location": "westeurope"}, None),
            (
                "id without a resource group",
                {"id": f"/subscriptions/{SUBSCRIPTION_ID}", "name": "hm-alpha"},
                None,
            ),
            ("not a row", "columns", None),
        ]

        for label, row, expected in cases:
            with self.subTest(label=label):
                self.assertEqual(self.inventory.model_ref(row), expected)

    def test_catalog_lists_every_readable_model_across_subscriptions_in_stable_order(self):
        self.graph.pages = [
            (
                [
                    graph_row(
                        MODEL_NAME,
                        RESOURCE_GROUP,
                        "swedencentral",
                        subscription_id=OTHER_SUBSCRIPTION_ID,
                    ),
                    *catalog_rows(),
                ],
                None,
            )
        ]

        response = self.client.get("/api/health-models")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(set(payload), {"models", "default"})
        self.assertEqual(
            payload["default"],
            {
                "name": MODEL_NAME,
                "resourceGroup": RESOURCE_GROUP,
                "subscriptionId": SUBSCRIPTION_ID,
            },
        )
        self.assertEqual(
            [
                (item["subscriptionId"], item["resourceGroup"], item["name"])
                for item in payload["models"]
            ],
            [
                (SUBSCRIPTION_ID, RESOURCE_GROUP, MODEL_NAME),
                (OTHER_SUBSCRIPTION_ID, RESOURCE_GROUP, MODEL_NAME),
                (SUBSCRIPTION_ID, "rg-other", "hm-alpha"),
                (OTHER_SUBSCRIPTION_ID, "rg-remote", "hm-remote"),
                (SUBSCRIPTION_ID, RESOURCE_GROUP, "hm-zulu"),
            ],
        )
        self.assertEqual(
            set(payload["models"][0]),
            {
                "id",
                "name",
                "resourceGroup",
                "subscriptionId",
                "location",
                "provisioningState",
            },
        )
        alpha = next(item for item in payload["models"] if item["name"] == "hm-alpha")
        self.assertEqual(alpha["id"], model_id("hm-alpha", "rg-other"))
        self.assertEqual(alpha["location"], "westeurope")
        self.assertEqual(alpha["provisioningState"], "Creating")

    def test_catalog_is_one_resource_graph_query_over_every_visible_subscription(self):
        response = self.client.get("/api/health-models")

        self.assertEqual(response.status_code, 200)
        (request,) = self.graph.requests
        self.assertEqual(request.query, self.healthmodels.MODELS_QUERY)
        self.assertIn("type =~ 'microsoft.cloudhealth/healthmodels'", request.query)
        self.assertIsNone(request.subscriptions)
        self.assertIsNone(request.management_groups)
        self.assertIsNone(request.options.skip_token)
        self.assertEqual(self.created, [])

    def test_catalog_follows_resource_graph_paging(self):
        self.graph.pages = [
            ([graph_row("hm-zulu", RESOURCE_GROUP, MODEL_LOCATION)], "page-2"),
            ([graph_row("hm-alpha", "rg-other", "westeurope")], "page-3"),
            ([graph_row(MODEL_NAME, RESOURCE_GROUP, MODEL_LOCATION)], None),
        ]

        response = self.client.get("/api/health-models")

        self.assertEqual(
            [item["name"] for item in response.json()["models"]],
            [MODEL_NAME, "hm-alpha", "hm-zulu"],
        )
        self.assertEqual(
            [request.options.skip_token for request in self.graph.requests],
            [None, "page-2", "page-3"],
        )

    def test_the_catalog_is_cached_for_30_seconds(self):
        clock = Clock()
        self.module.health = self.healthmodels.HealthModels(self.credentials, clock=clock)
        self.graph.pages = [(catalog_rows(), None), (catalog_rows(), None)]

        first = self.client.get("/api/health-models")
        clock.now += 29.9
        second = self.client.get("/api/health-models")
        clock.now += 0.1
        third = self.client.get("/api/health-models")

        self.assertEqual(len(self.graph.requests), 2)
        self.assertEqual(first.json(), second.json())
        self.assertEqual(first.json(), third.json())

    def test_model_checks_are_cached_across_requests(self):
        clock = Clock()
        self.module.health = self.healthmodels.HealthModels(self.credentials, clock=clock)
        selector = "?model=hm-alpha&resourceGroup=rg-other"
        ghost = "?model=hm-ghost&resourceGroup=rg-other"

        for _ in range(3):
            self.assertEqual(self.client.post(f"/api/entities/api/health-reports{selector}", json=VALID_REPORT).status_code, 202)
            self.assertEqual(self.client.post(f"/api/entities/api/health-reports{ghost}", json=VALID_REPORT).status_code, 400)
        asked = len(self.cloud.health_models.calls)
        clock.now += 60
        self.client.post(f"/api/entities/api/health-reports{selector}", json=VALID_REPORT)

        self.assertEqual(asked, 2)
        self.assertEqual(len(self.cloud.health_models.calls), 3)

    def test_unreadable_or_empty_catalog_degrades_to_the_configured_model(self):
        cases = [
            ("forbidden", azure_error(403), []),
            ("unauthorized", azure_error(401), []),
            ("unexpected failure", RuntimeError("SECRET_AZURE_BODY"), []),
            ("empty", None, []),
            (
                "unusable rows",
                None,
                [{"id": "not-an-arm-id", "name": "hm-alpha"}, {"name": "hm-orphan"}],
            ),
        ]

        for label, error, rows in cases:
            with self.subTest(label=label):
                self.graph.requests.clear()
                self.graph.error = error
                self.graph.pages = [(rows, None)]
                logs = (
                    self.assertLogs("ahm-demo", level="WARNING")
                    if error
                    else nullcontext()
                )
                with logs as captured:
                    response = self.client.get("/api/health-models")

                self.assertEqual(response.status_code, 200)
                payload = response.json()
                self.assertEqual(
                    payload["models"],
                    [
                        {
                            "id": None,
                            "name": MODEL_NAME,
                            "resourceGroup": RESOURCE_GROUP,
                            "subscriptionId": SUBSCRIPTION_ID,
                            "location": None,
                            "provisioningState": None,
                        }
                    ],
                )
                self.assertEqual(
                    payload["default"],
                    {
                        "name": MODEL_NAME,
                        "resourceGroup": RESOURCE_GROUP,
                        "subscriptionId": SUBSCRIPTION_ID,
                    },
                )
                if error:
                    output = "\n".join(captured.output)
                    self.assertIn(f"error_type={type(error).__name__}", output)
                    self.assertNotIn("SECRET_AZURE_BODY", output)
        self.graph.error = None

    def test_selected_model_retargets_every_read_and_write(self):
        cases = [
            (
                "configured subscription when none is given",
                "?model=hm-alpha&resourceGroup=rg-other",
                self.cloud,
                ("rg-other", "hm-alpha"),
            ),
            (
                "explicit configured subscription",
                f"?model=hm-alpha&resourceGroup=rg-other&subscription={SUBSCRIPTION_ID}",
                self.cloud,
                ("rg-other", "hm-alpha"),
            ),
            (
                "another subscription",
                f"?model=hm-remote&resourceGroup=rg-remote&subscription={OTHER_SUBSCRIPTION_ID}",
                self.remote_cloud,
                ("rg-remote", "hm-remote"),
            ),
        ]

        for label, selector, target, (group, name) in cases:
            with self.subTest(label=label):
                for cloud in self.clouds.values():
                    for calls in cloud.reads_and_writes():
                        calls.clear()

                model = self.client.get(f"/api/health-model{selector}")
                self.assertEqual(model.status_code, 200)
                self.assertEqual(target.entities.list_calls[-1][0][:2], (group, name))
                self.assertEqual(target.relationships.calls[-1][0][:2], (group, name))

                detail = self.client.get(f"/api/entities/api{selector}")
                self.assertEqual(detail.status_code, 200)
                self.assertEqual(target.entities.get_calls[-1][0][:2], (group, name))
                self.assertEqual(target.entities.history_calls[-1][0][:2], (group, name))

                report = self.client.post(
                    f"/api/entities/api/health-reports{selector}",
                    json=VALID_REPORT,
                )
                self.assertEqual(report.status_code, 202)
                self.assertEqual(target.entities.ingest_calls[-1][0][:2], (group, name))

                for cloud in self.clouds.values():
                    if cloud is not target:
                        self.assertEqual(cloud.reads_and_writes(), [[]] * 6)

    def test_unavailable_model_is_rejected_before_any_read_or_write(self):
        cases = [
            ("unknown name", "?model=hm-ghost&resourceGroup=rg-other", True),
            ("wrong group", f"?model={MODEL_NAME}&resourceGroup=rg-ghost", True),
            (
                "model that lives in another subscription",
                f"?model=hm-remote&resourceGroup=rg-remote&subscription={SUBSCRIPTION_ID}",
                True,
            ),
            (
                "subscription the app cannot see",
                f"?model=hm-alpha&resourceGroup=rg-other&subscription={'3' * 8}-3333-3333-3333-{'3' * 12}",
                True,
            ),
            ("group only", "?resourceGroup=rg-other", False),
            ("name only", "?model=hm-alpha", False),
            ("subscription only", f"?subscription={OTHER_SUBSCRIPTION_ID}", False),
            (
                "name and subscription",
                f"?model=hm-alpha&subscription={SUBSCRIPTION_ID}",
                False,
            ),
        ]

        for label, selector, looked_up in cases:
            with self.subTest(label=label):
                self.created.clear()
                for cloud in self.clouds.values():
                    cloud.health_models.calls.clear()
                    for calls in cloud.reads_and_writes():
                        calls.clear()

                model = self.client.get(f"/api/health-model{selector}")
                report = self.client.post(
                    f"/api/entities/api/health-reports{selector}",
                    json=VALID_REPORT,
                )

                for response in (model, report):
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(response.json()["error"]["code"], "unknown_model")
                for cloud in self.clouds.values():
                    self.assertEqual(cloud.reads_and_writes(), [[]] * 6)
                self.assertEqual(self.graph.requests, [])
                if not looked_up:
                    self.assertEqual(self.created, [])
                    for cloud in self.clouds.values():
                        self.assertEqual(cloud.health_models.calls, [])

    def test_azure_failures_while_resolving_a_model_are_classified_not_hidden(self):
        cases = [
            (400, 400, "unknown_model", False),
            (403, 400, "unknown_model", False),
            (404, 400, "unknown_model", False),
            (401, 503, "health_model_access_unavailable", True),
            (429, 503, "health_model_busy", True),
            (500, 503, "health_model_unavailable", True),
        ]
        selector = "?model=hm-alpha&resourceGroup=rg-other"

        for azure_status, status, code, warns in cases:
            with self.subTest(azure_status=azure_status):
                self.module.health = self.healthmodels.HealthModels(self.credentials)
                self.cloud.health_models.error = azure_error(azure_status)
                logs = (
                    self.assertLogs("ahm-demo", level="WARNING")
                    if warns
                    else nullcontext()
                )
                with logs:
                    model = self.client.get(f"/api/health-model{selector}")
                    report = self.client.post(
                        f"/api/entities/api/health-reports{selector}",
                        json=VALID_REPORT,
                    )
                self.cloud.health_models.error = None

                for response in (model, report):
                    self.assertEqual(response.status_code, status)
                    self.assertEqual(response.json()["error"]["code"], code)
                    self.assertNotIn("SECRET_AZURE_BODY", response.text)
                self.assertEqual(self.cloud.reads_and_writes(), [[]] * 6)

    def test_absent_selector_keeps_the_configured_model(self):
        for selector in ("", "?model=&resourceGroup=&subscription="):
            with self.subTest(selector=selector):
                self.cloud.health_models.calls.clear()

                response = self.client.get(f"/api/health-model{selector}")

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    self.cloud.entities.list_calls[-1][0][:2],
                    (RESOURCE_GROUP, MODEL_NAME),
                )
                self.assertEqual(len(self.cloud.health_models.calls), 1)
                self.assertEqual(self.graph.requests, [])
        self.assertEqual(
            [subscription_id for _, subscription_id, _ in self.created],
            [SUBSCRIPTION_ID],
        )

    def test_entity_reads_never_query_resource_graph(self):
        selectors = [
            "",
            "?model=hm-alpha&resourceGroup=rg-other",
            f"?model=hm-remote&resourceGroup=rg-remote&subscription={OTHER_SUBSCRIPTION_ID}",
        ]

        for selector in selectors:
            self.client.get(f"/api/health-model{selector}")
            self.client.get(f"/api/entities/api{selector}")
            self.client.post(f"/api/entities/api/health-reports{selector}", json=VALID_REPORT)

        self.assertEqual(self.graph.requests, [])

    def test_one_cloud_health_client_is_created_per_subscription(self):
        selectors = [
            "",
            "?model=hm-alpha&resourceGroup=rg-other",
            f"?model=hm-remote&resourceGroup=rg-remote&subscription={OTHER_SUBSCRIPTION_ID}",
        ]

        for selector in selectors * 2:
            self.client.get(f"/api/health-model{selector}")
            self.client.get(f"/api/entities/api{selector}")

        api_version = {"api_version": self.config.CLOUDHEALTH_API_VERSION}
        self.assertEqual(
            self.created,
            [
                (self.credential, SUBSCRIPTION_ID, api_version),
                (self.credential, OTHER_SUBSCRIPTION_ID, api_version),
            ],
        )

    def test_detail_allows_only_the_model_selector_query(self):
        cases = [
            ("history control", "?top=5", 400, "unsupported_query"),
            ("model only", "?model=hm-alpha", 400, "unknown_model"),
            ("group only", "?resourceGroup=rg-other", 400, "unknown_model"),
            ("subscription only", f"?subscription={OTHER_SUBSCRIPTION_ID}", 400, "unknown_model"),
            ("valid selector", "?model=hm-alpha&resourceGroup=rg-other", 200, None),
            (
                "valid selector with subscription",
                f"?model=hm-remote&resourceGroup=rg-remote&subscription={OTHER_SUBSCRIPTION_ID}",
                200,
                None,
            ),
            (
                "selector plus extra",
                "?model=hm-alpha&resourceGroup=rg-other&top=5",
                400,
                "unsupported_query",
            ),
        ]

        for label, selector, expected, code in cases:
            with self.subTest(label=label):
                response = self.client.get(f"/api/entities/api{selector}")
                self.assertEqual(response.status_code, expected)
                if code:
                    self.assertEqual(response.json()["error"]["code"], code)

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

        self.cloud.health_models.error = azure_error(500)
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
