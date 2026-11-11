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
TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default"
ARM_DEFAULT_SCOPE = "https://management.azure.com/.default"
ARM_DELEGATED_SCOPE = "https://management.azure.com/user_impersonation"
MAX_TOKEN_CHARS = 16 * 1024
TOKEN_LEEWAY_SECONDS = 60
OBO_TOKEN_CACHE_SIZE = 256
OBO_EXPIRY_MARGIN_SECONDS = 300
NONCE_BYTES = 32
NONCE_MAX_CHARS = 128
BROKER_CALLS_PER_MINUTE = 30
MEMORY_STORE_URL = "memory:"
FAKE_AGENT_ENDPOINT = "fake:"
TASK_TYPES = ("review", "explain", "design")
INSTRUCTION_MAX_CHARS = 2000
SESSION_TITLE_MAX_CHARS = 120
TASK_TIMEOUT_SECONDS = 1800
SSE_KEEP_ALIVE_SECONDS = 15
AGENT_TOKEN_SCOPE = "https://ai.azure.com/.default"
AGENT_API_VERSION = "v1"
AGENT_WAIT_SECONDS = 120
GITHUB_REPOSITORY = re.compile(
    r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?/?"
)
REPOSITORY_URL_MAX_CHARS = 200
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
TOKEN_MARKER = "eyJ"
TOKEN_RUN = re.compile(r"[\w-]+")
TOKEN_PATTERN = re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+")
REDACTED_TOKEN = "[redacted token]"
GUID = re.compile(r"[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}")
RESOURCE_GROUP_NAME = re.compile(r"[A-Za-z0-9_.()-]{1,90}")
ARM_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{1,258}[A-Za-z0-9]")
CLOUDHEALTH_API_VERSION = "2026-11-01"
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
    "img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com; base-uri 'none'; "
    "frame-ancestors 'none'"
)

UI_DIST_DIR = Path(
    os.environ.get(
        "UI_DIST_DIR",
        str(Path(__file__).resolve().parent.parent / "ui" / "dist"),
    )
)


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
        "client_id": environment.get("ENTRA_CLIENT_ID", "").strip() or None,
        "api_scope": environment.get("ENTRA_API_SCOPE", "").strip() or None,
        "mcp_scope": environment.get("MCP_SCOPE", "").strip() or None,
        "agent_principal_id": environment.get("FOUNDRY_AGENT_PRINCIPAL_ID", "").strip(),
        "managed_identity_client_id": environment.get("AZURE_CLIENT_ID", "").strip() or None,
    }
