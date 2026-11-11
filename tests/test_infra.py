import ipaddress
import json
import os
import re
import subprocess
import tempfile
import unittest
from functools import cache
from pathlib import Path

ROOT = Path(__file__).parents[1]
AGENT_DIR = ROOT / "src" / "agent"
DEPLOY_SCRIPT = AGENT_DIR / "deploy" / "deploy-agent.sh"

# Split so the pattern does not match its own source and exempt this file from the sweep.
ACCOUNT_IDENTIFIER = r"ME-" r"MngEnv\w*|@microsoft\.com"

SUBSCRIPTION_ID = "11111111-1111-1111-1111-111111111111"

GUID = r"'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'"
BICEP_DIAGNOSTIC = re.compile(r"\) : (?:Warning|Error) [\w-]+:")

WEB_ENV = (
    "AZURE_CLIENT_ID",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "APPLICATIONINSIGHTS_AUTHENTICATION_STRING",
    "OTEL_SERVICE_NAME",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_SUBSCRIPTION_NAME",
    "AZURE_RESOURCE_GROUP",
    "HEALTH_MODEL_NAME",
    "HEALTH_MODEL_LOCATION",
    "HEALTH_MODEL_DESIGN_NAME",
    "SESSIONS_CONTAINER_URL",
    "FOUNDRY_PROJECT_ENDPOINT",
    "FOUNDRY_AGENT_NAME",
    "FOUNDRY_AGENT_PRINCIPAL_ID",
    "ENTRA_TENANT_ID",
    "ENTRA_ALLOWED_TENANTS",
    "ENTRA_CLIENT_ID",
    "ENTRA_API_SCOPE",
    "MCP_SCOPE",
    "MCP_URL",
)

# What src/agent/deploy/deploy-agent.sh takes from the azd environment; every name is a main.bicep output.
DEPLOY_SCRIPT_ENV = (
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_RESOURCE_GROUP",
    "AZURE_CONTAINER_REGISTRY_NAME",
    "AZURE_CONTAINER_REGISTRY_ENDPOINT",
    "FOUNDRY_PROJECT_ENDPOINT",
    "FOUNDRY_MODEL_DEPLOYMENT_NAME",
    "FOUNDRY_AGENT_EGRESS_POLICY_ID",
    "FOUNDRY_AGENT_NAME",
)

# Values azd defines itself; the script may read them without a main.bicep output.
AZD_BUILT_INS = ("AZURE_ENV_NAME", "AZURE_LOCATION", "AZURE_PRINCIPAL_ID")

# What the same script lets the caller override or tune. None of them is an azd output. The script may drop any of them.
DEPLOY_SCRIPT_OVERRIDES = (
    "AGENT_NAME",
    "AZMCP_REPO",
    "AZMCP_REF",
    "ACTIVATION_TIMEOUT_SECONDS",
    "POLL_INTERVAL_SECONDS",
    "FORBIDDEN_RETRY_SECONDS",
)

# The Azure MCP server is built once, in src/mcp/Dockerfile, from these build arg defaults. The ref is a commit of the
# branch abossard/healthmodels-inspect, so a push to the branch changes no deployed image.
AZMCP_BUILD_ARGS = {
    "AZMCP_REPO": "https://github.com/abossard/mcp.git",
    "AZMCP_REF": "b844ad32aa998647ede5368e30512d3901e37770",
}
MCP_DIR = ROOT / "src" / "mcp"

# The Azure MCP server flags the Dockerfile fixes: remote HTTP, on behalf of the caller, read-only, two namespaces.
MCP_SERVER_FLAGS = (
    "server", "start",
    "--transport", "http",
    "--outgoing-auth-strategy", "UseOnBehalfOf",
    "--mode", "all",
    "--namespace", "monitor",
    "--namespace", "group",
    "--read-only",
)

# The Azure CLI public client. entraAllowAzureCli pre-authorizes it for the web API scope, and for nothing else.
AZURE_CLI_APPLICATION_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"

# The Microsoft Entra app ids and delegated permission ids of the APIs the two app registrations call on the user's
# behalf. They are the same in every tenant; the Log Analytics ids come from `az ad sp show` on its service principal.
ARM = ("797f4846-ba00-4fd7-ba43-dac1f8f63013", "41094075-9dad-400e-a0bd-54e686782033")
LOG_ANALYTICS = ("ca7f3f0b-7d91-482c-8e09-c5d840d0eac5", "e8dac03d-d467-4a7e-9293-9cca7df08b31")

# Files that still name the removed agent-app and are owned outside this suite (UI fixtures). The
# test fails when an entry stops matching, so the list only shrinks.
AGENT_APP_PENDING = {
    "src/web/ui/tests/denseModel.ts",
}
# Decision records and plans may name what they removed.
AGENT_APP_EXEMPT = ("docs/adr/", "docs/redesign/", "tests/test_infra.py")

# What scripts/local-env.sh takes from the azd environment, in export order. It exports SESSIONS_CONTAINER_URL last and
# never from azd: the session store has only a private endpoint, so a local run keeps Sessions in process memory.
LOCAL_ENV = (
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_RESOURCE_GROUP",
    "HEALTH_MODEL_NAME",
    "HEALTH_MODEL_DESIGN_NAME",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "FOUNDRY_PROJECT_ENDPOINT",
    "FOUNDRY_AGENT_NAME",
)
LOCAL_SESSIONS_URL = "memory:"
LOCAL_AUTH_MODE = "local"

# Independent, hand-declared topology of hm-<env>. Not derived from the module under test, so a wrong
# module cannot make this oracle agree with it.
APP_ROOT = "<model name>"

APP_ENTITIES = {
    # name: (display name, layer, x)
    APP_ROOT: ("Health Pulse", "root", 560),
    "flow-view-health-model": ("View Health Model", "flow", 80),
    "flow-send-health-reports": ("Send Health Reports", "flow", 320),
    "flow-run-agent-tasks": ("Run agent tasks", "flow", 740),
    "system-app-hosting": ("App Hosting", "system", 200),
    "system-agent-runtime": ("Agent Runtime", "system", 530),
    "system-ai-inference": ("AI Inference", "system", 860),
    "system-session-store": ("Session Store", "system", 1080),
    "container-app": ("Web Container App", "resource", 200),
    "hosted-agent": ("Foundry Hosted Agent", "resource", 420),
    "mcp-server": ("Azure MCP Server", "resource", 640),
    "foundry-account": ("Foundry Account", "resource", 860),
    "session-storage": ("Session Storage", "resource", 1080),
    "platform-context": ("Azure Platform Context", "context", 1300),
    "discovered-app-topology": ("Discovered Application Topology", "context", 1520),
}

APP_LAYER_Y = {"root": 40, "flow": 190, "context": 190, "system": 340, "resource": 490}

APP_IMPACT = {"platform-context": "Limited", "discovered-app-topology": "Suppressed"}

# Entities that aggregate their children; every other entity reads signals only.
APP_ROLLUP = {
    APP_ROOT,
    "flow-view-health-model",
    "flow-send-health-reports",
    "flow-run-agent-tasks",
    "system-app-hosting",
    "system-agent-runtime",
    "system-ai-inference",
    "system-session-store",
    "container-app",
    "discovered-app-topology",
}

APP_EDGES = {
    "r-root-view-health-model": (APP_ROOT, "flow-view-health-model"),
    "r-root-send-health-reports": (APP_ROOT, "flow-send-health-reports"),
    "r-root-run-agent-tasks": (APP_ROOT, "flow-run-agent-tasks"),
    "r-root-platform": (APP_ROOT, "platform-context"),
    "r-root-discovery": (APP_ROOT, "discovered-app-topology"),
    "r-view-health-model-app-hosting": ("flow-view-health-model", "system-app-hosting"),
    "r-send-health-reports-app-hosting": ("flow-send-health-reports", "system-app-hosting"),
    "r-run-agent-tasks-app-hosting": ("flow-run-agent-tasks", "system-app-hosting"),
    "r-run-agent-tasks-agent-runtime": ("flow-run-agent-tasks", "system-agent-runtime"),
    "r-run-agent-tasks-ai-inference": ("flow-run-agent-tasks", "system-ai-inference"),
    "r-run-agent-tasks-session-store": ("flow-run-agent-tasks", "system-session-store"),
    "r-app-hosting-container-app": ("system-app-hosting", "container-app"),
    "r-agent-runtime-hosted-agent": ("system-agent-runtime", "hosted-agent"),
    "r-agent-runtime-mcp-server": ("system-agent-runtime", "mcp-server"),
    "r-ai-inference-foundry-account": ("system-ai-inference", "foundry-account"),
    "r-session-store-session-storage": ("system-session-store", "session-storage"),
}

REMOVED_ENTITIES = (
    "request-journey",
    "flow-ask-copilot",
    "system-database",
    "system-queueing",
    "postgres",
    "queue-storage",
    "agent-web-app",
    "agent-app",
    "openai-account",
    "aks-cluster",
)

# entity: (monitoredResources key, azureResourceKind, Resource Health). Azure Resource Health rejects Container Apps
# with HTTP 422, so the web app is the one Azure resource that keeps it off with a metric signal group.
APP_BINDINGS = {
    "container-app": ("containerApp", "ContainerApp", "Disabled"),
    "hosted-agent": ("foundryProject", "CognitiveServicesAccount", "Disabled"),
    "mcp-server": ("mcpApp", "ContainerApp", "Disabled"),
    "foundry-account": ("foundryAccount", "CognitiveServicesAccount", "Enabled"),
    "session-storage": ("sessionsBlobService", "StorageAccount", "Disabled"),
}

# entity: (metric signals, query signals)
APP_SIGNALS = {
    "container-app": (
        ["cpu-percentage", "memory-percentage", "response-time"],
        ["failed-requests", "exceptions", "availability-test"],
    ),
    "hosted-agent": ([], ["agent-task-failures", "agent-task-latency"]),
    "mcp-server": (["cpu-percentage", "memory-percentage", "response-time"], ["availability-test"]),
    "foundry-account": (["client-errors", "server-errors", "throttled-requests"], []),
    "session-storage": (["availability", "end-to-end-latency"], []),
    "platform-context": ([], ["service-health", "failed-arm-operations", "platform-alerts"]),
}

# (entity, signal): (degraded rule, unhealthy rule). A missing rule is None.
APP_RULES = {
    ("hosted-agent", "agent-task-failures"): (("GreaterThan", 0), ("GreaterThan", 2)),
    ("hosted-agent", "agent-task-latency"): (("GreaterThan", 450000), ("GreaterThan", 570000)),
    ("foundry-account", "throttled-requests"): (("GreaterThan", 0), ("GreaterThan", 10)),
    ("session-storage", "availability"): (None, ("LessThan", 99)),
    ("session-storage", "end-to-end-latency"): (None, ("GreaterThan", 5000)),
    ("container-app", "availability-test"): (("LessThan", 100), ("LessThan", 67)),
    ("mcp-server", "availability-test"): (("LessThan", 100), ("LessThan", 67)),
}

# (entity, signal): (namespace, metric, aggregation, dimension filter). Names come from
# `az monitor metrics list-definitions` on live resources, not from memory.
APP_METRICS = {
    ("foundry-account", "client-errors"): ("Microsoft.CognitiveServices/accounts", "ClientErrors", "Total", None),
    ("foundry-account", "server-errors"): ("Microsoft.CognitiveServices/accounts", "ServerErrors", "Total", None),
    ("foundry-account", "throttled-requests"): (
        "Microsoft.CognitiveServices/accounts",
        "ModelRequests",
        "Total",
        "StatusCode eq '429'",
    ),
    ("session-storage", "availability"): (
        "Microsoft.Storage/storageAccounts/blobServices",
        "Availability",
        "Average",
        None,
    ),
    ("session-storage", "end-to-end-latency"): (
        "Microsoft.Storage/storageAccounts/blobServices",
        "SuccessE2ELatency",
        "Average",
        None,
    ),
}

# (entity, signal): (timeGrain, refreshInterval) of a metric signal whose grain follows the data. ResponseTime reports
# only for minutes with requests (29 of 55 at PT1M, 11 of 11 at PT5M); the synthetic probe sends some every 5 minutes.
# CPU and memory report every minute, so they take the same grain for one cadence, and changing their definition
# re-arms the signals that froze while the app was deleted and recreated.
APP_METRIC_GRAINS = {
    ("container-app", "cpu-percentage"): ("PT5M", "PT5M"),
    ("container-app", "memory-percentage"): ("PT5M", "PT5M"),
    ("container-app", "response-time"): ("PT5M", "PT5M"),
    ("mcp-server", "cpu-percentage"): ("PT5M", "PT5M"),
    ("mcp-server", "memory-percentage"): ("PT5M", "PT5M"),
    ("mcp-server", "response-time"): ("PT5M", "PT5M"),
}

AGENT_QUERIES = {
    "agent-task-failures": (
        'AppDependencies | where TimeGenerated > ago(15m) | where Name startswith "foundry.agent." '
        "| summarize Value = countif(Success == false)"
    ),
    "agent-task-latency": (
        'AppDependencies | where TimeGenerated > ago(15m) | where Name startswith "foundry.agent." '
        "| summarize Value = percentile(DurationMs, 95) | where not(isnan(Value))"
    ),
}

BUILT_IN_ROLES = {
    "Foundry User": "53ca6127-db72-4b80-b1b0-d745d6d5456d",
    "Foundry Agent Consumer": "eed3b665-ab3a-47b6-8f48-c9382fb1dad6",
    "Foundry Project Manager": "eadc314b-1a2d-4efa-be10-5d325db5065e",
    "AcrPull": "7f951dda-4ed3-4680-a7ca-43fe172d538d",
    "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
    "Cognitive Services OpenAI User": "5e0bd9bd-7b93-4f28-af87-19fc36ad61bd",
    "Monitoring Metrics Publisher": "3913510d-42f4-4e42-8a64-420c390055eb",
    "Reader": "acdd72a7-3385-48ef-bd42-f606fba81ae7",
    "Monitoring Reader": "43d0d8ad-25c7-4714-9337-8ba259a9fe05",
    "Log Analytics Reader": "73c42c96-874c-492b-b04d-ab87d138a893",
}

# A subscription-scope deployment record is keyed by name across the whole subscription and bound to its region, so the
# module carries the deployment's region in its name: two environments in different regions never collide.
SUBSCRIPTION_MODULE = "subscription-monitoring"
SUBSCRIPTION_MODULE_NAME = f"[format('{SUBSCRIPTION_MODULE}-{{0}}', deployment().location)]"

# Microsoft.DefaultV2 as a live account returns it, without the read-only action. The service rejects a custom policy
# with no content filters, and an empty list would carry none.
DEFAULT_V2_CONTENT_FILTERS = (
    {"name": "Hate", "source": "Prompt", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Hate", "source": "Completion", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Sexual", "source": "Prompt", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Sexual", "source": "Completion", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Violence", "source": "Prompt", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Violence", "source": "Completion", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Selfharm", "source": "Prompt", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Selfharm", "source": "Completion", "severityThreshold": "Medium", "blocking": True, "enabled": True},
    {"name": "Jailbreak", "source": "Prompt", "blocking": True, "enabled": True},
    {"name": "Protected Material Text", "source": "Completion", "blocking": True, "enabled": True},
    {"name": "Protected Material Code", "source": "Completion", "blocking": False, "enabled": True},
)

# The exact hosts a hosted-agent session may reach: the account's three hosts, the web app that issues its per-Task
# token, the MCP server that reads Azure for it, and the GitHub tarball host (the agent ships no git, so not github.com).
# ARM, Entra login and Log Analytics are not reachable: the agent holds no Azure token and the MCP server exchanges the
# user's token itself.
EGRESS_HOSTS = (
    "{account}.services.ai.azure.com",
    "{account}.openai.azure.com",
    "{account}.cognitiveservices.azure.com",
    "{web}",
    "{mcp}",
    "codeload.github.com",
)

# The only network resources: one small virtual network, and the private route to the session store. No security
# group, route table, public address or gateway.
NETWORK_RESOURCE_TYPES = {
    "foundation": ["Microsoft.Network/virtualNetworks"],
    "storage": [
        "Microsoft.Network/privateDnsZones",
        "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
        "Microsoft.Network/privateEndpoints",
        "Microsoft.Network/privateEndpoints/privateDnsZoneGroups",
    ],
}

# The ranges a Container Apps environment subnet must not overlap (Microsoft Learn: custom virtual networks).
CONTAINER_APPS_RESERVED_RANGES = (
    "169.254.0.0/16",
    "172.30.0.0/16",
    "172.31.0.0/16",
    "192.0.2.0/24",
    "100.100.0.0/17",
    "100.100.128.0/19",
    "100.100.160.0/19",
    "100.100.192.0/19",
)

VNET_ID = "resourceId('Microsoft.Network/virtualNetworks', format('vnet-{0}', parameters('namePrefix')))"

REMOVED_RESOURCE_TYPES = (
    "Microsoft.DBforPostgreSQL/",
    "Microsoft.ContainerService/",
    "Microsoft.Storage/storageAccounts/queueServices",
    "Microsoft.Storage/storageAccounts/tableServices",
    "Microsoft.Storage/storageAccounts/fileServices",
)

REMOVED_TERMS = re.compile(
    r"survey|shop|postgres|psycopg|queue|agent-web|AGENT_WEB|HEALTH_COPILOT|AZURE_OPENAI|\bAKS\b|aks-cluster",
    re.IGNORECASE,
)


@cache
def compile_main():
    result = subprocess.run(
        [
            "az",
            "bicep",
            "build",
            "--file",
            str(ROOT / "infra" / "main.bicep"),
            "--stdout",
            "--subscription",
            SUBSCRIPTION_ID,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout), result.stderr


def module_name(compiled_name):
    # The per-region deployment name of the subscription-scope module is an expression; tests use its logical name.
    return SUBSCRIPTION_MODULE if compiled_name == SUBSCRIPTION_MODULE_NAME else compiled_name


def deployments():
    compiled, _ = compile_main()
    return {
        module_name(resource["name"]): resource
        for resource in compiled["resources"]
        if resource["type"] == "Microsoft.Resources/deployments"
    }


def templates():
    return {name: module["properties"]["template"] for name, module in deployments().items()}


def module_parameter(module, name):
    return deployments()[module]["properties"]["parameters"][name]["value"]


def main_output(name):
    compiled, _ = compile_main()
    return compiled["outputs"][name]["value"]


def resources(template):
    # A template that imports an extension (Microsoft Graph) is language version 2.0 and keys its resources by symbolic name.
    found = template["resources"]
    return list(found.values()) if isinstance(found, dict) else found


def of_type(template, resource_type):
    return [r for r in resources(template) if r["type"] == resource_type]


def subnet_id(variable):
    return f"[format('{{0}}/subnets/{{1}}', {VNET_ID}, variables('{variable}'))]"


def role_guid(assignment):
    found = re.search(GUID, assignment["properties"]["roleDefinitionId"])
    return found[1] if found else None


def scope_type(assignment):
    scope = assignment.get("scope")
    return re.search(r"resourceId\('([^']+)'", scope)[1] if scope else None


def entity_name(resource):
    # [format('{0}/{1}', parameters('modelName'), 'container-app')] -> container-app
    last = re.fullmatch(r"\[format\('\{0\}/\{1\}', parameters\('modelName'\), (.+)\)\]", resource["name"])[1]
    return APP_ROOT if last == "parameters('modelName')" else last.strip("'")


def app_entities():
    return {
        entity_name(r): r
        for r in of_type(templates()["health-model-entities"], "Microsoft.CloudHealth/healthmodels/entities")
    }


def app_edges():
    names = templates()["health-model-entities"]["outputs"]["entityNames"]["value"]
    names = {key: APP_ROOT if value == "[parameters('modelName')]" else value for key, value in names.items()}
    edges = {}
    for resource in of_type(templates()["health-model-relationships"], "Microsoft.CloudHealth/healthmodels/relationships"):
        name = re.fullmatch(r"\[format\('\{0\}/\{1\}', parameters\('modelName'\), '(.+)'\)\]", resource["name"])[1]
        edges[name] = tuple(
            names[re.fullmatch(r"\[parameters\('entityNames'\)\.(\w+)\]", resource["properties"][side])[1]]
            for side in ("parentEntityName", "childEntityName")
        )
    return edges


def signals(entity):
    groups = entity["properties"]["signalGroups"]
    metric = [s["name"] for s in groups.get("azureResource", {}).get("signals", [])]
    query = [s["name"] for s in groups.get("azureLogAnalytics", {}).get("signals", [])]
    return metric, query


def signal(entity, name):
    groups = entity["properties"]["signalGroups"]
    return next(
        s
        for group in ("azureResource", "azureLogAnalytics")
        for s in groups.get(group, {}).get("signals", [])
        if s["name"] == name
    )


def rule(signal_definition, key):
    found = signal_definition["evaluationRules"].get(key)
    return (found["operator"], found["threshold"]) if found else None


def descendants(edges, start):
    children = {}
    for parent, child in edges.values():
        children.setdefault(parent, set()).add(child)
    seen, pending = set(), [start]
    while pending:
        for child in children.get(pending.pop(), ()):
            if child not in seen:
                seen.add(child)
                pending.append(child)
    return seen


def app_host(app_variable):
    # format('{0}.{1}', variables('webAppName'), reference(<foundation deployment>, '2025-04-01').outputs.environmentDefaultDomain.value)
    return (
        r"format\('\{0\}\.\{1\}', variables\('" + app_variable + r"'\), reference\(extensionResourceId\(.+, 'foundation'\), "
        r"'[\d-]+'\)\.outputs\.environmentDefaultDomain\.value\)"
    )


def egress_host(expression, account, web, mcp):
    # Evaluates the expression shapes foundry.bicep builds a host from; anything else is returned as written.
    apps = {"[parameters('webFqdn')]": web, "[parameters('mcpFqdn')]": mcp}
    own = re.fullmatch(r"\[format\('\{0\}(\.[\w.]+)', parameters\('accountName'\)\)\]", expression)
    return apps.get(expression) or (account + own[1] if own else expression)


def deploy_script_env():
    # (names taken from the azd environment, names the caller may override). An override is a variable the script
    # defaults from itself, NAME="${NAME:-...}"; every other name it reads but never sets comes from azd.
    text = DEPLOY_SCRIPT.read_text().replace("\\\n", " ")
    overrides = set(re.findall(r'^([A-Z][A-Z0-9_]*)="\$\{\1:-', text, re.MULTILINE))
    required = set(re.search(r"for name in ([A-Z0-9_ ]+); do", text)[1].split())
    assigned = set(re.findall(r"^\s*([A-Z][A-Z0-9_]*)=", text, re.MULTILINE))
    referenced = set(re.findall(r"\$\{?([A-Z][A-Z0-9_]*)", text))
    reads = (required | (referenced - assigned)) - {"BASH_SOURCE"}
    return reads - overrides, overrides


def run_script(script, *, path_prefix=None, drop=(), **environment):
    env = {k: v for k, v in os.environ.items() if k not in drop}
    if path_prefix:
        env["PATH"] = f"{path_prefix}:{env['PATH']}"
    return subprocess.run(
        ["bash", script],
        cwd=ROOT,
        env={**env, **environment},
        capture_output=True,
        text=True,
    )


class SourceLayoutContractTests(unittest.TestCase):
    def test_main_compiles_without_diagnostics(self):
        _, stderr = compile_main()

        for line in (
            "main.bicep(1,2) : Warning BCP081: types are missing",
            "main.bicep(1,2) : Warning no-unused-vars: Variable is declared but never used",
            "main.bicep(1,2) : Error BCP035: property is missing",
        ):
            with self.subTest(recognized=line):
                self.assertTrue(BICEP_DIAGNOSTIC.search(line))
        self.assertEqual(BICEP_DIAGNOSTIC.findall(stderr), [], stderr)

    def test_authored_sources_have_one_final_layout(self):
        expected = {
            "azure.yaml",
            "infra/bicepconfig.json",
            "infra/main.bicep",
            "infra/main.parameters.json",
            "infra/README.md",
            "scripts/hooks/postprovision.sh",
            "scripts/hooks/postup.sh",
            "scripts/hooks/predown.sh",
            "scripts/local-env.sh",
            "src/mcp/.dockerignore",
            "src/mcp/Dockerfile",
            "src/agent/Dockerfile",
            "src/agent/deploy/deploy-agent.sh",
            "src/agent/src/instructions.py",
            "src/web/Dockerfile",
            "src/web/requirements.txt",
            "src/web/app/main.py",
            "src/web/ui/package.json",
        }
        removed = (
            "app",
            "copilot",
            "src/survey",
            "src/agent-web",
            "src/agent-app",
            "scripts/demo-failure.sh",
            "scripts/hooks/preprovision.sh",
            "infra/modules/shop-health-model.bicep",
            "infra/modules/queue-private-endpoint.bicep",
            "infra/modules/survey-deployment.bicep",
            "infra/modules/survey-health-entities.bicep",
            "infra/modules/survey-health-model.bicep",
            "infra/modules/survey-platform.bicep",
            "docs/research/survey-results-visualization.md",
        )

        self.assertEqual(sorted(path for path in expected if not (ROOT / path).is_file()), [])
        for path in removed:
            with self.subTest(removed=path):
                self.assertFalse((ROOT / path).exists())
        self.assertEqual(
            sorted(path.name for path in (ROOT / "infra").glob("*.bicep")),
            ["main.bicep"],
        )
        self.assertEqual(
            sorted(path.name for path in (ROOT / "infra" / "modules").glob("*.bicep")),
            [
                "availability-tests.bicep",
                "container-app.bicep",
                "design-health-model.bicep",
                "entra.bicep",
                "foundation.bicep",
                "foundry.bicep",
                "health-model-access.bicep",
                "health-model-discovery.bicep",
                "health-model-entities.bicep",
                "health-model-relationships.bicep",
                "health-model.bicep",
                "rbac.bicep",
                "storage.bicep",
                "subscription-monitoring.bicep",
            ],
        )
        self.assertEqual(
            sorted(
                str(path.relative_to(ROOT))
                for path in (ROOT / "scripts").rglob("*")
                if path.is_file()
            ),
            ["scripts/hooks/postprovision.sh", "scripts/hooks/postup.sh", "scripts/hooks/predown.sh", "scripts/local-env.sh"],
        )

    def test_tests_folder_holds_only_test_modules(self):
        listed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "tests"],
            cwd=ROOT,
            capture_output=True,
            check=True,
        ).stdout.split(b"\0")
        files = sorted(raw.decode() for raw in listed if raw and (ROOT / raw.decode()).is_file())

        self.assertIn("tests/test_infra.py", files)
        self.assertEqual([f for f in files if not re.fullmatch(r"tests/test_\w+\.py", f)], [])

    def test_azure_yaml_declares_the_web_and_mcp_services_and_the_project_hooks(self):
        text = (ROOT / "azure.yaml").read_text()
        services, hooks = text.split("\nservices:\n")[1].split("\nhooks:\n")

        self.assertEqual(re.findall(r"^  ([\w-]+):$", services, re.MULTILINE), ["web", "mcp"])
        self.assertNotIn("hooks:", services)
        self.assertEqual(re.findall(r"^  ([\w-]+):$", hooks, re.MULTILINE), ["postprovision", "postdeploy", "postup", "predown"])
        web, mcp = services.split("\n  mcp:\n")
        for service, block, lines in (
            ("web", web, ("    project: ./src/web", "    language: py")),
            ("mcp", mcp, ("    project: ./src/mcp", "    language: docker")),
        ):
            for line in lines + ("    host: containerapp", "      path: ./Dockerfile", "      remoteBuild: true"):
                with self.subTest(service=service, line=line):
                    self.assertIn(line + "\n", block + "\n")
        for hook, command in (
            ("postprovision", "bash ./scripts/hooks/postprovision.sh"),
            ("postdeploy", "bash ./src/agent/deploy/deploy-agent.sh"),
            ("postup", "bash ./scripts/hooks/postup.sh"),
            ("predown", "bash ./scripts/hooks/predown.sh"),
        ):
            with self.subTest(hook=hook):
                self.assertIn(f"  {hook}:\n    shell: sh\n    interactive: true\n    run: {command}", hooks)

    def test_postup_prints_deployed_website_links(self):
        cases = (
            "web-alpha.example.test",
            "web-beta.example.test",
        )
        for fqdn in cases:
            with self.subTest(fqdn=fqdn):
                result = run_script("./scripts/hooks/postup.sh", SERVICE_WEB_FQDN=fqdn)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    re.findall(r"https://\S+", result.stdout),
                    [f"https://{fqdn}/", f"https://{fqdn}/api/health-model"],
                )
                self.assertEqual(result.stderr, "")

        for value in (None, ""):
            with self.subTest(missing="SERVICE_WEB_FQDN", value=value):
                result = (
                    run_script("./scripts/hooks/postup.sh", drop=("SERVICE_WEB_FQDN",))
                    if value is None
                    else run_script("./scripts/hooks/postup.sh", SERVICE_WEB_FQDN=value)
                )

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("SERVICE_WEB_FQDN", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_local_env_exports_exactly_the_web_app_configuration(self):
        values = {name: f"value-of-{name.lower()}" for name in LOCAL_ENV}
        deployed_store = {**values, "SESSIONS_CONTAINER_URL": "https://stahmtoken.blob.core.windows.net/sessions"}
        # A stand-in azd prints the selected environment as JSON, or fails when none is selected.
        stub = '#!/usr/bin/env bash\n[[ -n "${AZD_VALUES:-}" ]] || exit 1\nprintf \'%s\' "$AZD_VALUES"\n'
        cases = [("complete", values, None), ("deployed session store url", deployed_store, None)]
        cases += [(f"missing {name}", {k: v for k, v in values.items() if k != name}, name) for name in LOCAL_ENV]
        cases += [(f"empty {name}", {**values, name: ""}, name) for name in LOCAL_ENV]
        with tempfile.TemporaryDirectory() as directory:
            azd = Path(directory) / "azd"
            azd.write_text(stub)
            azd.chmod(0o755)
            for name, azd_values, missing in cases:
                with self.subTest(case=name):
                    result = run_script(
                        "./scripts/local-env.sh",
                        path_prefix=directory,
                        AZD_VALUES=json.dumps(azd_values),
                    )

                    if missing is None:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(
                            result.stdout.splitlines(),
                            [f"export {key}=value-of-{key.lower()}" for key in LOCAL_ENV]
                            + [f"export SESSIONS_CONTAINER_URL={LOCAL_SESSIONS_URL}", f"export AUTH_MODE={LOCAL_AUTH_MODE}"],
                        )
                        self.assertEqual(result.stderr, "")
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(result.stdout, "")
                        self.assertIn(f"does not define: {missing}\n", result.stderr)

            with self.subTest(case="no azd environment"):
                result = run_script("./scripts/local-env.sh", path_prefix=directory, AZD_VALUES="")

                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("no azd environment selected", result.stderr)

    def test_makefile_runs_only_the_web_app(self):
        text = (ROOT / "Makefile").read_text()
        help_text = subprocess.run(["make", "help"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        dev = subprocess.run(["make", "-n", "dev"], cwd=ROOT, capture_output=True, text=True, check=True).stdout

        for term in ("agent-web", "agent-app", "AGENT_", "survey", "HEALTH_COPILOT", "AZURE_OPENAI"):
            with self.subTest(absent=term):
                self.assertNotIn(term, text)
        for target in ("make dev", "make ui", "make env"):
            with self.subTest(help=target):
                self.assertIn(target, help_text)
        self.assertEqual(dev.count("uvicorn"), 1)
        self.assertIn("--app-dir src/web/app", dev)
        self.assertEqual(re.findall(r"^\.PHONY: (.+)$", text, re.MULTILINE), ["help env deps ui dev gate"])

    def test_deployment_sources_mention_no_removed_feature(self):
        paths = [
            path
            for base in ("infra", "scripts")
            for path in (ROOT / base).rglob("*")
            if path.is_file() and path.suffix in {".bicep", ".json", ".sh", ".md"}
        ] + [ROOT / "azure.yaml", ROOT / "Makefile"]

        leaked = {
            str(path.relative_to(ROOT)): sorted(set(REMOVED_TERMS.findall(path.read_text())))
            for path in paths
            if REMOVED_TERMS.search(path.read_text())
        }

        self.assertEqual(leaked, {})


class InfrastructureContractTests(unittest.TestCase):
    def test_deployment_is_the_web_app_and_the_mcp_server_in_one_region(self):
        compiled, _ = compile_main()
        parameters = compiled["parameters"]
        offenders = sorted(
            {
                resource["type"]
                for template in templates().values()
                for resource in resources(template)
                if resource["type"].startswith(REMOVED_RESOURCE_TYPES)
            }
        )
        network = {
            name: sorted(r["type"] for r in resources(template) if r["type"].startswith("Microsoft.Network/"))
            for name, template in templates().items()
        }

        self.assertEqual(
            sorted(deployments()),
            sorted(
                [
                    "foundation",
                    "storage",
                    "subscription-monitoring",
                    "foundry",
                    "entra",
                    "rbac",
                    "container-app-web",
                    "container-app-mcp",
                    "availability-tests",
                    "health-model",
                    "health-model-access",
                    "health-model-entities",
                    "health-model-relationships",
                    "health-model-discovery",
                    "design-health-model",
                ]
            ),
        )
        self.assertEqual(
            sorted(parameters),
            sorted(
                [
                    "environmentName",
                    "location",
                    "principalId",
                    "healthModelLocation",
                    "modelDeploymentCapacity",
                    "webImage",
                    "mcpImage",
                    "entraAllowAzureCli",
                    "entraAllowLocalRedirect",
                    "entraAllowedTenants",
                    "foundryAgentPrincipalId",
                ]
            ),
        )
        self.assertEqual(parameters["healthModelLocation"]["defaultValue"], "[parameters('location')]")
        for module, parameter, expected in (
            ("foundation", "location", "[parameters('location')]"),
            ("storage", "location", "[parameters('location')]"),
            ("foundry", "location", "[parameters('location')]"),
            ("container-app-web", "location", "[parameters('location')]"),
            ("container-app-mcp", "location", "[parameters('location')]"),
            ("availability-tests", "location", "[parameters('location')]"),
            ("health-model", "healthModelLocation", "[parameters('healthModelLocation')]"),
            ("design-health-model", "healthModelLocation", "[parameters('healthModelLocation')]"),
        ):
            with self.subTest(module=module):
                self.assertEqual(module_parameter(module, parameter), expected)
        self.assertEqual(offenders, [])
        self.assertEqual(
            {name: types for name, types in network.items() if types},
            NETWORK_RESOURCE_TYPES,
        )
        # The web app and the MCP server are the only Container Apps, both from the one container-app module.
        self.assertEqual(
            {name: len(of_type(t, "Microsoft.App/containerApps")) for name, t in templates().items() if name.startswith("container-app-")},
            {"container-app-web": 1, "container-app-mcp": 1},
        )
        self.assertEqual(
            sum(len(of_type(t, "Microsoft.App/containerApps")) for t in templates().values()),
            2,
        )
        environments = of_type(templates()["foundation"], "Microsoft.App/managedEnvironments")
        # Workload profiles with only the Consumption profile is what the service creates by default; the template says so.
        self.assertEqual(
            [e["properties"]["workloadProfiles"] for e in environments],
            [[{"name": "Consumption", "workloadProfileType": "Consumption"}]],
        )

    def test_subscription_scope_modules_are_named_per_region(self):
        compiled, _ = compile_main()
        modules = [r for r in compiled["resources"] if r["type"] == "Microsoft.Resources/deployments"]
        subscription_scope = [r for r in modules if "resourceGroup" not in r]

        # A module deployed at subscription scope is the only kind whose record can collide with another environment's.
        self.assertEqual([r["name"] for r in subscription_scope], [SUBSCRIPTION_MODULE_NAME])
        self.assertEqual([r["location"] for r in subscription_scope], ["[deployment().location]"])
        for module in modules:
            if module not in subscription_scope:
                with self.subTest(module=module["name"]):
                    # Records in the environment's own resource group cannot collide with another environment's.
                    self.assertEqual(module["resourceGroup"], "[format('rg-{0}', parameters('environmentName'))]")

    def test_parameter_file_maps_every_azd_input(self):
        compiled, _ = compile_main()
        declared = json.loads((ROOT / "infra" / "main.parameters.json").read_text())["parameters"]
        parameters = compiled["parameters"]

        self.assertEqual(
            sorted(declared),
            [
                "entraAllowAzureCli",
                "entraAllowLocalRedirect",
                "entraAllowedTenants",
                "environmentName",
                "foundryAgentPrincipalId",
                "location",
                "mcpImage",
                "modelDeploymentCapacity",
                "principalId",
                "webImage",
            ],
        )
        self.assertEqual(sorted(set(declared) - set(parameters)), [])
        self.assertEqual(sorted(set(parameters) - set(declared)), ["healthModelLocation"])
        for name, value in (
            ("environmentName", "${AZURE_ENV_NAME}"),
            ("location", "${AZURE_LOCATION}"),
            ("principalId", "${AZURE_PRINCIPAL_ID}"),
            ("modelDeploymentCapacity", "${AZURE_MODEL_CAPACITY:-500}"),
            ("webImage", "${SERVICE_WEB_IMAGE_NAME}"),
            ("mcpImage", "${SERVICE_MCP_IMAGE_NAME}"),
            ("entraAllowAzureCli", "${ENTRA_ALLOW_AZURE_CLI:-false}"),
            ("entraAllowLocalRedirect", "${ENTRA_ALLOW_LOCAL_REDIRECT:-false}"),
            # Empty lets every directory sign in.
            ("entraAllowedTenants", "${ENTRA_ALLOWED_TENANTS}"),
            # Set by the agent deploy script with `azd env set`; empty until the agent exists.
            ("foundryAgentPrincipalId", "${FOUNDRY_AGENT_PRINCIPAL_ID}"),
        ):
            with self.subTest(parameter=name):
                self.assertEqual(declared[name]["value"], value)
        for name, default in (
            ("modelDeploymentCapacity", 500),
            ("mcpImage", ""),
            ("foundryAgentPrincipalId", ""),
            ("entraAllowAzureCli", False),
            ("entraAllowLocalRedirect", False),
            ("entraAllowedTenants", ""),
        ):
            with self.subTest(default=name):
                self.assertEqual(parameters[name]["defaultValue"], default)
        # The catalog is whatever the signed-in user can read: there is no scope to choose.
        self.assertNotIn("healthModelCatalogScope", parameters)

    def test_foundry_platform_keeps_agents_read_only_and_egress_closed(self):
        compiled, _ = compile_main()
        foundry = templates()["foundry"]
        foundry_resources = {resource["type"]: resource for resource in foundry["resources"]}
        egress = foundry_resources["Microsoft.CognitiveServices/accounts/raiPolicies"]["properties"]["egressPolicy"]
        outputs = (
            "FOUNDRY_ACCOUNT_NAME",
            "FOUNDRY_PROJECT_NAME",
            "FOUNDRY_PROJECT_ENDPOINT",
            "FOUNDRY_MODEL_DEPLOYMENT_NAME",
            "FOUNDRY_AGENT_EGRESS_POLICY_ID",
            "FOUNDRY_AGENT_NAME",
            "HEALTH_MODEL_DESIGN_NAME",
            "SESSIONS_CONTAINER_URL",
        )
        removed_outputs = [
            name
            for name in compiled["outputs"]
            if re.match(r"AZURE_(OPENAI|POSTGRES|QUEUE)|SERVICE_(AGENT|SURVEY)|SHOP_|SURVEY_|HEALTH_MODEL_(READER_ROLE_ID|CATALOG_SCOPE)", name)
        ]

        cases = (
            ("account kind", foundry_resources["Microsoft.CognitiveServices/accounts"]["kind"], "AIServices"),
            ("local auth", foundry_resources["Microsoft.CognitiveServices/accounts"]["properties"]["disableLocalAuth"], True),
            ("egress enforced", (egress["mode"], egress["defaultAction"]), ("Enforced", "Deny")),
            ("model capacity", foundry["parameters"]["modelDeploymentCapacity"]["defaultValue"], 500),
            # A retired model version must not stop the deployment: the service moves it to the current default.
            (
                "model upgrade",
                of_type(foundry, "Microsoft.CognitiveServices/accounts/deployments")[0]["properties"]["versionUpgradeOption"],
                "OnceCurrentVersionExpired",
            ),
            ("outputs", [name for name in outputs if name not in compiled["outputs"]], []),
            ("removed outputs", removed_outputs, []),
        )
        for name, actual, expected in cases:
            with self.subTest(case=name):
                self.assertEqual(actual, expected)

    def test_agent_egress_allows_only_exact_hosts(self):
        compiled, _ = compile_main()
        foundry = templates()["foundry"]
        policy = of_type(foundry, "Microsoft.CognitiveServices/accounts/raiPolicies")[0]["properties"]
        expressions = foundry["variables"]["egressAllowedHosts"]
        account, web, mcp = "aif-demo-token", "web.example.test", "mcp.example.test"
        hosts = [egress_host(expression, account, web, mcp) for expression in expressions]

        # No wildcard: one would also match other tenants' hosts, such as Application Insights ingestion.
        for expression, host in zip(expressions, hosts):
            with self.subTest(host=host):
                self.assertNotIn("*", expression)
                self.assertRegex(host, r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
        self.assertEqual(sorted(hosts), sorted(host.format(account=account, web=web, mcp=mcp) for host in EGRESS_HOSTS))
        self.assertEqual(len(set(hosts)), len(hosts))
        # This account's hosts follow its name, so another tenant's account never matches.
        self.assertEqual(
            [expression for expression in expressions if "parameters('accountName')" in expression],
            [
                "[format('{0}.services.ai.azure.com', parameters('accountName'))]",
                "[format('{0}.openai.azure.com', parameters('accountName'))]",
                "[format('{0}.cognitiveservices.azure.com', parameters('accountName'))]",
            ],
        )
        # The two app hosts are the apps' own names on the environment's default domain, known before the apps exist.
        for module_input, app in (("webFqdn", "webAppName"), ("mcpFqdn", "mcpAppName")):
            with self.subTest(app_host=module_input):
                self.assertRegex(module_parameter("foundry", module_input), r"\[" + app_host(app) + r"\]")
        # One Allow rule per listed host, and everything else is denied.
        rules = policy["egressPolicy"]["copy"]
        self.assertEqual([rule["name"] for rule in rules], ["rules"])
        self.assertEqual(rules[0]["count"], "[length(variables('egressAllowedHosts'))]")
        self.assertEqual(
            (rules[0]["input"]["ruleType"], rules[0]["input"]["action"]["actionType"]),
            ("Fqdn", "Allow"),
        )
        self.assertEqual(
            rules[0]["input"]["match"]["host"],
            "[variables('egressAllowedHosts')[copyIndex('rules')]]",
        )
        self.assertEqual(
            (policy["egressPolicy"]["mode"], policy["egressPolicy"]["defaultAction"]),
            ("Enforced", "Deny"),
        )

    def test_agent_policy_keeps_the_default_content_filters(self):
        foundry = templates()["foundry"]
        policy = of_type(foundry, "Microsoft.CognitiveServices/accounts/raiPolicies")[0]["properties"]
        filters = foundry["variables"]["contentFilters"]

        self.assertEqual((policy["basePolicyName"], policy["mode"]), ("Microsoft.DefaultV2", "Blocking"))
        self.assertEqual(policy["contentFilters"], "[variables('contentFilters')]")
        self.assertEqual(filters, list(DEFAULT_V2_CONTENT_FILTERS))
        for expected in DEFAULT_V2_CONTENT_FILTERS:
            with self.subTest(content_filter=f"{expected['name']} on {expected['source']}"):
                self.assertIn(expected, filters)
        self.assertEqual(len({(f["name"], f["source"]) for f in filters}), len(filters))

    def test_image_based_hosted_agent_prerequisites(self):
        by_role = {
            role_guid(a): a
            for a in of_type(templates()["foundry"], "Microsoft.Authorization/roleAssignments")
        }
        registry = of_type(templates()["foundation"], "Microsoft.ContainerRegistry/registries")[0]

        # role: (scope type, principal expression, principal type)
        expected = {
            "Foundry User": ("Microsoft.CognitiveServices/accounts", "accounts/projects", "ServicePrincipal"),
            "Foundry Agent Consumer": (
                "Microsoft.CognitiveServices/accounts/projects",
                "[parameters('identityPrincipalId')]",
                "ServicePrincipal",
            ),
            "Foundry Project Manager": (
                "Microsoft.CognitiveServices/accounts/projects",
                "[parameters('deployerPrincipalId')]",
                "User",
            ),
            "AcrPull": ("Microsoft.ContainerRegistry/registries", "accounts/projects", "ServicePrincipal"),
        }
        self.assertEqual(sorted(by_role), sorted(BUILT_IN_ROLES[role] for role in expected))
        self.assertNotIn(BUILT_IN_ROLES["Cognitive Services OpenAI User"], by_role)
        for role, (scope, principal, principal_type) in expected.items():
            with self.subTest(role=role):
                assignment = by_role[BUILT_IN_ROLES[role]]

                self.assertEqual(scope_type(assignment), scope)
                self.assertIn(principal, assignment["properties"]["principalId"])
                self.assertEqual(assignment["properties"]["principalType"], principal_type)
        self.assertEqual(
            (
                registry["sku"]["name"],
                registry["properties"]["policies"]["azureADAuthenticationAsArmPolicy"]["status"],
                registry["properties"]["roleAssignmentMode"],
                registry["properties"]["adminUserEnabled"],
            ),
            ("Basic", "enabled", "LegacyRegistryPermissions", False),
        )

    def test_web_identity_keeps_only_its_workload_grants(self):
        compiled, _ = compile_main()
        assignments = of_type(templates()["rbac"], "Microsoft.Authorization/roleAssignments")

        # Health models are read, reported on and changed as the signed-in user, so the workload identity holds no
        # health model role and the deployment defines no custom role. The MCP server's own identity is separate.
        self.assertEqual(
            sorted(
                (scope_type(a), role_guid(a))
                for a in assignments
                if a["properties"]["principalId"] == "[parameters('identityPrincipalId')]"
            ),
            sorted(
                [
                    ("Microsoft.ContainerRegistry/registries", BUILT_IN_ROLES["AcrPull"]),
                    ("Microsoft.Storage/storageAccounts/blobServices/containers", BUILT_IN_ROLES["Storage Blob Data Contributor"]),
                    ("Microsoft.Insights/components", BUILT_IN_ROLES["Monitoring Metrics Publisher"]),
                ]
            ),
        )
        self.assertEqual(len(assignments), 4)
        self.assertEqual(of_type(templates()["health-model"], "Microsoft.Authorization/roleAssignments"), [])
        self.assertEqual(
            sorted(r["type"] for r in resources(templates()["subscription-monitoring"])),
            ["Microsoft.Insights/diagnosticSettings"],
        )
        for name, template in templates().items():
            with self.subTest(module=name):
                self.assertEqual(of_type(template, "Microsoft.Authorization/roleDefinitions"), [])
        for name in ("healthModelCatalogScope",):
            with self.subTest(removed=name):
                self.assertNotIn(name, compiled["parameters"])
        for module, name in (
            ("rbac", "modelReaderRoleDefinitionId"),
            ("rbac", "modelWriterRoleDefinitionId"),
            ("health-model", "healthReportRoleDefinitionId"),
            ("health-model", "appIdentityPrincipalId"),
            ("subscription-monitoring", "identityPrincipalId"),
            ("subscription-monitoring", "healthModelCatalogScope"),
        ):
            with self.subTest(removed=f"{module}.{name}"):
                self.assertNotIn(name, deployments()[module]["properties"]["parameters"])
        # The agent identity has no Azure roles, so nothing here grants one.
        self.assertEqual(
            [name for name, o in compiled["outputs"].items() if "ROLE" in name],
            [],
        )

    def test_web_app_environment_matches_the_one_service(self):
        compiled, _ = compile_main()
        env = {item["name"]: item["value"] for item in module_parameter("container-app-web", "env")}

        self.assertEqual(list(env), list(WEB_ENV))
        self.assertEqual(compiled["variables"]["foundryAgentName"], "health-model-agent")
        self.assertEqual(env["FOUNDRY_AGENT_NAME"], "[variables('foundryAgentName')]")
        self.assertEqual(compiled["outputs"]["FOUNDRY_AGENT_NAME"]["value"], "[variables('foundryAgentName')]")
        self.assertEqual(env["HEALTH_MODEL_NAME"], "[variables('healthModelName')]")
        self.assertEqual(env["HEALTH_MODEL_DESIGN_NAME"], "[variables('designHealthModelName')]")
        self.assertEqual(compiled["variables"]["designHealthModelName"], "[format('hm-{0}-design', variables('namePrefix'))]")
        for name, source in (
            ("SESSIONS_CONTAINER_URL", "rbac"),
            ("FOUNDRY_PROJECT_ENDPOINT", "foundry"),
            ("ENTRA_TENANT_ID", "entra"),
            ("ENTRA_CLIENT_ID", "entra"),
            ("ENTRA_API_SCOPE", "entra"),
            ("MCP_SCOPE", "entra"),
        ):
            with self.subTest(env=name):
                self.assertIn(f"'Microsoft.Resources/deployments', '{source}'", env[name])
        self.assertRegex(env["MCP_URL"], r"\[format\('https://\{0\}/', " + app_host("mcpAppName") + r"\)\]")
        self.assertEqual(env["FOUNDRY_AGENT_PRINCIPAL_ID"], "[parameters('foundryAgentPrincipalId')]")
        self.assertEqual(env["ENTRA_ALLOWED_TENANTS"], "[parameters('entraAllowedTenants')]")
        self.assertEqual(module_parameter("container-app-web", "targetPort"), 8080)
        self.assertIs(module_parameter("container-app-web", "external"), True)

    def test_container_apps_environment_joins_one_small_virtual_network(self):
        foundation = templates()["foundation"]
        vnets = of_type(foundation, "Microsoft.Network/virtualNetworks")
        environments = of_type(foundation, "Microsoft.App/managedEnvironments")
        self.assertEqual((len(vnets), len(environments)), (1, 1))
        vnet, environment = vnets[0], environments[0]
        subnets = {
            foundation["variables"][re.fullmatch(r"\[variables\('(\w+)'\)\]", subnet["name"])[1]]: subnet["properties"]
            for subnet in vnet["properties"]["subnets"]
        }
        self.assertEqual(sorted(subnets), ["snet-container-apps", "snet-private-endpoints"])
        space = [ipaddress.ip_network(prefix) for prefix in vnet["properties"]["addressSpace"]["addressPrefixes"]]
        networks = {name: ipaddress.ip_network(properties["addressPrefix"]) for name, properties in subnets.items()}
        infrastructure, endpoints = networks["snet-container-apps"], networks["snet-private-endpoints"]
        reserved = [ipaddress.ip_network(prefix) for prefix in CONTAINER_APPS_RESERVED_RANGES]
        subnet_settings = {key for properties in subnets.values() for key in properties}

        cases = (
            ("one address block", len(space), 1),
            ("the block holds both subnets", [n.subnet_of(space[0]) for n in networks.values()], [True, True]),
            ("subnets do not overlap", infrastructure.overlaps(endpoints), False),
            # A workload profiles environment needs at least a /27, and its size cannot change after creation.
            ("environment subnet is at least a /27", infrastructure.prefixlen <= 27, True),
            ("whole network is no larger than a /24", space[0].prefixlen >= 24, True),
            ("environment subnet avoids the reserved ranges", [str(r) for r in reserved if infrastructure.overlaps(r)], []),
            (
                "environment subnet is delegated to the environment",
                subnets["snet-container-apps"]["delegations"],
                [{"name": "container-apps", "properties": {"serviceName": "Microsoft.App/environments"}}],
            ),
            (
                "endpoint subnet allows private endpoints",
                subnets["snet-private-endpoints"]["privateEndpointNetworkPolicies"],
                "Disabled",
            ),
            ("endpoint subnet is not delegated", "delegations" in subnets["snet-private-endpoints"], False),
            (
                "subnets carry no security group, route table or service endpoint",
                sorted(subnet_settings - {"addressPrefix", "delegations", "privateEndpointNetworkPolicies"}),
                [],
            ),
            (
                "environment joins its subnet and stays publicly reachable",
                environment["properties"]["vnetConfiguration"],
                {"infrastructureSubnetId": subnet_id("infrastructureSubnetName"), "internal": False},
            ),
            ("environment is created after the network", f"[{VNET_ID}]" in environment["dependsOn"], True),
            ("network id output", foundation["outputs"]["vnetId"]["value"], f"[{VNET_ID}]"),
            (
                "endpoint subnet id output",
                foundation["outputs"]["privateEndpointSubnetId"]["value"],
                subnet_id("privateEndpointSubnetName"),
            ),
        )
        for name, actual, expected in cases:
            with self.subTest(case=name):
                self.assertEqual(actual, expected)

    def test_session_store_is_reached_only_through_a_private_endpoint(self):
        storage = templates()["storage"]
        account = of_type(storage, "Microsoft.Storage/storageAccounts")[0]
        endpoints = of_type(storage, "Microsoft.Network/privateEndpoints")
        zones = of_type(storage, "Microsoft.Network/privateDnsZones")
        links = of_type(storage, "Microsoft.Network/privateDnsZones/virtualNetworkLinks")
        groups = of_type(storage, "Microsoft.Network/privateEndpoints/privateDnsZoneGroups")
        for name, found in (("endpoint", endpoints), ("zone", zones), ("link", links), ("zone group", groups)):
            self.assertEqual(len(found), 1, name)
        endpoint, zone, link, group = endpoints[0], zones[0], links[0], groups[0]
        connections = endpoint["properties"]["privateLinkServiceConnections"]
        account_id = f"[resourceId('Microsoft.Storage/storageAccounts', {account['name'][1:-1]})]"
        zone_id = f"[resourceId('Microsoft.Network/privateDnsZones', {zone['name'][1:-1]})]"

        cases = (
            ("public network access is off", account["properties"]["publicNetworkAccess"], "Disabled"),
            ("firewall denies by default", account["properties"]["networkAcls"]["defaultAction"], "Deny"),
            (
                "endpoint is created in the endpoint subnet",
                endpoint["properties"]["subnet"]["id"],
                "[parameters('privateEndpointSubnetId')]",
            ),
            ("endpoint reaches blob only", [c["properties"]["groupIds"] for c in connections], [["blob"]]),
            ("endpoint targets the session account", [c["properties"]["privateLinkServiceId"] for c in connections], [account_id]),
            (
                "zone is the blob private link zone",
                zone["name"],
                "[format('privatelink.blob.{0}', environment().suffixes.storage)]",
            ),
            (
                "zone is linked to the environment network without registration",
                (link["properties"]["registrationEnabled"], link["properties"]["virtualNetwork"]["id"]),
                (False, "[parameters('vnetId')]"),
            ),
            (
                "zone group fills the zone from the endpoint",
                [c["properties"]["privateDnsZoneId"] for c in group["properties"]["privateDnsZoneConfigs"]],
                [zone_id],
            ),
            (
                "zone group belongs to the endpoint",
                group["name"],
                f"[format('{{0}}/{{1}}', {endpoint['name'][1:-1]}, 'default')]",
            ),
        )
        for name, actual, expected in cases:
            with self.subTest(case=name):
                self.assertEqual(actual, expected)
        for name in ("vnetId", "privateEndpointSubnetId"):
            with self.subTest(input=name):
                value = module_parameter("storage", name)

                self.assertIn("'Microsoft.Resources/deployments', 'foundation'", value)
                self.assertIn(f"outputs.{name}.value", value)

    def test_session_store_is_a_private_entra_only_blob_container(self):
        storage = templates()["storage"]
        account = of_type(storage, "Microsoft.Storage/storageAccounts")[0]["properties"]
        blob_service = of_type(storage, "Microsoft.Storage/storageAccounts/blobServices")[0]["properties"]
        containers = of_type(storage, "Microsoft.Storage/storageAccounts/blobServices/containers")
        diagnostics = of_type(storage, "Microsoft.Insights/diagnosticSettings")
        rbac = templates()["rbac"]
        contributors = [
            a
            for a in of_type(rbac, "Microsoft.Authorization/roleAssignments")
            if role_guid(a) == BUILT_IN_ROLES["Storage Blob Data Contributor"]
        ]

        for name, expected in (
            ("allowSharedKeyAccess", False),
            ("allowBlobPublicAccess", False),
            ("defaultToOAuthAuthentication", True),
            ("minimumTlsVersion", "TLS1_2"),
            ("supportsHttpsTrafficOnly", True),
            ("publicNetworkAccess", "Disabled"),
        ):
            with self.subTest(account=name):
                self.assertEqual(account[name], expected)
        # A deleted or overwritten blob and a deleted container can be restored for a week.
        for policy in ("deleteRetentionPolicy", "containerDeleteRetentionPolicy"):
            with self.subTest(soft_delete=policy):
                self.assertEqual(blob_service[policy], {"enabled": True, "days": 7})
        self.assertEqual(
            sorted(r["type"] for r in storage["resources"]),
            [
                "Microsoft.Insights/diagnosticSettings",
                *NETWORK_RESOURCE_TYPES["storage"],
                "Microsoft.Storage/storageAccounts",
                "Microsoft.Storage/storageAccounts/blobServices",
                "Microsoft.Storage/storageAccounts/blobServices/containers",
            ],
        )
        self.assertEqual(storage["variables"]["containerName"], "sessions")
        self.assertEqual(len(containers), 1)
        self.assertIn("variables('containerName')", containers[0]["name"])
        self.assertEqual(containers[0]["properties"]["publicAccess"], "None")
        self.assertEqual(len(diagnostics), 1)
        self.assertIn("blobServices", diagnostics[0]["scope"])
        self.assertEqual(
            (diagnostics[0]["properties"]["logs"][0]["enabled"], diagnostics[0]["properties"]["metrics"][0]["enabled"]),
            (True, True),
        )
        self.assertEqual([scope_type(a) for a in contributors], ["Microsoft.Storage/storageAccounts/blobServices/containers"])
        self.assertEqual(contributors[0]["properties"]["principalId"], "[parameters('identityPrincipalId')]")
        self.assertEqual(
            rbac["outputs"]["sessionsContainerUrl"]["value"],
            "[format('https://{0}.blob.{1}/{2}', parameters('storageName'), environment().suffixes.storage, parameters('sessionsContainerName'))]",
        )
        self.assertIn("'Microsoft.Resources/deployments', 'rbac'", main_output("SESSIONS_CONTAINER_URL"))

    def test_every_health_model_resource_uses_one_api_version(self):
        versions = {
            resource["apiVersion"]
            for template in templates().values()
            for resource in resources(template)
            if resource["type"].startswith("Microsoft.CloudHealth/")
        }

        self.assertEqual(versions, {"2026-05-01-preview"})

    def test_design_model_starts_empty_with_its_own_identity_and_read_grants(self):
        design = templates()["design-health-model"]
        access = of_type(design, "Microsoft.Resources/deployments")

        self.assertEqual(
            sorted(r["type"] for r in design["resources"]),
            [
                "Microsoft.CloudHealth/healthmodels",
                "Microsoft.CloudHealth/healthmodels/authenticationsettings",
                "Microsoft.Resources/deployments",
            ],
        )
        self.assertEqual(of_type(design, "Microsoft.CloudHealth/healthmodels")[0]["identity"], {"type": "SystemAssigned"})
        self.assertEqual([m["properties"]["parameters"]["monitoredResources"]["value"] for m in access], [{}])

    def test_design_model_authenticates_as_auth_system_and_reads_the_group(self):
        design = templates()["design-health-model"]
        setting = of_type(design, "Microsoft.CloudHealth/healthmodels/authenticationsettings")[0]
        access_modules = of_type(design, "Microsoft.Resources/deployments")
        self.assertEqual(len(access_modules), 1)
        access = access_modules[0]
        grants = of_type(access["properties"]["template"], "Microsoft.Authorization/roleAssignments")

        # The agent instructions send a model without entities to `auth-system`, and the app model uses it too.
        self.assertEqual(setting["name"], "[format('{0}/{1}', parameters('modelName'), 'auth-system')]")
        self.assertEqual(
            (setting["properties"]["authenticationKind"], setting["properties"]["managedIdentityName"]),
            ("ManagedIdentity", "SystemAssigned"),
        )
        self.assertEqual(templates()["health-model"]["variables"]["authenticationName"], "auth-system")
        self.assertIn("`auth-system`", (AGENT_DIR / "src" / "instructions.py").read_text())
        # The model's own identity reads the resource group, so signals applied later evaluate.
        self.assertEqual(
            access["properties"]["parameters"]["modelPrincipalId"]["value"],
            "[reference(resourceId('Microsoft.CloudHealth/healthmodels', parameters('modelName')), "
            "'2026-05-01-preview', 'full').identity.principalId]",
        )
        self.assertEqual(
            sorted(role_guid(g) for g in grants),
            sorted([BUILT_IN_ROLES["Reader"], BUILT_IN_ROLES["Monitoring Reader"]]),
        )
        for grant in grants:
            with self.subTest(role=role_guid(grant)):
                self.assertNotIn("scope", grant)
                self.assertEqual(grant["properties"]["principalId"], "[parameters('modelPrincipalId')]")
                self.assertEqual(grant["properties"]["principalType"], "ServicePrincipal")


class AgentDeploymentContractTests(unittest.TestCase):
    def test_agent_is_deployed_by_one_project_level_postdeploy_hook(self):
        text = (ROOT / "azure.yaml").read_text()
        hooks = text.split("\nhooks:\n")[1]
        syntax = subprocess.run(["bash", "-n", str(DEPLOY_SCRIPT)], capture_output=True, text=True)

        self.assertEqual(text.count("deploy-agent.sh"), 1)
        self.assertIn(
            "  postdeploy:\n    shell: sh\n    interactive: true\n    run: bash ./src/agent/deploy/deploy-agent.sh",
            hooks,
        )
        # Service-level hooks would run once per service; the project-level one runs once after every service.
        self.assertNotIn("    hooks:", text)
        self.assertTrue(DEPLOY_SCRIPT.is_file())
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_mcp_image_builds_azmcp_from_a_pinned_source_and_runs_it_remote_and_read_only(self):
        dockerfile = (MCP_DIR / "Dockerfile").read_text()
        args = dict(re.findall(r"^ARG (AZMCP_(?:REPO|REF))=(\S+)$", dockerfile, re.MULTILINE))
        azmcp_stage = dockerfile.split(" AS azmcp\n")[1].split("\nFROM ")[0]
        runtime = dockerfile.split("\nFROM ")[-1]
        sdk = re.findall(r"^ARG AZMCP_SDK=(\S+)$", dockerfile, re.MULTILINE)
        entrypoint = json.loads(re.search(r"^ENTRYPOINT (\[.*?\])$", dockerfile.replace("\\\n", " "), re.MULTILINE)[1])

        self.assertEqual(args, AZMCP_BUILD_ARGS)
        # A full commit id, not a branch name, and the branch it comes from is named next to it.
        self.assertRegex(args["AZMCP_REF"], r"^[0-9a-f]{40}$")
        self.assertRegex(dockerfile, r"\n# [^\n]*abossard/healthmodels-inspect[^\n]*\n(?:#[^\n]*\n)*ARG AZMCP_REF=")
        self.assertIn('"$AZMCP_REPO" "$AZMCP_REF"', azmcp_stage)
        # The SDK image is an exact tag (the floating sdk:10.0 broke the build), declared before the first FROM so the
        # FROM can use it, and kept in step with the sdk.version of the global.json at AZMCP_REF.
        for check, found, expected in (
            ("declared once", len(sdk), 1),
            ("exact version", bool(re.fullmatch(r"\d+\.\d+\.\d+", sdk[0])) if sdk else None, True),
            ("before the first FROM", dockerfile.index("ARG AZMCP_SDK=") < dockerfile.index("\nFROM "), True),
            ("builds the azmcp stage", "FROM mcr.microsoft.com/dotnet/sdk:${AZMCP_SDK} AS azmcp\n" in dockerfile, True),
            ("self-contained linux-x64 build", "--runtime linux-x64 --self-contained" in azmcp_stage, True),
            ("native dependencies only", runtime.startswith("mcr.microsoft.com/dotnet/runtime-deps:10.0-"), True),
            ("no ICU, so invariant globalization", "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1" in runtime, True),
            ("listens where the ingress sends", "ASPNETCORE_URLS=http://+:8080" in runtime, True),
            ("non-root", re.search(r"^USER (\d+)$", runtime, re.MULTILINE) is not None, True),
            ("binary from the build stage", "COPY --from=azmcp /out /opt/azmcp" in runtime, True),
        ):
            with self.subTest(mcp_image=check):
                self.assertEqual(found, expected)
        # Remote HTTP, the caller's token exchanged on behalf of the caller, read-only, and only the two namespaces.
        self.assertEqual(entrypoint, ["/opt/azmcp/azmcp", *MCP_SERVER_FLAGS])
        self.assertNotIn("--dangerously-disable-http-incoming-auth", entrypoint)
        self.assertEqual(entrypoint.count("--read-only"), 1)
        self.assertEqual([entrypoint[i + 1] for i, flag in enumerate(entrypoint) if flag == "--namespace"], ["monitor", "group"])
        self.assertEqual((MCP_DIR / ".dockerignore").read_text().split(), ["*"])

    def test_agent_deploy_script_reads_only_values_main_bicep_outputs(self):
        compiled, _ = compile_main()
        azd_reads, overrides = deploy_script_env()

        for name in DEPLOY_SCRIPT_ENV:
            with self.subTest(azd=name):
                self.assertIn(name, sorted(azd_reads), f"the script no longer reads {name}")
                self.assertIn(name, sorted(compiled["outputs"]), f"{name} is not an output of main.bicep")
        for name in sorted(azd_reads):
            with self.subTest(read=name):
                self.assertTrue(name in compiled["outputs"] or name in AZD_BUILT_INS, f"{name} is neither an output nor an azd value")
        # Overrides and tunables belong to the caller, so a provision never writes them back.
        self.assertEqual(sorted(overrides - set(DEPLOY_SCRIPT_OVERRIDES)), [])
        self.assertEqual(sorted(overrides & set(compiled["outputs"])), [])

    def test_agent_deploy_script_agrees_with_the_infrastructure(self):
        compiled, _ = compile_main()
        script = DEPLOY_SCRIPT.read_text()
        policy = of_type(templates()["foundry"], "Microsoft.CognitiveServices/accounts/raiPolicies")[0]

        # The agent name is the FOUNDRY_AGENT_NAME output, the name the web app calls, unless AGENT_NAME overrides it.
        self.assertIn('AGENT_NAME="${AGENT_NAME:-${FOUNDRY_AGENT_NAME:-}}"', script)
        self.assertEqual(
            compiled["outputs"].get("FOUNDRY_AGENT_NAME", {}).get("value"),
            "[variables('foundryAgentName')]",
        )
        self.assertEqual(compiled["variables"]["foundryAgentName"], "health-model-agent")
        # The agent identity has no Azure roles: it reaches Azure only through the MCP server with the user's token.
        self.assertNotIn("role assignment", script)
        self.assertEqual(re.search(r"--api-version (\S+)", script)[1], policy["apiVersion"])

    def test_agent_principal_reaches_the_web_app_and_survives_the_next_provision(self):
        compiled, _ = compile_main()
        env = {item["name"]: item["value"] for item in module_parameter("container-app-web", "env")}
        script = DEPLOY_SCRIPT.read_text()
        readme = (ROOT / "infra" / "README.md").read_text()

        # azd env value -> main.bicep parameter -> web app env var -> output, so a provision keeps what the script set.
        self.assertEqual(env["FOUNDRY_AGENT_PRINCIPAL_ID"], "[parameters('foundryAgentPrincipalId')]")
        self.assertEqual(compiled["outputs"]["FOUNDRY_AGENT_PRINCIPAL_ID"]["value"], "[parameters('foundryAgentPrincipalId')]")
        self.assertEqual(compiled["outputs"]["SERVICE_WEB_NAME"]["type"], "string")
        # The two commands the script runs once the agent exists; the second one avoids a second provision.
        commands = (
            'azd env set FOUNDRY_AGENT_PRINCIPAL_ID "$PRINCIPAL_ID"',
            'az containerapp update --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$AZURE_RESOURCE_GROUP" '
            '--name "$SERVICE_WEB_NAME" --set-env-vars "FOUNDRY_AGENT_PRINCIPAL_ID=$PRINCIPAL_ID" --output none',
        )
        for command in commands:
            with self.subTest(command=command.split()[0:3]):
                self.assertIn(command, " ".join(script.replace("\\\n", " ").split()))
                self.assertIn(command, " ".join(readme.split()))


def log_analytics_expression(access):
    # The Log Analytics access block as the compiled template holds it: ids come from variables.
    return {
        "resourceAppId": "[variables('logAnalyticsApplicationId')]",
        "resourceAccess": [{"id": "[variables('logAnalyticsDataReadId')]", "type": access["resourceAccess"][0]["type"]}],
    }


def keys_of(value):
    # Every key at every depth of a decoded JSON document.
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from keys_of(child)
    elif isinstance(value, list):
        for child in value:
            yield from keys_of(child)


class EntraAndMcpContractTests(unittest.TestCase):
    def test_app_registrations_accept_any_directory_and_personal_accounts_use_token_version_2_and_hold_no_secret(self):
        entra = templates()["entra"]
        graph = resources(entra)
        apps = {name: r for name, r in entra["resources"].items() if r["type"] == "Microsoft.Graph/applications@v1.0"}

        # Each app is declared twice with one uniqueName: the first creates it, the second sets what needs an app id.
        self.assertEqual(sorted(apps), ["mcpApp", "mcpCreated", "webApp", "webCreated"])
        self.assertEqual(
            sorted(r["type"] for r in graph),
            sorted(["Microsoft.Graph/applications@v1.0"] * 4 + ["Microsoft.Graph/servicePrincipals@v1.0"] * 2 + ["Microsoft.Graph/applications/federatedIdentityCredentials@v1.0"] * 2),
        )
        for name, app in apps.items():
            with self.subTest(app=name):
                self.assertEqual(app["properties"]["signInAudience"], "[variables('signInAudience')]")
                self.assertEqual(
                    app["properties"]["uniqueName"],
                    "[variables('mcpUniqueName')]" if name.startswith("mcp") else "[variables('webUniqueName')]",
                )
        for name in ("mcpApp", "webApp"):
            with self.subTest(token_version=name):
                self.assertEqual(apps[name]["properties"]["api"]["requestedAccessTokenVersion"], 2)
        # Work or school accounts of any directory and personal accounts, which need token version 2 and a global id URI.
        self.assertEqual(entra["variables"]["signInAudience"], "AzureADandPersonalMicrosoftAccount")
        for name in ("mcpApp", "webApp"):
            with self.subTest(identifier_uri=name):
                self.assertEqual(apps[name]["properties"]["identifierUris"], [f"[format('api://{{0}}', reference('{name[:-3]}Created').appId)]"])
        self.assertEqual(entra["variables"]["webUniqueName"], "[format('ahm-{0}-web', parameters('environmentName'))]")
        self.assertEqual(entra["variables"]["mcpUniqueName"], "[format('ahm-{0}-mcp', parameters('environmentName'))]")
        # A federated credential replaces every secret, key and certificate.
        for key in ("passwordCredentials", "keyCredentials", "passwordCredential", "keyCredential", "clientSecret", "secretText", "customKeyIdentifier"):
            with self.subTest(absent=key):
                self.assertNotIn(key, set(keys_of(graph)))
        self.assertNotIn("secret", json.dumps(graph).lower())

    def test_app_registrations_expose_the_planned_scopes_and_delegated_permissions(self):
        entra = templates()["entra"]
        variables = entra["variables"]
        web, mcp = entra["resources"]["webApp"]["properties"], entra["resources"]["mcpApp"]["properties"]
        arm = {
            "resourceAppId": "[variables('armApplicationId')]",
            "resourceAccess": [{"id": "[variables('armUserImpersonationId')]", "type": "Scope"}],
        }
        log_analytics = {"resourceAppId": LOG_ANALYTICS[0], "resourceAccess": [{"id": LOG_ANALYTICS[1], "type": "Scope"}]}

        self.assertEqual((variables["webScopeValue"], variables["mcpScopeValue"]), ("access_as_user", "Mcp.Tools.ReadWrite"))
        self.assertEqual((variables["armApplicationId"], variables["armUserImpersonationId"]), ARM)
        self.assertEqual(variables["armAccess"], arm)
        self.assertEqual(
            (variables["logAnalyticsApplicationId"], variables["logAnalyticsDataReadId"]),
            LOG_ANALYTICS,
        )
        # Stable ids: a second provision never recreates a scope another app has been granted.
        self.assertEqual(variables["webScopeId"], "[guid(variables('webUniqueName'), variables('webScopeValue'))]")
        self.assertEqual(variables["mcpScopeId"], "[guid(variables('mcpUniqueName'), variables('mcpScopeValue'))]")
        for name, app, scope in (("web", web, "webScope"), ("mcp", mcp, "mcpScope")):
            with self.subTest(scope=name):
                declared = variables[scope]
                created = entra["resources"][f"{name}Created"]["properties"]

                self.assertEqual(
                    (declared["id"], declared["value"], declared["type"], declared["isEnabled"]),
                    (f"[variables('{scope}Id')]", f"[variables('{scope}Value')]", "User", True),
                )
                self.assertEqual(app["api"]["oauth2PermissionScopes"], [f"[variables('{scope}')]"])
                # Graph refuses to pre-authorize a scope in the request that adds it: the creating declaration
                # must already carry the scope the second declaration pre-authorizes.
                self.assertEqual(created["api"]["oauth2PermissionScopes"], [f"[variables('{scope}')]"])
                self.assertEqual(created["api"]["requestedAccessTokenVersion"], 2)
                self.assertNotIn("preAuthorizedApplications", created["api"])
                self.assertEqual(app["identifierUris"], [f"[format('api://{{0}}', reference('{name}Created').appId)]"])
        # Consent of a user of another directory to the web app provisions the MCP server there with it, and only the
        # web app is such a client.
        self.assertEqual(mcp["api"]["knownClientApplications"], ["[reference('webCreated').appId]"])
        self.assertNotIn("knownClientApplications", web["api"])
        # The web app is pre-authorized for the MCP scope: nobody consents to it interactively.
        self.assertEqual(
            mcp["api"]["preAuthorizedApplications"],
            [{"appId": "[reference('webCreated').appId]", "delegatedPermissionIds": ["[variables('mcpScopeId')]"]}],
        )
        # Only the web app is pre-authorized for the MCP scope. The web scope's own pre-authorization is the opt-in below.
        self.assertEqual(
            web["api"]["preAuthorizedApplications"],
            "[if(parameters('allowAzureCli'), createArray(createObject('appId', variables('azureCliApplicationId'), "
            "'delegatedPermissionIds', createArray(variables('webScopeId')))), createArray())]",
        )
        self.assertEqual(mcp["requiredResourceAccess"], ["[variables('armAccess')]", log_analytics_expression(log_analytics)])
        self.assertEqual(
            web["requiredResourceAccess"],
            [
                "[variables('armAccess')]",
                {"resourceAppId": "[reference('mcpCreated').appId]", "resourceAccess": [{"id": "[variables('mcpScopeId')]", "type": "Scope"}]},
                {"resourceAppId": "[reference('webCreated').appId]", "resourceAccess": [{"id": "[variables('webScopeId')]", "type": "Scope"}]},
            ],
        )
        # A single-page app: it redirects to the deployed site, to the local dev server only when asked (next test), and
        # has no web or implicit flow.
        self.assertEqual(
            web["spa"]["redirectUris"],
            "[if(parameters('allowLocalRedirect'), createArray(parameters('webUrl'), variables('localRedirectUri')), "
            "createArray(parameters('webUrl')))]",
        )
        for key in ("web", "implicitGrantSettings", "publicClient"):
            with self.subTest(absent=key):
                self.assertNotIn(key, web)
        self.assertRegex(
            module_parameter("entra", "webUrl"),
            r"\[format\('https://\{0\}/', " + app_host("webAppName") + r"\)\]",
        )

    def test_azure_cli_is_pre_authorized_for_the_web_scope_only_when_asked(self):
        compiled, _ = compile_main()
        entra = templates()["entra"]
        web, mcp = entra["resources"]["webApp"]["properties"], entra["resources"]["mcpApp"]["properties"]
        expression = re.fullmatch(
            r"\[if\(parameters\('allowAzureCli'\), createArray\(createObject\('appId', variables\('(\w+)'\), "
            r"'delegatedPermissionIds', createArray\(variables\('(\w+)'\)\)\)\), createArray\(\)\)\]",
            web["api"]["preAuthorizedApplications"],
        )

        def rendered(allow):
            # What the one conditional in the web app's pre-authorization renders to for a value of the parameter.
            client, scope = expression[1], expression[2]
            return [{"appId": entra["variables"][client], "delegatedPermissionIds": [f"[variables('{scope}')]"]}] if allow else []

        self.assertIsNotNone(expression)
        for module, name, default in (("main", "entraAllowAzureCli", False), ("entra", "allowAzureCli", False)):
            with self.subTest(parameter=name):
                declared = compiled["parameters"] if module == "main" else entra["parameters"]
                self.assertEqual((declared[name]["type"], declared[name]["defaultValue"]), ("bool", default))
        self.assertEqual(module_parameter("entra", "allowAzureCli"), "[parameters('entraAllowAzureCli')]")
        self.assertEqual(entra["variables"]["azureCliApplicationId"], AZURE_CLI_APPLICATION_ID)
        for allow, expected in (
            (False, []),
            (True, [{"appId": AZURE_CLI_APPLICATION_ID, "delegatedPermissionIds": ["[variables('webScopeId')]"]}]),
        ):
            with self.subTest(allow_azure_cli=allow):
                # Off adds no client; on adds exactly the CLI, for exactly the web scope.
                self.assertEqual(rendered(allow), expected)
                # The MCP scope stays reachable only through the web app's exchange, whatever the parameter says.
                self.assertEqual(
                    mcp["api"]["preAuthorizedApplications"],
                    [{"appId": "[reference('webCreated').appId]", "delegatedPermissionIds": ["[variables('mcpScopeId')]"]}],
                )
        self.assertEqual(entra["variables"]["webScopeId"], "[guid(variables('webUniqueName'), variables('webScopeValue'))]")
        self.assertNotIn("azureCliApplicationId", json.dumps(mcp))

    def test_local_redirect_uri_is_added_only_when_asked(self):
        compiled, _ = compile_main()
        entra = templates()["entra"]
        web = entra["resources"]["webApp"]["properties"]
        expression = re.fullmatch(
            r"\[if\(parameters\('allowLocalRedirect'\), createArray\(parameters\('webUrl'\), variables\('(\w+)'\)\), "
            r"createArray\(parameters\('webUrl'\)\)\)\]",
            web["spa"]["redirectUris"],
        )

        def rendered(allow):
            # What the one conditional in the web app's redirect URIs renders to for a value of the parameter.
            return ["[parameters('webUrl')]", entra["variables"][expression[1]]] if allow else ["[parameters('webUrl')]"]

        self.assertIsNotNone(expression)
        for module, name in (("main", "entraAllowLocalRedirect"), ("entra", "allowLocalRedirect")):
            with self.subTest(parameter=name):
                declared = compiled["parameters"] if module == "main" else entra["parameters"]
                self.assertEqual((declared[name]["type"], declared[name]["defaultValue"]), ("bool", False))
        self.assertEqual(module_parameter("entra", "allowLocalRedirect"), "[parameters('entraAllowLocalRedirect')]")
        self.assertEqual(entra["variables"]["localRedirectUri"], "http://localhost:8080/")
        for allow, expected in (
            (False, ["[parameters('webUrl')]"]),
            (True, ["[parameters('webUrl')]", "http://localhost:8080/"]),
        ):
            with self.subTest(allow_local_redirect=allow):
                self.assertEqual(rendered(allow), expected)
        # The MCP registration is not a single-page app and never gets a redirect URI.
        self.assertNotIn("spa", entra["resources"]["mcpApp"]["properties"])

    def test_both_registrations_trust_their_own_workload_identity_through_a_federated_credential(self):
        entra = templates()["entra"]
        credentials = {
            name: r
            for name, r in entra["resources"].items()
            if r["type"] == "Microsoft.Graph/applications/federatedIdentityCredentials@v1.0"
        }

        self.assertEqual(sorted(credentials), ["mcpWorkloadCredential", "webWorkloadCredential"])
        self.assertEqual(entra["parameters"]["tokenExchangeAudience"]["defaultValue"], "api://AzureADTokenExchange")
        # Each app trusts its own identity: the MCP server is reachable from the internet and never signs as the web app.
        for name, app, parameter, output in (
            ("mcpWorkloadCredential", "mcp", "mcpIdentityPrincipalId", "mcpIdentityPrincipalId"),
            ("webWorkloadCredential", "web", "webIdentityPrincipalId", "identityPrincipalId"),
        ):
            with self.subTest(credential=name):
                properties = credentials[name]["properties"]

                self.assertEqual(properties["name"], f"[format('{{0}}/workload-identity', variables('{app}UniqueName'))]")
                self.assertEqual(properties["issuer"], "[format('{0}{1}/v2.0', environment().authentication.loginEndpoint, tenant().tenantId)]")
                # The subject is the identity's object (principal) id, not its client id.
                self.assertEqual(properties["subject"], f"[parameters('{parameter}')]")
                self.assertEqual(properties["audiences"], ["[parameters('tokenExchangeAudience')]"])
                self.assertEqual(credentials[name]["dependsOn"], [f"{app}App"])
                self.assertRegex(
                    module_parameter("entra", parameter),
                    r"reference\(.+'foundation'\), '[\d-]+'\)\.outputs\." + output + r"\.value",
                )
        self.assertNotEqual(module_parameter("entra", "webIdentityPrincipalId"), module_parameter("entra", "mcpIdentityPrincipalId"))
        self.assertEqual(module_parameter("entra", "environmentName"), "[parameters('environmentName')]")

    def test_mcp_container_app_serves_remote_on_behalf_of_requests_with_its_entra_settings(self):
        compiled, _ = compile_main()
        env = {item["name"]: item["value"] for item in module_parameter("container-app-mcp", "env")}
        app = of_type(templates()["container-app-mcp"], "Microsoft.App/containerApps")[0]
        container = app["properties"]["template"]["containers"][0]
        entra_output = lambda name: re.compile(rf"reference\(.+'entra'\), '[\d-]+'\)\.outputs\.{name}\.value")

        self.assertEqual(compiled["variables"]["mcpAppName"], "[format('ca-{0}-mcp', variables('namePrefix'))]")
        for name, expected in (
            ("name", "[variables('mcpAppName')]"),
            ("serviceName", "mcp"),
            ("targetPort", 8080),
            ("external", True),
            ("image", "[parameters('mcpImage')]"),
            ("identityId", None),
        ):
            with self.subTest(parameter=name):
                value = module_parameter("container-app-mcp", name)
                if expected is None:
                    self.assertRegex(value, r"\.outputs\.mcpIdentityId\.value")
                else:
                    self.assertEqual(value, expected)
        self.assertNotEqual(
            module_parameter("container-app-mcp", "identityId"),
            module_parameter("container-app-web", "identityId"),
        )
        self.assertEqual(
            list(env),
            [
                "AzureAd__Instance",
                "AzureAd__TenantId",
                "AzureAd__ClientId",
                "AzureAd__ClientCredentials__0__SourceType",
                "AzureAd__ClientCredentials__0__ManagedIdentityClientId",
                "AzureAd__ClientCredentials__0__TokenExchangeUrl",
                "AZURE_MCP_DANGEROUSLY_DISABLE_HTTPS_REDIRECTION",
                "AZURE_MCP_DANGEROUSLY_ENABLE_FORWARDED_HEADERS",
                "AZURE_MCP_COLLECT_TELEMETRY",
            ],
        )
        self.assertEqual(env["AzureAd__Instance"], "[environment().authentication.loginEndpoint]")
        # Users of any directory call it: the issuer and the on-behalf-of exchange follow the tenant of each token.
        self.assertEqual(env["AzureAd__TenantId"], "organizations")
        self.assertRegex(env["AzureAd__ClientId"], entra_output("mcpClientId"))
        self.assertRegex(env["AzureAd__ClientCredentials__0__ManagedIdentityClientId"], r"\.outputs\.mcpIdentityClientId\.value")
        for name, value in (
            ("AzureAd__ClientCredentials__0__SourceType", "SignedAssertionFromManagedIdentity"),
            ("AzureAd__ClientCredentials__0__TokenExchangeUrl", "api://AzureADTokenExchange"),
            # TLS ends at the ingress; the server must not redirect plain HTTP to HTTPS, and reads the original scheme.
            ("AZURE_MCP_DANGEROUSLY_DISABLE_HTTPS_REDIRECTION", "true"),
            ("AZURE_MCP_DANGEROUSLY_ENABLE_FORWARDED_HEADERS", "true"),
            # Its exporter has no credential for Entra-only Application Insights, and product telemetry stays off.
            ("AZURE_MCP_COLLECT_TELEMETRY", "false"),
        ):
            with self.subTest(env=name):
                self.assertEqual(env[name], value)
        self.assertEqual([name for name in env if name.startswith(("APPLICATIONINSIGHTS", "AZURE_CLIENT_ID"))], [])
        # The flags that make the server read-only live in the image; the app overrides neither command nor args.
        self.assertEqual(sorted(set(container) & {"command", "args"}), [])
        self.assertEqual((app["properties"]["template"]["scale"]["minReplicas"], app["properties"]["template"]["scale"]["maxReplicas"]), (1, 1))
        self.assertEqual(
            compiled["outputs"]["MCP_URL"]["value"],
            "[format('https://{0}/', reference(extensionResourceId(format('/subscriptions/{0}/resourceGroups/{1}', subscription().subscriptionId, format('rg-{0}', parameters('environmentName'))), 'Microsoft.Resources/deployments', 'container-app-mcp'), '2025-04-01').outputs.fqdn.value)]",
        )

    def test_mcp_server_runs_as_its_own_identity_that_holds_only_acr_pull(self):
        foundation, rbac = templates()["foundation"], templates()["rbac"]
        identity = "resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('id-{{0}}-{0}', parameters('namePrefix')))"
        mcp_assignments = [
            a for a in of_type(rbac, "Microsoft.Authorization/roleAssignments")
            if a["properties"]["principalId"] == "[parameters('mcpIdentityPrincipalId')]"
        ]

        self.assertEqual(
            sorted(r["name"] for r in of_type(foundation, "Microsoft.ManagedIdentity/userAssignedIdentities")),
            ["[format('id-{0}-app', parameters('namePrefix'))]", "[format('id-{0}-mcp', parameters('namePrefix'))]"],
        )
        # The id, the client id (the setting the MCP server signs its assertion with) and the principal id (the subject
        # of the federated credential) of each identity come from the same resource.
        for kind, prefix in (("app", "identity"), ("mcp", "mcpIdentity")):
            for suffix, expected in (
                ("Id", f"[{identity.format(kind)}]"),
                ("ClientId", f"[reference({identity.format(kind)}, '2023-01-31').clientId]"),
                ("PrincipalId", f"[reference({identity.format(kind)}, '2023-01-31').principalId]"),
            ):
                with self.subTest(output=prefix + suffix):
                    self.assertEqual(foundation["outputs"][prefix + suffix]["value"], expected)
        # The MCP identity pulls its image and nothing else: no session store, no Foundry, no telemetry.
        self.assertEqual([(scope_type(a), role_guid(a)) for a in mcp_assignments], [("Microsoft.ContainerRegistry/registries", BUILT_IN_ROLES["AcrPull"])])
        self.assertIn("parameters('mcpIdentityId')", mcp_assignments[0]["name"])
        # Only the modules that pull the image, sign the exchange or run the app are handed it.
        for name, module in deployments().items():
            with self.subTest(module=name):
                mentions = "mcpIdentity" in json.dumps(module["properties"]["parameters"])

                self.assertEqual(mentions, name in ("rbac", "entra", "container-app-mcp"))
        self.assertNotIn("mcpIdentity", json.dumps(module_parameter("container-app-web", "env")))

    def test_main_outputs_carry_what_the_hooks_and_the_apps_read(self):
        compiled, _ = compile_main()

        self.assertEqual(
            sorted(name for name in compiled["outputs"] if name.startswith(("ENTRA_", "MCP_", "SERVICE_"))),
            sorted(
                [
                    "ENTRA_API_SCOPE",
                    "ENTRA_CLIENT_ID",
                    "ENTRA_MCP_CLIENT_ID",
                    "ENTRA_TENANT_ID",
                    "MCP_SCOPE",
                    "MCP_URL",
                    "SERVICE_MCP_FQDN",
                    "SERVICE_WEB_FQDN",
                    "SERVICE_WEB_NAME",
                ]
            ),
        )
        for name, output in (
            ("ENTRA_CLIENT_ID", "webClientId"),
            ("ENTRA_MCP_CLIENT_ID", "mcpClientId"),
            ("ENTRA_API_SCOPE", "webApiScope"),
            ("MCP_SCOPE", "mcpScope"),
            ("ENTRA_TENANT_ID", "tenantId"),
        ):
            with self.subTest(output=name):
                self.assertRegex(compiled["outputs"][name]["value"], rf"reference\(.+'entra'\), '[\d-]+'\)\.outputs\.{output}\.value")
        self.assertEqual(
            templates()["entra"]["outputs"]["webApiScope"]["value"],
            "[format('api://{0}/{1}', reference('webCreated').appId, variables('webScopeValue'))]",
        )
        self.assertEqual(
            templates()["entra"]["outputs"]["mcpScope"]["value"],
            "[format('api://{0}/{1}', reference('mcpCreated').appId, variables('mcpScopeValue'))]",
        )

    def test_consent_hook_runs_after_provision_skips_existing_grants_and_never_half_applies(self):
        script = ROOT / "scripts" / "hooks" / "postprovision.sh"
        text = script.read_text()
        compiled, _ = compile_main()
        # A stand-in az. `ad sp show` finds a service principal (tsv) or describes the one resource both apps request
        # (json), `ad app show` lists what an app requests, `ad app permission list-grants` answers from AZ_GRANTED (apps
        # with every grant) and AZ_PARTIAL (apps with one scope missing), and `admin-consent` behaves as AZ_MODE says.
        # Every call is logged.
        stub = (
            "#!/usr/bin/env bash\n"
            'echo "$*" >> "$AZ_LOG"\n'
            'case "$1 $2 $3" in\n'
            '  "ad sp show")\n'
            '    [ "$AZ_MODE" = nosp ] && { echo "Resource does not exist" >&2; exit 1; }\n'
            '    case "$*" in\n'
            "      *tsv*) echo sp-id ;;\n"
            '      *) echo \'{"app":"res-arm","id":"sp-arm","scopes":[{"id":"scope-1","value":"user_impersonation"},{"id":"scope-2","value":"Data.Read"}]}\' ;;\n'
            "    esac\n"
            "    exit 0 ;;\n"
            '  "ad app show") echo \'[{"app":"res-arm","ids":["scope-1","scope-2"]}]\'; exit 0 ;;\n'
            '  "ad app permission")\n'
            '    if [ "$4" = list-grants ]; then\n'
            '      case " $AZ_GRANTED " in *" $6 "*) echo \'[{"resource":"sp-arm","scope":"user_impersonation Data.Read"}]\'; exit 0 ;; esac\n'
            '      case " $AZ_PARTIAL " in *" $6 "*) echo \'[{"resource":"sp-arm","scope":"user_impersonation"}]\'; exit 0 ;; esac\n'
            "      echo '[]'; exit 0\n"
            "    fi\n"
            '    case "$AZ_MODE" in\n'
            '      denied) echo "Insufficient privileges to complete the operation." >&2; exit 1 ;;\n'
            '      never) echo "Request_ResourceNotFound: not found" >&2; exit 1 ;;\n'
            '      flaky) [ -f "$AZ_STATE" ] || { touch "$AZ_STATE"; echo "Request_ResourceNotFound: not found" >&2; exit 1; } ;;\n'
            "    esac ;;\n"
            "esac\n"
            "exit 0\n"
        )
        web, mcp = "11111111-aaaa-4aaa-8aaa-111111111111", "22222222-bbbb-4bbb-8bbb-222222222222"
        consent = lambda app: f"ad app permission admin-consent --id {app}"
        # Calls as the log holds them up to their --query.
        show = lambda app: f"ad sp show --id {app}"
        reads = lambda app: [f"ad app show --id {app}", f"ad app permission list-grants --id {app}", show("res-arm")]
        manual = [f"az {consent(mcp)}", f"az {consent(web)}"]
        # case: (az mode, apps with every grant, apps with a scope missing, return code, az calls in order, strings stderr
        # must hold, strings stdout must hold)
        cases = {
            "nothing granted yet": (
                "ok", (), (), 0,
                [show(mcp), show(web), *reads(mcp), consent(mcp), *reads(web), consent(web)],
                [], [f"consent granted for app {mcp}", f"consent granted for app {web}"],
            ),
            "every grant exists, so nothing is consented": (
                "ok", (mcp, web), (), 0,
                [show(mcp), show(web), *reads(mcp), *reads(web)],
                [], [f"consent already granted for app {mcp}", f"consent already granted for app {web}"],
            ),
            "only the app without a grant is consented": (
                "ok", (mcp,), (), 0,
                [show(mcp), show(web), *reads(mcp), *reads(web), consent(web)],
                [], [f"consent already granted for app {mcp}", f"consent granted for app {web}"],
            ),
            "a grant that misses a requested scope is completed": (
                "ok", (web,), (mcp,), 0,
                [show(mcp), show(web), *reads(mcp), consent(mcp), *reads(web)],
                [], [f"consent granted for app {mcp}", f"consent already granted for app {web}"],
            ),
            "replication delay is waited out": (
                "flaky", (), (), 0,
                [show(mcp), show(web), *reads(mcp), consent(mcp), consent(mcp), *reads(web), consent(web)],
                ["not accepted yet"], [],
            ),
            "no Entra role: the commands are printed and the deployment goes on": (
                "denied", (), (), 0,
                [show(mcp), show(web), *reads(mcp), consent(mcp)],
                ["lack the Entra role", "goes on", *manual], [],
            ),
            "no Entra role, but an administrator consented earlier": (
                "denied", (mcp, web), (), 0,
                [show(mcp), show(web), *reads(mcp), *reads(web)],
                [], [f"consent already granted for app {mcp}", f"consent already granted for app {web}"],
            ),
            "service principal never appears": ("nosp", (), (), 1, [show(mcp)], ["still not visible", *manual], []),
            "consent keeps failing for another reason": (
                "never", (), (), 1,
                [show(mcp), show(web), *reads(mcp), consent(mcp)],
                ["still fails", *manual], [],
            ),
        }

        for output in ("ENTRA_CLIENT_ID", "ENTRA_MCP_CLIENT_ID"):
            with self.subTest(reads=output):
                self.assertIn(output, compiled["outputs"])
                self.assertIn(output, text)
        self.assertIn("az ad app permission admin-consent --id", text)
        self.assertEqual(subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True).returncode, 0)
        with tempfile.TemporaryDirectory() as directory:
            az = Path(directory) / "az"
            az.write_text(stub)
            az.chmod(0o755)
            for name, (mode, granted, partial, code, calls, stderr, stdout) in cases.items():
                with self.subTest(case=name):
                    log, state = Path(directory) / "calls", Path(directory) / "state"
                    log.unlink(missing_ok=True)
                    state.unlink(missing_ok=True)

                    result = run_script(
                        "./scripts/hooks/postprovision.sh",
                        path_prefix=directory,
                        AZ_LOG=str(log),
                        AZ_STATE=str(state),
                        AZ_MODE=mode,
                        AZ_GRANTED=" ".join(granted),
                        AZ_PARTIAL=" ".join(partial),
                        ENTRA_CLIENT_ID=web,
                        ENTRA_MCP_CLIENT_ID=mcp,
                        CONSENT_WAIT_SECONDS="0" if mode in ("nosp", "never") else "30",
                        POLL_INTERVAL_SECONDS="0",
                    )

                    self.assertEqual(result.returncode, code, result.stderr)
                    # Only one app is ever consented when the first grant fails: nothing is half applied.
                    self.assertEqual(
                        [line.split(" --query")[0].split(" -o ")[0] for line in log.read_text().splitlines()] if log.exists() else [],
                        calls,
                    )
                    for message in stderr:
                        self.assertIn(message, result.stderr)
                    for message in stdout:
                        self.assertIn(message.lower(), result.stdout.lower())
            for name in ("ENTRA_CLIENT_ID", "ENTRA_MCP_CLIENT_ID"):
                with self.subTest(missing=name):
                    result = run_script(
                        "./scripts/hooks/postprovision.sh",
                        path_prefix=directory,
                        drop=(name,),
                        **{other: "x" for other in ("ENTRA_CLIENT_ID", "ENTRA_MCP_CLIENT_ID") if other != name},
                    )

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)

    def test_predown_hook_deletes_the_activity_log_setting_once_and_tolerates_its_absence(self):
        script = ROOT / "scripts" / "hooks" / "predown.sh"
        compiled, _ = compile_main()
        # A stand-in az: `show` and `delete` of a subscription diagnostic setting behave as AZ_MODE says, every call is logged.
        stub = (
            "#!/usr/bin/env bash\n"
            'echo "$*" >> "$AZ_LOG"\n'
            'case "$AZ_MODE $4" in\n'
            '  "absent show") echo "ERROR: (ResourceNotFound) The diagnostic setting does not exist." >&2; exit 1 ;;\n'
            '  "unreadable show") echo "ERROR: (AuthorizationFailed) The client does not have authorization." >&2; exit 1 ;;\n'
            '  "undeletable delete") echo "ERROR: (Conflict) The setting is locked." >&2; exit 1 ;;\n'
            "esac\n"
            "exit 0\n"
        )
        subscription, environment = "11111111-1111-1111-1111-111111111111", "demo"
        setting = f"diag-{environment}-activity"
        call = lambda verb, *flags: f"monitor diagnostic-settings subscription {verb} --subscription {subscription} --name {setting}" + "".join(f" {flag}" for flag in flags)
        # mode: (return code, az calls in order, strings stderr must hold, strings stdout must hold)
        cases = {
            "present": ("present", 0, [call("show", "--output none"), call("delete", "--yes")], [], ["Deleted"]),
            "already gone": ("absent", 0, [call("show", "--output none")], [], ["already gone"]),
            "cannot be read": ("unreadable", 1, [call("show", "--output none")], ["AuthorizationFailed"], []),
            "cannot be deleted": ("undeletable", 1, [call("show", "--output none"), call("delete", "--yes")], ["Conflict"], []),
        }

        # The hook derives the setting's name the way main.bicep does and reads only values azd defines.
        self.assertEqual(
            module_parameter("subscription-monitoring", "diagnosticSettingName"),
            "[format('diag-{0}-activity', variables('namePrefix'))]",
        )
        self.assertEqual(compiled["variables"]["namePrefix"], "[parameters('environmentName')]")
        self.assertEqual(json.loads((ROOT / "infra" / "main.parameters.json").read_text())["parameters"]["environmentName"]["value"], "${AZURE_ENV_NAME}")
        self.assertIn('setting="diag-${AZURE_ENV_NAME}-activity"', script.read_text())
        self.assertEqual(subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True).returncode, 0)
        with tempfile.TemporaryDirectory() as directory:
            az = Path(directory) / "az"
            az.write_text(stub)
            az.chmod(0o755)
            for name, (mode, code, calls, stderr, stdout) in cases.items():
                with self.subTest(case=name):
                    log = Path(directory) / "calls"
                    log.unlink(missing_ok=True)

                    result = run_script(
                        "./scripts/hooks/predown.sh",
                        path_prefix=directory,
                        AZ_LOG=str(log),
                        AZ_MODE=mode,
                        AZURE_ENV_NAME=environment,
                        AZURE_SUBSCRIPTION_ID=subscription,
                    )

                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertEqual(log.read_text().splitlines() if log.exists() else [], calls)
                    for message in stderr:
                        self.assertIn(message, result.stderr)
                    for message in stdout:
                        self.assertIn(message, result.stdout)
            for name in ("AZURE_ENV_NAME", "AZURE_SUBSCRIPTION_ID"):
                with self.subTest(missing=name):
                    result = run_script(
                        "./scripts/hooks/predown.sh",
                        path_prefix=directory,
                        drop=(name,),
                        **{other: "x" for other in ("AZURE_ENV_NAME", "AZURE_SUBSCRIPTION_ID") if other != name},
                    )

                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name, result.stderr)


class ApplicationHealthModelContractTests(unittest.TestCase):
    def test_entities_and_counts(self):
        compiled, _ = compile_main()
        entities = app_entities()

        self.assertEqual(set(entities), set(APP_ENTITIES))
        self.assertEqual(
            templates()["health-model-entities"]["outputs"]["deterministicEntityCount"]["value"],
            len(APP_ENTITIES),
        )
        self.assertEqual(
            templates()["health-model-relationships"]["outputs"]["deterministicRelationshipCount"]["value"],
            len(APP_EDGES),
        )
        self.assertEqual((len(APP_ENTITIES), len(APP_EDGES)), (15, 16))
        self.assertEqual(
            {name: compiled["outputs"][name]["type"] for name in ("HEALTH_MODEL_ENTITY_COUNT", "HEALTH_MODEL_RELATIONSHIP_COUNT")},
            {"HEALTH_MODEL_ENTITY_COUNT": "int", "HEALTH_MODEL_RELATIONSHIP_COUNT": "int"},
        )
        for name in REMOVED_ENTITIES:
            with self.subTest(removed=name):
                self.assertNotIn(name, entities)

    def test_layout_layers_names_and_rollup(self):
        entities = app_entities()
        positions = {}
        for name, (display_name, layer, x) in APP_ENTITIES.items():
            with self.subTest(entity=name):
                properties = entities[name]["properties"]
                positions[name] = (properties["canvasPosition"]["x"], properties["canvasPosition"]["y"])

                self.assertEqual(properties["displayName"], display_name)
                self.assertEqual(positions[name], (x, APP_LAYER_Y[layer]))
                self.assertEqual(properties["healthObjective"], 99)
                self.assertEqual(properties["impact"], APP_IMPACT.get(name, "Standard"))
                if name in APP_ROLLUP:
                    self.assertEqual(
                        properties["signalGroups"]["dependencies"],
                        {"aggregationType": "WorstOf", "ignoreUnknown": True},
                    )
                else:
                    self.assertNotIn("dependencies", properties["signalGroups"])
        self.assertEqual(len(set(positions.values())), len(APP_ENTITIES))
        for first in sorted(positions):
            for second in sorted(positions):
                if first < second:
                    with self.subTest(apart=(first, second)):
                        (x1, y1), (x2, y2) = positions[first], positions[second]

                        self.assertTrue(abs(x1 - x2) >= 200 or abs(y1 - y2) >= 100)

    def test_root_alert_is_the_only_alert(self):
        for name, entity in app_entities().items():
            with self.subTest(entity=name):
                alerts = entity["properties"].get("alerts")
                if name == APP_ROOT:
                    self.assertEqual(list(alerts), ["unhealthy"])
                    self.assertEqual(alerts["unhealthy"]["severity"], "Sev2")
                    self.assertEqual(alerts["unhealthy"]["actionGroupIds"], ["[parameters('rootActionGroupId')]"])
                else:
                    self.assertIsNone(alerts)

    def test_relationships_connect_exactly_the_planned_graph(self):
        edges = app_edges()
        parents = {}
        for parent, child in edges.values():
            parents.setdefault(child, []).append(parent)

        self.assertEqual(edges, APP_EDGES)
        self.assertEqual(len(set(edges.values())), len(APP_EDGES))
        self.assertEqual(descendants(edges, APP_ROOT), set(APP_ENTITIES) - {APP_ROOT})
        for name in APP_ENTITIES:
            with self.subTest(entity=name):
                self.assertNotIn(name, descendants(edges, name))
        # The graph is a DAG: the one component shared by several flows is a single entity, never copied per flow.
        self.assertEqual(
            {child: sorted(p) for child, p in parents.items() if len(p) > 1},
            {"system-app-hosting": ["flow-run-agent-tasks", "flow-send-health-reports", "flow-view-health-model"]},
        )

    def test_resource_bindings_and_signals(self):
        entities = app_entities()
        bound = {name for name, entity in entities.items() if "azureResource" in entity["properties"]["signalGroups"]}

        self.assertEqual(bound, set(APP_BINDINGS))
        for name, (key, kind, resource_health) in APP_BINDINGS.items():
            with self.subTest(binding=name):
                group = entities[name]["properties"]["signalGroups"]["azureResource"]

                self.assertEqual(group["azureResourceId"], f"[parameters('monitoredResources').{key}]")
                self.assertEqual(group["azureResourceKind"], kind)
                self.assertEqual(group["resourceHealth"], {"enabled": resource_health})
        for name, entity in entities.items():
            with self.subTest(signals=name):
                self.assertEqual(signals(entity), APP_SIGNALS.get(name, ([], [])))
                for group in entity["properties"]["signalGroups"].values():
                    if "authenticationSetting" in group:
                        self.assertEqual(group["authenticationSetting"], "[parameters('authenticationSettingName')]")
        for (name, signal_name), (degraded, unhealthy) in APP_RULES.items():
            with self.subTest(rules=f"{name}/{signal_name}"):
                definition = signal(entities[name], signal_name)

                self.assertEqual(rule(definition, "degradedRule"), degraded)
                self.assertEqual(rule(definition, "unhealthyRule"), unhealthy)
        for (name, signal_name), expected in APP_METRICS.items():
            with self.subTest(metric=f"{name}/{signal_name}"):
                definition = signal(entities[name], signal_name)

                self.assertEqual(
                    (
                        definition["metricNamespace"],
                        definition["metricName"],
                        definition["aggregationType"],
                        definition.get("dimensionFilter"),
                    ),
                    expected,
                )
        for (name, signal_name), expected in APP_METRIC_GRAINS.items():
            with self.subTest(grain=f"{name}/{signal_name}"):
                definition = signal(entities[name], signal_name)

                self.assertEqual((definition["timeGrain"], definition["refreshInterval"]), expected)
        for signal_name, query in AGENT_QUERIES.items():
            with self.subTest(query=signal_name):
                definition = signal(entities["hosted-agent"], signal_name)

                self.assertEqual(definition["queryText"], query)
                self.assertEqual((definition["valueColumnName"], definition["timeGrain"]), ("Value", "PT15M"))

    def test_query_signals_evaluate_over_the_window_their_query_declares(self):
        # timeGrain is the signal's time range and is intersected with the query's own time filter, so an ago() longer
        # than the grain is dead text: a 15 minute query on PT5M answered 33% while its 15 minute run said 40%.
        for name, entity in app_entities().items():
            for definition in entity["properties"]["signalGroups"].get("azureLogAnalytics", {}).get("signals", []):
                with self.subTest(signal=f"{name}/{definition['name']}"):
                    window = re.search(r"ago\((\d+)m\)", definition["queryText"])[1]

                    self.assertEqual(definition["timeGrain"], f"PT{window}M")

    def test_agent_latency_thresholds_sit_above_every_task_budget_and_below_the_task_timeout(self):
        # The signal is the p95 of the whole-Task span, so a normal Task of the longest kind must not trip it.
        agent = (AGENT_DIR / "src" / "agent.py").read_text()
        web_config = (ROOT / "src" / "web" / "app" / "config.py").read_text()
        budgets = dict(re.findall(r'"(\w+)": (\d+)', re.search(r"^MODEL_SECONDS = \{([^}]*)\}", agent, re.MULTILINE)[1]))
        timeout = int(re.search(r"^TASK_TIMEOUT_SECONDS = (\d+)", web_config, re.MULTILINE)[1])
        rules = signal(app_entities()["hosted-agent"], "agent-task-latency")["evaluationRules"]
        degraded, unhealthy = rules["degradedRule"]["threshold"], rules["unhealthyRule"]["threshold"]

        self.assertEqual(sorted(budgets), ["design", "explain", "review"])
        for task_type, budget in budgets.items():
            with self.subTest(task_type=task_type):
                self.assertGreater(degraded, int(budget) * 1000)
        for name, threshold in (("degraded", degraded), ("unhealthy", unhealthy)):
            with self.subTest(rule=name):
                self.assertLess(threshold, timeout * 1000)
        self.assertLess(degraded, unhealthy)

    def test_web_app_signals_read_all_workspace_telemetry_without_survey_or_database_filters(self):
        queries = {
            s["name"]: s["queryText"]
            for s in app_entities()["container-app"]["properties"]["signalGroups"]["azureLogAnalytics"]["signals"]
        }

        # Auto-instrumentation marks every 4xx unsuccessful: scanner 404s and a HEAD 405 must not count as failures.
        self.assertEqual(
            queries["failed-requests"],
            "AppRequests | where TimeGenerated > ago(5m) | summarize Value = countif(toint(ResultCode) >= 500)",
        )
        self.assertEqual(
            queries["exceptions"],
            "AppExceptions | where TimeGenerated > ago(5m) | summarize Value = count()",
        )
        self.assertIn("parameters('availabilityTestName')", queries["availability-test"])
        self.assertIn("| where not(isnan(Value))", queries["availability-test"])
        # The MCP server cannot export requests (no credential for Entra-only Application Insights), so the only
        # evidence in the workspace is the availability probe of its /health route.
        mcp_queries = {
            s["name"]: s["queryText"]
            for s in app_entities()["mcp-server"]["properties"]["signalGroups"]["azureLogAnalytics"]["signals"]
        }
        self.assertEqual(list(mcp_queries), ["availability-test"])
        self.assertIn("parameters('mcpAvailabilityTestName')", mcp_queries["availability-test"])
        self.assertIn("| where not(isnan(Value))", mcp_queries["availability-test"])
        self.assertNotIn("AppRequests", mcp_queries["availability-test"])

    def test_discovery_and_platform_context_are_unchanged(self):
        discovery = of_type(templates()["health-model-discovery"], "Microsoft.CloudHealth/healthmodels/discoveryrules")[0]
        platform = app_entities()["platform-context"]["properties"]["signalGroups"]["azureLogAnalytics"]["signals"]

        self.assertEqual(discovery["name"], "[format('{0}/{1}', parameters('modelName'), 'discover-app-insights')]")
        self.assertEqual(
            (
                discovery["properties"]["specification"]["kind"],
                discovery["properties"]["addRecommendedSignals"],
                discovery["properties"]["addResourceHealthSignal"],
                discovery["properties"]["discoverRelationships"],
            ),
            ("ApplicationInsightsTopology", "Disabled", "Disabled", "Enabled"),
        )
        self.assertEqual([s["name"] for s in platform], ["service-health", "failed-arm-operations", "platform-alerts"])

    def test_platform_context_counts_failed_operations_of_this_group_in_the_workspace_vocabulary(self):
        platform = app_entities()["platform-context"]["properties"]["signalGroups"]["azureLogAnalytics"]["signals"]
        query = next(s["queryText"] for s in platform if s["name"] == "failed-arm-operations")

        # The workspace records a failed operation as "Failure" (docs say "Failed"), and the log spans the subscription.
        self.assertEqual(
            query,
            "[format('AzureActivity | where TimeGenerated > ago(15m) | where CategoryValue == \"Administrative\" "
            "| where ResourceGroup =~ \"{0}\" | summarize Value = countif(ActivityStatusValue in (\"Failed\", \"Failure\"))', "
            "resourceGroup().name)]",
        )

    def test_model_identity_keeps_reader_and_monitoring_reader_on_the_group(self):
        assignments = of_type(templates()["health-model-access"], "Microsoft.Authorization/roleAssignments")
        monitored = module_parameter("health-model-access", "monitoredResources")

        self.assertEqual(
            sorted(role_guid(a) for a in assignments),
            sorted([BUILT_IN_ROLES["Reader"], BUILT_IN_ROLES["Monitoring Reader"]]),
        )
        self.assertTrue(all("scope" not in a for a in assignments))
        self.assertEqual(
            sorted(monitored),
            sorted({key for key, _, _ in APP_BINDINGS.values()} | {"logAnalyticsWorkspace", "applicationInsights"}),
        )


class RepositoryHygieneTests(unittest.TestCase):
    def test_tracked_files_carry_no_real_subscription_identity(self):
        # Everything git tracks is shareable, so a subscription id or account name may only
        # appear as an obviously synthetic placeholder (one repeated hex digit).
        tracked = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT,
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
            path = ROOT / name
            if not name or not path.is_file():
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

    def test_no_tracked_file_references_the_removed_agent_app(self):
        tracked = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=ROOT,
            capture_output=True,
            check=True,
        ).stdout.split(b"\0")

        referencing = set()
        for raw in tracked:
            name = raw.decode()
            path = ROOT / name
            if not name or name.startswith(AGENT_APP_EXEMPT) or not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            if "agent" "-app" in text:
                referencing.add(name)

        self.assertEqual(sorted(referencing - AGENT_APP_PENDING), [], "new references to the removed agent")
        self.assertEqual(
            sorted(AGENT_APP_PENDING - referencing),
            [],
            "these files no longer name it: remove them from AGENT_APP_PENDING",
        )

    def test_availability_test_names_agree_across_infrastructure(self):
        modules = ROOT / "infra" / "modules"

        for parameter in ("availabilityTestName", "mcpAvailabilityTestName"):
            names = {
                path.name: re.search(rf"param {parameter} string = '([^']+)'", path.read_text(encoding="utf-8")).group(1)
                for path in (
                    modules / "availability-tests.bicep",
                    modules / "health-model-entities.bicep",
                )
            }
            with self.subTest(parameter=parameter):
                self.assertEqual(len(set(names.values())), 1, names)
        # The probe targets the MCP app's own /health route, which the server answers without authentication.
        self.assertRegex(
            module_parameter("availability-tests", "mcpHealthUrl"),
            r"\[format\('https://\{0\}/health', reference\(.+'container-app-mcp'\), '[\d-]+'\)\.outputs\.fqdn\.value\)\]",
        )


if __name__ == "__main__":
    unittest.main()
