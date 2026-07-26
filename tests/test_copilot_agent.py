import json
import os
import sys
import unittest
from pathlib import Path

import httpx


AGENT_SRC = Path(__file__).parents[1] / "copilot" / "agent" / "src"
sys.path.insert(0, str(AGENT_SRC))

from health_api import (
    HealthApiClient,
    HealthApiError,
    ReportRequest,
    entity_grounding_payload,
)


class RecordingTransport:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        return self.responses.pop(0)


class HealthApiClientTests(unittest.TestCase):
    def make_client(self, *responses):
        transport = RecordingTransport(responses)
        client = HealthApiClient(
            "https://health.example",
            client=httpx.Client(transport=httpx.MockTransport(transport)),
        )
        return client, transport

    def test_reads_fresh_rich_model_and_exact_entity_boundaries(self):
        inventory = {
            "model": {
                "name": "hm-ahm-movie-demo",
                "location": "northeurope",
                "provisioningState": "Succeeded",
                "healthState": "Degraded",
            },
            "observedAt": "2026-07-26T18:42:01Z",
            "entities": [
                {
                    "name": "api",
                    "healthState": "Degraded",
                    "signals": [
                        {
                            "name": "http-errors",
                            "healthState": "Degraded",
                            "value": 0.5,
                        },
                        {
                            "name": "web-ui-health-report",
                            "healthState": "Healthy",
                            "value": 1,
                        },
                    ],
                },
                {
                    "name": "database",
                    "healthState": "Healthy",
                    "signals": [],
                },
            ],
            "relationships": [
                {
                    "parentEntityName": "api",
                    "childEntityName": "database",
                    "displayName": "persists",
                }
            ],
            "reportOptions": {
                "signalName": "web-ui-health-report",
                "healthStates": [
                    "Healthy",
                    "Degraded",
                    "Unhealthy",
                    "Unknown",
                    "Deleted",
                ],
                "values": [None, 0, 0.5, 1],
                "expiries": [1, 5, 15, 30, 60, 120],
                "reasonPresets": [
                    {"value": "maintenance", "label": "Maintenance window"}
                ],
            },
        }
        detail = {
            "entity": {"name": "api", "healthState": "Degraded"},
            "observedAt": "2026-07-26T18:42:03Z",
            "transitions": [
                {
                    "previousState": "Healthy",
                    "healthState": "Degraded",
                    "occurredAt": "2026-07-26T18:40:00Z",
                },
                {
                    "previousState": "Unknown",
                    "healthState": "Healthy",
                    "occurredAt": "2026-07-26T18:30:00Z",
                },
            ],
            "canonicalSignal": {
                "name": "web-ui-health-report",
                "current": None,
                "history": [
                    {
                        "healthState": "Healthy",
                        "value": 1,
                        "occurredAt": "2026-07-26T18:35:00Z",
                    }
                ],
            },
        }
        client, transport = self.make_client(
            httpx.Response(200, json=inventory),
            httpx.Response(200, json=detail),
        )

        actual_inventory = client.read_health_model()
        actual_detail = client.read_entity("api")

        self.assertEqual(actual_inventory, inventory)
        self.assertEqual(actual_detail, detail)
        self.assertEqual(
            [(request.method, request.url.path) for request in transport.requests],
            [
                ("GET", "/api/health-model"),
                ("GET", "/api/entities/api"),
            ],
        )
        self.assertEqual(actual_inventory["entities"][0]["signals"][0]["value"], 0.5)
        self.assertEqual(len(actual_detail["transitions"]), 2)
        self.assertIsNone(actual_detail["canonicalSignal"]["current"])
        self.assertEqual(
            entity_grounding_payload(actual_detail),
            {
                "observedAt": "2026-07-26T18:42:03Z",
                "entity": {"name": "api", "healthState": "Degraded"},
                "transitions": {
                    "count": 2,
                    "newest": {
                        "previousState": "Healthy",
                        "healthState": "Degraded",
                        "occurredAt": "2026-07-26T18:40:00Z",
                    },
                },
                "canonicalSignal": {
                    "name": "web-ui-health-report",
                    "currentAvailable": False,
                    "current": None,
                    "historyCount": 1,
                    "newestHistory": {
                        "healthState": "Healthy",
                        "value": 1,
                        "occurredAt": "2026-07-26T18:35:00Z",
                    },
                },
            },
        )

    def test_confirmed_report_posts_exactly_once_and_returns_pending_acceptance(self):
        accepted = {
            "status": "accepted",
            "reportId": "report-42",
            "entityName": "api",
            "signalName": "web-ui-health-report",
            "requestedState": "Degraded",
            "submittedAt": "2026-07-26T18:44:00Z",
            "expiresAt": "2026-07-26T19:14:00Z",
        }
        client, transport = self.make_client(httpx.Response(202, json=accepted))
        report = ReportRequest(
            health_state="Degraded",
            value=0.5,
            expires_in_minutes=30,
            reason_preset="maintenance",
        )

        result = client.send_health_report("api", report)

        self.assertEqual(result, accepted)
        self.assertEqual(len(transport.requests), 1)
        request = transport.requests[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.path, "/api/entities/api/health-reports")
        self.assertEqual(
            json.loads(request.content),
            {
                "signalName": "web-ui-health-report",
                "healthState": "Degraded",
                "value": 0.5,
                "expiresInMinutes": 30,
                "reasonPreset": "maintenance",
            },
        )

    def test_invalid_report_values_never_write(self):
        cases = [
            ("entity", "", "Healthy", 1, 30, "maintenance", None),
            ("state", "api", "Error", 1, 30, "maintenance", None),
            ("value", "api", "Healthy", 0.25, 30, "maintenance", None),
            ("expiry", "api", "Healthy", 1, 1440, "maintenance", None),
            ("reason", "api", "Healthy", 1, 30, "other", None),
            ("custom", "api", "Healthy", 1, 30, "custom", ""),
        ]
        client, transport = self.make_client()

        for label, entity, state, value, expiry, reason, custom in cases:
            with self.subTest(label=label):
                report = ReportRequest(
                    health_state=state,
                    value=value,
                    expires_in_minutes=expiry,
                    reason_preset=reason,
                    custom_reason=custom,
                )
                with self.assertRaises(ValueError):
                    client.send_health_report(entity, report)
                self.assertEqual(transport.requests, [])

    def test_upstream_failures_are_bounded_and_keep_operation_id(self):
        cases = [
            (401, 503, False),
            (403, 503, False),
            (404, 404, False),
            (409, 409, True),
            (429, 503, True),
            (500, 503, True),
        ]
        for upstream_status, expected_status, retryable in cases:
            with self.subTest(upstream_status=upstream_status):
                client, transport = self.make_client(
                    httpx.Response(
                        upstream_status,
                        json={
                            "error": {
                                "code": "upstream-code",
                                "message": "secret upstream body",
                                "retryable": retryable,
                                "operationId": f"op-{upstream_status}",
                            }
                        },
                    )
                )
                with self.assertRaises(HealthApiError) as raised:
                    client.read_health_model()
                self.assertEqual(raised.exception.status_code, expected_status)
                self.assertEqual(raised.exception.retryable, retryable)
                self.assertEqual(raised.exception.operation_id, f"op-{upstream_status}")
                self.assertNotIn("secret upstream body", str(raised.exception))
                self.assertEqual(len(transport.requests), 1)

    def test_malformed_success_is_rejected_without_exposing_body(self):
        client, transport = self.make_client(
            httpx.Response(200, content=b'{"model":{"name":"partial"}}')
        )

        with self.assertRaises(HealthApiError) as raised:
            client.read_health_model()

        self.assertEqual(raised.exception.code, "malformed_health_response")
        self.assertFalse(raised.exception.retryable)
        self.assertNotIn("partial", str(raised.exception))
        self.assertEqual(len(transport.requests), 1)


if __name__ == "__main__":
    unittest.main()
