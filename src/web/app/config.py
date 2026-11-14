import os
import re
from pathlib import Path


# Every deployed value comes from the selected azd environment: bicep writes its outputs back
# into `.azure/<env>/.env`, and the deployed container app injects them as container env vars. Nothing
# here may name a stack, so an unconfigured app fails at import instead of silently reporting
# health into whichever environment a stale literal happened to name.
REQUIRED_ENV = (
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "AZURE_RESOURCE_GROUP",
    "AZURE_SUBSCRIPTION_ID",
    "HEALTH_MODEL_NAME",
    "HEALTH_MODEL_DESIGN_NAME",
    "SESSIONS_CONTAINER_URL",
    "FOUNDRY_PROJECT_ENDPOINT",
    "FOUNDRY_AGENT_NAME",
)
AUTH_MODES = ("entra", "local")
ENTRA_ENV = ("ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_API_SCOPE", "MCP_SCOPE", "AZURE_CLIENT_ID")
LOCAL_OID = "local"
LOCAL_NAME = "Local developer"
# The tenant id Entra gives to personal Microsoft accounts. A token issued by it never reaches Azure Resource Manager.
CONSUMERS_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad"
AUTHORITY_HOST = "https://login.microsoftonline.com"
TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default"
ARM_DEFAULT_SCOPE = "https://management.azure.com/.default"
ARM_DELEGATED_SCOPE = "https://management.azure.com/user_impersonation"
MAX_TOKEN_CHARS = 16 * 1024
TOKEN_LEEWAY_SECONDS = 60
OBO_TOKEN_CACHE_SIZE = 256
OBO_APPLICATION_CACHE_SIZE = 64
OBO_EXPIRY_MARGIN_SECONDS = 300
NONCE_BYTES = 32
NONCE_MAX_CHARS = 128
BROKER_CALLS_PER_MINUTE = 30
MEMORY_STORE_URL = "memory:"
FAKE_AGENT_ENDPOINT = "fake:"
TASK_TYPES = ("review", "explain", "design")
INSTRUCTION_MAX_CHARS = 2000
SESSION_TITLE_MAX_CHARS = 120
TASK_TIMEOUT_SECONDS = 600
BUSY_RETRY_SECONDS = (5, 15, 30)
SSE_KEEP_ALIVE_SECONDS = 15
AGENT_TOKEN_SCOPE = "https://ai.azure.com/.default"
AGENT_API_VERSION = "v1"
AGENT_WAIT_SECONDS = 120
# The same rule as the agent's `clone_repository` (src/agent/src/clone.py): an address it refuses must be refused at the start of the Task.
GITHUB_REPOSITORY = re.compile(
    r"https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\.git)?/?"
)
MAX_SESSIONS = 200
MAX_TASKS_PER_SESSION = 50
MAX_BODY_BYTES = 64 * 1024
MAX_CONCURRENT_RUNS = 3
MAX_SUBSCRIBERS_PER_TASK = 20
MAX_CHANGES = 200
MAX_AFTER_BYTES = 64 * 1024
CATALOG_CACHE_SECONDS = 30
MODEL_CACHE_SECONDS = 60
MODEL_CACHE_SIZE = 256
INTERRUPTED_GRACE_SECONDS = 120
FINAL_SAVE_DELAYS = (0.2, 0.5, 1.0)
ERROR_MESSAGE_CHARS = 300
PROBLEM_LIMIT = 50
PROBLEM_CHARS = 8 * 1024
PROBLEM_TEXT_CHARS = 200
TOKEN_MARKER = "eyJ"
TOKEN_RUN = re.compile(r"[\w-]+")
TOKEN_PATTERN = re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+")
REDACTED_TOKEN = "[redacted token]"
GUID = re.compile(r"[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}")
RESOURCE_GROUP_NAME = re.compile(r"[A-Za-z0-9_.()-]{1,90}")
ARM_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{1,258}[A-Za-z0-9]")
CLOUDHEALTH_API_VERSION = "2026-11-01"
TIMELINE_RETENTION_DAYS = 30
# The moment an Explain is about (`asOf`) may be this far ahead of the app's clock: a browser's clock is never quite the app's.
AS_OF_SKEW_SECONDS = 120
TIMELINE_MIN_SPAN_SECONDS = 60
TIMELINE_DEFAULT_SPAN_HOURS = 24
TIMELINE_MAX_SERIES = 120
TIMELINE_MAX_ENTITIES = 200
TIMELINE_MAX_CALLS = 400
TIMELINE_CALL_CONCURRENCY = 16
TIMELINE_GLOBAL_CONCURRENCY = 24
TIMELINE_DEADLINE_SECONDS = 40
TIMELINE_SIGNAL_PAGES = 4
TIMELINE_STATE_PAGES = 5
TIMELINE_ANNOTATION_PAGES = 3
TIMELINE_ANNOTATION_PAGE_SIZE = 100
TIMELINE_LIVE_CACHE_SECONDS = 30
TIMELINE_PAST_CACHE_SECONDS = 300
TIMELINE_STRUCTURE_CACHE_SECONDS = 30
TIMELINE_CACHE_SIZE = 4096
HUB_POLL_SECONDS = 30
LIVE_RETRY_MS = 3000
HUB_GRACE_SECONDS = 20
HUB_MAX_BACKOFF_SECONDS = 300
HUB_MAX_HUBS = 8
HUB_MAX_SUBSCRIBERS = 50
HUB_MAX_STREAMS_PER_USER = 6
HUB_QUEUE_SIZE = 64
HUB_RING_SIZE = 256
HUB_ACCESS_RECHECK_SECONDS = 300
HUB_ANNOTATION_SECONDS = 300
HUB_READ_CONCURRENCY = 4
HUB_OVERLAP_MS = 2 * 60 * 1000
# Polls a seen state change is read from its history before the hub stops waiting for the history to show it.
HUB_TAIL_TRIES = 10
HISTORY_SAFETY_SECONDS = 15 * 60
# The tiles of past history held in memory, by the bytes of their stored text (ADR 0011).
HISTORY_MEMORY_BYTES = 64 * 1024 * 1024
HISTORY_PREFIX = "history/v2"
# The first layout, one blob per history and bucket: still read where the new one has nothing, until it ages out of the 30 days.
HISTORY_LEGACY_PREFIX = "history/v1"
HISTORY_LEGACY_MODELS = 32
HISTORY_LEGACY_RETRY_SECONDS = 60
HISTORY_WRITE_ATTEMPTS = 3
# Blobs are written after the answer has gone: this many at once, and at most this many waiting (more are left unwritten).
HISTORY_WRITERS = 4
HISTORY_WRITE_QUEUE = 256
# What a live hub holds of the days and weeks it records, at most, before it gives the oldest up to Azure.
HISTORY_RECORD_MAX_POINTS = 300_000
HISTORY_RECORD_MAX_TRANSITIONS = 20_000
# Filling a model's missing history in the background when a user opens it, with that user's sign-in (ADR 0011).
PREWARM_CONCURRENCY = 2
PREWARM_GLOBAL_CONCURRENCY = 4
PREWARM_CALLS_PER_MINUTE = 300
PREWARM_MAX_CALLS = 8000
PREWARM_MAX_FILLS = 2
PREWARM_RETRY_SECONDS = 600
PREWARM_BUSY_SECONDS = 60
PREWARM_MAX_BACKOFF_SECONDS = 300
PREWARM_BUSY_RETRIES = 3
PREWARM_ERROR_LIMIT = 3
PREWARM_TOKEN_MARGIN_SECONDS = 120
PREWARM_MODELS = 256
CANONICAL_SIGNAL_NAME = "web-ui-health-report"
RESERVED_SIGNAL_NAME = "database-connectivity-probe"
HEALTH_STATES = ("Healthy", "Degraded", "Unhealthy", "Unknown")
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
SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; "
    "style-src 'self' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='; "
    "img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com https://management.azure.com; base-uri 'none'; "
    "frame-ancestors 'none'"
)

UI_DIST_DIR = Path(
    os.environ.get(
        "UI_DIST_DIR",
        str(Path(__file__).resolve().parent.parent / "ui" / "dist"),
    )
)


def parse_allowed_tenants(text):
    """The tenant ids that may sign in, from a comma or space separated list. Empty means every directory."""
    tenants = frozenset(item.casefold() for item in re.split(r"[,\s]+", text) if item)
    for tenant in tenants:
        if not GUID.fullmatch(tenant) or tenant == CONSUMERS_TENANT_ID:
            raise RuntimeError(
                "ENTRA_ALLOWED_TENANTS must list directory (tenant) ids separated by commas, "
                "and never the personal-account tenant."
            )
    return tenants


def require_runtime_config(environment):
    auth_mode = environment.get("AUTH_MODE", "").strip().lower() or "entra"
    if auth_mode not in AUTH_MODES:
        raise RuntimeError(f"AUTH_MODE must be one of {', '.join(AUTH_MODES)}, not '{auth_mode}'.")
    if auth_mode == "local" and environment.get("CONTAINER_APP_NAME", "").strip():
        raise RuntimeError(
            "AUTH_MODE=local turns sign-in off and is for development only. It is refused "
            "inside a Container App: remove AUTH_MODE or set it to entra."
        )
    required = REQUIRED_ENV + (ENTRA_ENV if auth_mode == "entra" else ())
    missing = [name for name in required if not environment.get(name, "").strip()]
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
        "design_model_name": environment["HEALTH_MODEL_DESIGN_NAME"].strip(),
        "sessions_container_url": environment["SESSIONS_CONTAINER_URL"].strip(),
        "foundry_project_endpoint": environment["FOUNDRY_PROJECT_ENDPOINT"].strip(),
        "foundry_agent_name": environment["FOUNDRY_AGENT_NAME"].strip(),
        "auth_mode": auth_mode,
        "tenant_id": environment.get("ENTRA_TENANT_ID", "").strip() or None,
        "allowed_tenants": parse_allowed_tenants(environment.get("ENTRA_ALLOWED_TENANTS", "")),
        "client_id": environment.get("ENTRA_CLIENT_ID", "").strip() or None,
        "api_scope": environment.get("ENTRA_API_SCOPE", "").strip() or None,
        "mcp_scope": environment.get("MCP_SCOPE", "").strip() or None,
        "agent_principal_id": environment.get("FOUNDRY_AGENT_PRINCIPAL_ID", "").strip(),
        "managed_identity_client_id": environment.get("AZURE_CLIENT_ID", "").strip() or None,
    }
