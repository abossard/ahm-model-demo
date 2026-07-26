import importlib
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import mock


SUBSCRIPTION_ID = "b2af20ad-98fa-4aa7-94c3-059663641d9f"
SUBSCRIPTION_NAME = "ME-MngEnvMCAP462928-anbossar-1"
RESOURCE_GROUP = "rg-ahm-movie-demo"
MODEL_NAME = "hm-ahm-movie-demo"
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


class RecordingHealthModels:
    def __init__(self, model):
        self.model = model
        self.calls = []
        self.error = None

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.error:
            raise self.error
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

        cls.credential = mock.Mock(name="managed_identity_credential")
        cls.bootstrap_cloud = mock.Mock(name="bootstrap_cloud_client")
        cls.patchers = [
            mock.patch(
                "azure.identity.ManagedIdentityCredential",
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

        app_path = os.path.join(os.path.dirname(__file__), "..", "app")
        sys.path.insert(0, os.path.abspath(app_path))
        sys.modules.pop("app", None)
        cls.module = importlib.import_module("app")

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
        self.module.app.config.update(TESTING=True)
        self.client = self.module.app.test_client()

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
            "frame-ancestors 'none'",
        )

    def test_plain_root_is_side_effect_free_ui(self):
        with mock.patch.dict(os.environ, {"COPILOT_URL": ""}):
            response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "text/html")
        body = response.get_data(as_text=True)
        self.assertIn("The Health Pulse", body)
        self.assertIn("app.css", body)
        self.assertIn("app.js", body)
        self.assertNotIn("Health copilot", body)
        self.enqueue_mock.assert_not_called()
        self.insert_mock.assert_not_called()
        self.peek_mock.assert_not_called()
        self.assertEqual(self.cloud.entities.list_calls, [])
        self.assert_security_headers(response)

    def test_valid_copilot_url_adds_optional_link_without_replacing_controls(self):
        with mock.patch.dict(
            os.environ,
            {"COPILOT_URL": "https://copilot.example.test"},
        ):
            response = self.client.get("/")

        body = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn(
            'href="https://copilot.example.test"',
            body,
        )
        self.assertIn("Health copilot", body)
        self.assertIn("Refresh live status", body)
        self.assertIn("Stage a health report", body)
        self.assertIn("Queue + PostgreSQL demo", body)
        self.assert_security_headers(response)

    def test_unsafe_copilot_url_fails_closed_without_link(self):
        for copilot_url in [
            "javascript:alert(1)",
            "http://copilot.example.test",
            "https://user:password@copilot.example.test",
        ]:
            with self.subTest(copilot_url=copilot_url):
                with mock.patch.dict(os.environ, {"COPILOT_URL": copilot_url}):
                    response = self.client.get("/")
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("Health copilot", response.get_data(as_text=True))

    def test_model_read_returns_rich_dynamic_inventory_once(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
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
        payload = response.get_json()
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
        self.assertEqual(response.get_json()["error"]["code"], "entity_not_found")
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
                payload = response.get_json()
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
                    data=json.dumps(body),
                    content_type=content_type,
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
                    self.assertEqual(response.mimetype, "text/html")
                else:
                    self.assertEqual(
                        set(response.get_json()),
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
                payload = response.get_json()
                self.assertEqual(payload["error"]["retryable"], retryable)
                self.assertEqual(len(payload["error"]["operationId"]), 32)
                self.assertNotIn("SECRET_AZURE_BODY", response.get_data(as_text=True))
                self.assertNotIn("do-not-leak", response.get_data(as_text=True))
                self.assertNotIn("SECRET_AZURE_BODY", "\n".join(captured.output))
                self.assertNotIn("do-not-leak", "\n".join(captured.output))

    def test_html_like_names_remain_data_and_headers_are_restrictive(self):
        response = self.client.get("/api/health-model")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["entities"][-1]["displayName"],
            "Discovered <img src=x onerror=alert(1)>",
        )
        root = self.client.get("/")
        self.assertNotIn("unsafe-inline", root.headers["Content-Security-Policy"])
        self.assert_security_headers(root)

    def test_runtime_scope_rejects_every_mismatch(self):
        exact = dict(self.environment)
        cases = {
            "AZURE_SUBSCRIPTION_ID": "00000000-0000-0000-0000-000000000000",
            "AZURE_SUBSCRIPTION_NAME": "another-subscription",
            "AZURE_RESOURCE_GROUP": "another-rg",
            "HEALTH_MODEL_NAME": "another-model",
            "HEALTH_MODEL_LOCATION": "eastus",
        }

        for key, wrong_value in cases.items():
            with self.subTest(key=key):
                candidate = {**exact, key: wrong_value}
                with self.assertRaises(RuntimeError):
                    self.module.validate_runtime_scope(candidate)

        self.module.validate_runtime_scope(exact)


if __name__ == "__main__":
    unittest.main()
