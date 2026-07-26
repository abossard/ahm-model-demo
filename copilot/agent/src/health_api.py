from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from opentelemetry import trace


CANONICAL_SIGNAL_NAME = "web-ui-health-report"
HEALTH_STATES = {"Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted"}
REPORT_VALUES = {None, 0, 0.5, 1}
REPORT_EXPIRIES = {1, 5, 15, 30, 60, 120}
REASON_PRESETS = {
    "demo-test",
    "investigating",
    "maintenance",
    "recovery",
    "custom",
}
MAX_RESPONSE_BYTES = 1_048_576
tracer = trace.get_tracer("ahm-health-copilot")


@dataclass(frozen=True)
class ReportRequest:
    health_state: str
    value: float | int | None
    expires_in_minutes: int
    reason_preset: str
    custom_reason: str | None = None

    def validate(self) -> None:
        if self.health_state not in HEALTH_STATES:
            raise ValueError("Unsupported health state.")
        if isinstance(self.value, bool) or self.value not in REPORT_VALUES:
            raise ValueError("Unsupported report value.")
        if (
            isinstance(self.expires_in_minutes, bool)
            or self.expires_in_minutes not in REPORT_EXPIRIES
        ):
            raise ValueError("Unsupported report expiry.")
        if self.reason_preset not in REASON_PRESETS:
            raise ValueError("Unsupported report reason.")
        if self.reason_preset == "custom":
            reason = self.custom_reason
            if (
                not isinstance(reason, str)
                or not reason.strip()
                or len(reason.strip()) > 280
                or "\x00" in reason
            ):
                raise ValueError("Custom reason must be 1 to 280 characters.")
        elif self.custom_reason is not None:
            raise ValueError("Custom reason requires the custom preset.")

    def payload(self) -> dict[str, Any]:
        self.validate()
        payload: dict[str, Any] = {
            "signalName": CANONICAL_SIGNAL_NAME,
            "healthState": self.health_state,
            "value": self.value,
            "expiresInMinutes": self.expires_in_minutes,
            "reasonPreset": self.reason_preset,
        }
        if self.custom_reason is not None:
            payload["customReason"] = self.custom_reason.strip()
        return payload


class HealthApiError(RuntimeError):
    def __init__(
        self,
        status_code: int,
        code: str,
        retryable: bool,
        operation_id: str,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.retryable = retryable
        self.operation_id = operation_id
        disposition = "retryable" if retryable else "not retryable"
        super().__init__(
            f"Health operation failed ({code}, {disposition}, operation {operation_id})."
        )


def entity_grounding_payload(payload: dict[str, Any]) -> dict[str, Any]:
    transitions = payload["transitions"]
    signal = payload["canonicalSignal"]
    history = signal["history"]
    return {
        "observedAt": payload["observedAt"],
        "entity": payload["entity"],
        "transitions": {
            "count": len(transitions),
            "newest": transitions[0] if transitions else None,
        },
        "canonicalSignal": {
            "name": signal["name"],
            "currentAvailable": signal["current"] is not None,
            "current": signal["current"],
            "historyCount": len(history),
            "newestHistory": history[0] if history else None,
        },
    }


class HealthApiClient:
    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.Client | None = None,
        timeout_seconds: float = 8.0,
    ) -> None:
        normalized = base_url.rstrip("/")
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("HEALTH_APP_BASE_URL must be HTTP or HTTPS.")
        self._base_url = normalized
        self._client = client or httpx.Client(timeout=timeout_seconds)

    def read_health_model(self) -> dict[str, Any]:
        with tracer.start_as_current_span("health_api.read_model") as span:
            span.set_attribute("health.tool", "read_health_model")
            payload = self._request("GET", "/api/health-model")
            self._require_fields(
                payload,
                {"model", "observedAt", "entities", "relationships", "reportOptions"},
            )
            if not isinstance(payload["model"], dict) or not isinstance(
                payload["entities"], list
            ):
                raise self._malformed()
            span.set_attribute("health.outcome", "success")
            return payload

    def read_entity(self, entity_name: str) -> dict[str, Any]:
        entity = self._validate_entity(entity_name)
        with tracer.start_as_current_span("health_api.read_entity") as span:
            span.set_attribute("health.tool", "read_entity")
            span.set_attribute("health.entity", entity)
            payload = self._request("GET", f"/api/entities/{quote(entity, safe='')}")
            self._require_fields(
                payload,
                {"entity", "observedAt", "transitions", "canonicalSignal"},
            )
            if not isinstance(payload["entity"], dict) or not isinstance(
                payload["transitions"], list
            ):
                raise self._malformed()
            span.set_attribute("health.outcome", "success")
            return payload

    def send_health_report(
        self, entity_name: str, report: ReportRequest
    ) -> dict[str, Any]:
        entity = self._validate_entity(entity_name)
        with tracer.start_as_current_span("health_api.send_report") as span:
            span.set_attribute("health.tool", "send_health_report")
            span.set_attribute("health.entity", entity)
            span.set_attribute("health.requested_state", report.health_state)
            span.set_attribute(
                "health.expiry_minutes",
                report.expires_in_minutes,
            )
            payload = self._request(
                "POST",
                f"/api/entities/{quote(entity, safe='')}/health-reports",
                json=report.payload(),
                expected_status=202,
            )
            self._require_fields(
                payload,
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
            if payload["status"] != "accepted":
                raise self._malformed()
            span.set_attribute("health.outcome", "accepted_pending")
            return payload

    @staticmethod
    def _validate_entity(entity_name: str) -> str:
        if (
            not isinstance(entity_name, str)
            or not entity_name.strip()
            or len(entity_name) > 256
            or "\x00" in entity_name
        ):
            raise ValueError("Entity name is required and must be bounded.")
        return entity_name

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        expected_status: int = 200,
    ) -> dict[str, Any]:
        try:
            response = self._client.request(
                method,
                f"{self._base_url}{path}",
                json=json,
                headers={"Accept": "application/json"},
            )
        except (httpx.TimeoutException, httpx.NetworkError):
            raise HealthApiError(
                503,
                "health_api_unavailable",
                True,
                uuid.uuid4().hex,
            ) from None
        if response.status_code != expected_status:
            raise self._upstream_error(response)
        if len(response.content) > MAX_RESPONSE_BYTES:
            raise self._malformed()
        try:
            payload = response.json()
        except ValueError:
            raise self._malformed() from None
        if not isinstance(payload, dict):
            raise self._malformed()
        return payload

    @staticmethod
    def _require_fields(payload: dict[str, Any], fields: set[str]) -> None:
        if not fields.issubset(payload):
            raise HealthApiClient._malformed()

    @staticmethod
    def _malformed() -> HealthApiError:
        return HealthApiError(
            502,
            "malformed_health_response",
            False,
            uuid.uuid4().hex,
        )

    @staticmethod
    def _upstream_error(response: httpx.Response) -> HealthApiError:
        status_mapping = {
            401: (503, False),
            403: (503, False),
            404: (404, False),
            409: (409, True),
            429: (503, True),
        }
        status_code, retryable = status_mapping.get(
            response.status_code, (503, response.status_code >= 500)
        )
        operation_id = uuid.uuid4().hex
        code = "health_api_unavailable"
        try:
            error = response.json().get("error", {})
            if isinstance(error, dict):
                upstream_id = error.get("operationId")
                if isinstance(upstream_id, str) and 1 <= len(upstream_id) <= 128:
                    operation_id = upstream_id
        except (ValueError, AttributeError):
            pass
        return HealthApiError(status_code, code, retryable, operation_id)
