import os
from pathlib import Path


EXPECTED_SUBSCRIPTION_ID = os.environ.get(
    "EXPECTED_SUBSCRIPTION_ID", "b2af20ad-98fa-4aa7-94c3-059663641d9f"
)
EXPECTED_SUBSCRIPTION_NAME = os.environ.get(
    "EXPECTED_SUBSCRIPTION_NAME", "ME-MngEnvMCAP462928-anbossar-1"
)
EXPECTED_RESOURCE_GROUP = os.environ.get("EXPECTED_RESOURCE_GROUP", "rg-ahm-demo")
EXPECTED_MODEL_NAME = os.environ.get("EXPECTED_MODEL_NAME", "hm-ahm-demo")
EXPECTED_MODEL_LOCATION = os.environ.get("EXPECTED_MODEL_LOCATION", "northeurope")
CLOUDHEALTH_API_VERSION = "2026-05-01-preview"
CANONICAL_SIGNAL_NAME = "web-ui-health-report"
RESERVED_SIGNAL_NAME = "database-connectivity-probe"
HEALTH_STATES = ("Healthy", "Degraded", "Unhealthy", "Unknown", "Deleted")
REPORT_VALUES = (None, 0, 0.5, 1)
REPORT_EXPIRIES = (1, 5, 15, 30, 60, 120)
REASON_PRESETS = {
    "demo-test": "Demo test",
    "investigating": "Investigating",
    "maintenance": "Maintenance window",
    "recovery": "Recovery confirmed",
    "custom": None,
}
REPORT_KEYS = {
    "signalName",
    "healthState",
    "value",
    "expiresInMinutes",
    "reasonPreset",
    "customReason",
}
PARENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
    "frame-src 'self'; frame-ancestors 'none'"
)
AGENT_ERROR_SECURITY_POLICY = (
    "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; "
    "form-action 'none'"
)
AGENT_WEB_ORIGIN = os.environ.get("AGENT_WEB_ORIGIN", "http://127.0.0.1:3000")
AGENT_MAX_BODY_BYTES = 1_048_576
AGENT_BODY_CHUNK_BYTES = 65_536
AGENT_PROXY_CONCURRENCY = 8
AGENT_REQUEST_HEADERS = {
    "accept",
    "accept-encoding",
    "accept-language",
    "cache-control",
    "content-type",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
}
AGENT_RESPONSE_HEADERS = {
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-range",
    "content-security-policy",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "referrer-policy",
    "vary",
    "x-content-type-options",
}
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

UI_DIST_DIR = Path(
    os.environ.get(
        "UI_DIST_DIR",
        str(Path(__file__).resolve().parent.parent / "ui" / "dist"),
    )
)


def validate_runtime_scope(environment):
    expected = {
        "AZURE_SUBSCRIPTION_ID": EXPECTED_SUBSCRIPTION_ID,
        "AZURE_SUBSCRIPTION_NAME": EXPECTED_SUBSCRIPTION_NAME,
        "AZURE_RESOURCE_GROUP": EXPECTED_RESOURCE_GROUP,
        "HEALTH_MODEL_NAME": EXPECTED_MODEL_NAME,
        "HEALTH_MODEL_LOCATION": EXPECTED_MODEL_LOCATION,
    }
    mismatches = [
        key
        for key, value in expected.items()
        if environment.get(key, "").strip().lower() != value.lower()
    ]
    if mismatches:
        raise RuntimeError(
            "Health Model runtime scope mismatch: " + ",".join(sorted(mismatches))
        )


def copilot_enabled(environment):
    return environment.get("HEALTH_COPILOT_ENABLED", "false").strip().lower() == "true"
