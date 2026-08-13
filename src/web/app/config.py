import os
from pathlib import Path


# Every deployed value comes from the selected azd environment: bicep writes its outputs back
# into `.azure/<env>/.env`, and both hosting paths inject them as container env vars. Nothing
# here may name a stack, so an unconfigured app fails at import instead of silently reporting
# health into whichever environment a stale literal happened to name.
REQUIRED_ENV = (
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "AZURE_RESOURCE_GROUP",
    "AZURE_SUBSCRIPTION_ID",
    "HEALTH_MODEL_NAME",
    "POSTGRES_HOST",
    "POSTGRES_USER",
    "QUEUE_URL",
)
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


def require_runtime_config(environment):
    missing = [name for name in REQUIRED_ENV if not environment.get(name, "").strip()]
    if missing:
        raise RuntimeError(
            "Missing Health Model runtime configuration: "
            + ",".join(missing)
            + ". Run 'azd env select <name>' then 'scripts/local-env.sh' to export the "
            "selected environment, or redeploy so the platform injects them."
        )
    return {
        "subscription_id": environment["AZURE_SUBSCRIPTION_ID"].strip(),
        "resource_group": environment["AZURE_RESOURCE_GROUP"].strip(),
        "model_name": environment["HEALTH_MODEL_NAME"].strip(),
    }


def copilot_enabled(environment):
    return environment.get("HEALTH_COPILOT_ENABLED", "false").strip().lower() == "true"
