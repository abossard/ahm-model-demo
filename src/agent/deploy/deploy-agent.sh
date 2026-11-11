#!/usr/bin/env bash
# Builds the agent image in ACR, creates a Foundry hosted agent version when something changed, waits until it is
# active, and hands the agent's identity to the web app, which uses it to recognise the agent's token requests. Safe to
# run again. Reads the azd environment variables; the agent name is FOUNDRY_AGENT_NAME, and AGENT_NAME overrides it.
# Optional: ACTIVATION_TIMEOUT_SECONDS (600), POLL_INTERVAL_SECONDS (5), FORBIDDEN_RETRY_SECONDS (180).
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_NAME="${AGENT_NAME:-${FOUNDRY_AGENT_NAME:-}}"
ACTIVATION_TIMEOUT_SECONDS="${ACTIVATION_TIMEOUT_SECONDS:-600}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-5}"
FORBIDDEN_RETRY_SECONDS="${FORBIDDEN_RETRY_SECONDS:-180}"
API_VERSION="v1"

for name in AGENT_NAME AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP AZURE_CONTAINER_REGISTRY_NAME \
  AZURE_CONTAINER_REGISTRY_ENDPOINT FOUNDRY_PROJECT_ENDPOINT FOUNDRY_MODEL_DEPLOYMENT_NAME \
  FOUNDRY_AGENT_EGRESS_POLICY_ID MCP_URL SERVICE_WEB_FQDN ENTRA_CLIENT_ID SERVICE_WEB_NAME; do
  [ -n "${!name:-}" ] || { echo "$name is not set; run this from an azd environment after azd provision (AGENT_NAME overrides FOUNDRY_AGENT_NAME)" >&2; exit 1; }
done
command -v azd >/dev/null || { echo "azd is not installed: the script stores the agent identity in the azd environment" >&2; exit 1; }

BODY_FILE="$(mktemp)"
CURL_CONFIG="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$CURL_CONFIG"' EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

request() {
  local status delay=5 waited=0
  while :; do
    if [ -n "${3:-}" ]; then
      status="$(printf '%s' "$3" | curl -sS -K "$CURL_CONFIG" -o "$BODY_FILE" -w '%{http_code}' -X "$1" "$2" --data-binary @- || true)"
    else
      status="$(curl -sS -K "$CURL_CONFIG" -o "$BODY_FILE" -w '%{http_code}' -X "$1" "$2" </dev/null || true)"
    fi
    if [ "$status" != 403 ]; then
      echo "$status"
      return
    fi
    if [ "$waited" -ge "$FORBIDDEN_RETRY_SECONDS" ]; then
      echo "Foundry still answers 403 after ${waited}s: the identity running this script needs Foundry Project Manager on the project" >&2
      echo "$status"
      return
    fi
    echo "Foundry answers 403, the deployer's access may still be propagating: retrying in ${delay}s (${waited}s of ${FORBIDDEN_RETRY_SECONDS}s)" >&2
    sleep "$delay"
    waited=$((waited + delay))
    delay=$((delay * 2 > 30 ? 30 : delay * 2))
  done
}

fail_with_body() {
  echo "$1" >&2
  cat "$BODY_FILE" >&2
  exit 1
}

image_tag() {
  (
    cd "$AGENT_DIR"
    cat Dockerfile pyproject.toml uv.lock .python-version
    find src skills -type f -not -name '*.pyc' -not -path '*/__pycache__/*' | LC_ALL=C sort | xargs cat
  ) | sha256 | cut -c1-12
}

build_image() {
  if az acr repository show --subscription "$AZURE_SUBSCRIPTION_ID" --name "$AZURE_CONTAINER_REGISTRY_NAME" --image "$IMAGE_REPO:$1" >/dev/null 2>&1; then
    echo "Image $IMAGE_REPO:$1 is already in $AZURE_CONTAINER_REGISTRY_NAME"
    return
  fi
  (cd "$AGENT_DIR" && az acr build --subscription "$AZURE_SUBSCRIPTION_ID" --registry "$AZURE_CONTAINER_REGISTRY_NAME" \
    --image "$IMAGE_REPO:$1" --platform linux/amd64 --file Dockerfile .)
}

# The agent reaches Azure only through the MCP server with the signed-in user's token, which the web app's broker hands out.
definition_for() {
  jq -n --arg image "$1" --arg model "$FOUNDRY_MODEL_DEPLOYMENT_NAME" --arg policy "$FOUNDRY_AGENT_EGRESS_POLICY_ID" \
    --arg mcp "$MCP_URL" --arg web "https://$SERVICE_WEB_FQDN" --arg audience "api://$ENTRA_CLIENT_ID" '{
    kind: "hosted",
    container_configuration: {image: $image},
    cpu: "1",
    memory: "2Gi",
    protocol_versions: [{protocol: "responses", version: "2.0.0"}],
    environment_variables: {
      AZURE_AI_MODEL_DEPLOYMENT_NAME: $model,
      AZURE_TOKEN_CREDENTIALS: "ManagedIdentityCredential",
      PYTHONNOUSERSITE: "1",
      MCP_URL: $mcp,
      WEB_APP_URL: $web,
      WEB_API_AUDIENCE: $audience
    },
    rai_config: {rai_policy_name: $policy}
  }'
}

matching_status() {
  jq -r --argjson want "$1" '
    .versions.latest as $v
    | select(
        $v.definition.container_configuration.image == $want.container_configuration.image
        and $v.definition.cpu == $want.cpu
        and $v.definition.memory == $want.memory
        and ($v.definition.rai_config.rai_policy_name // "" | ascii_downcase) == ($want.rai_config.rai_policy_name | ascii_downcase)
        and ($want.environment_variables | to_entries | all(. as $e | $v.definition.environment_variables[$e.key] == $e.value))
      )
    | $v.status
  ' "$BODY_FILE"
}

require_egress_policy() {
  local url="$PROJECT_URL/agents/$AGENT_NAME/versions/$1?api-version=$API_VERSION" status
  status="$(request GET "$url")"
  [ "$status" = 200 ] || fail_with_body "Reading version $1 returned $status"
  if jq -e --arg policy "$FOUNDRY_AGENT_EGRESS_POLICY_ID" \
    '(.definition.rai_config.rai_policy_name // "" | ascii_downcase) == ($policy | ascii_downcase)' "$BODY_FILE" >/dev/null; then
    return
  fi
  echo "Version $1 does not reference the egress policy $FOUNDRY_AGENT_EGRESS_POLICY_ID: its sessions would have open egress" >&2
  status="$(request DELETE "$url")"
  case "$status" in
    200 | 202 | 204) echo "Deleted version $1" >&2 ;;
    *) echo "Could not delete version $1 (HTTP $status): delete it before it serves traffic" >&2 ;;
  esac
  exit 1
}

wait_until_active() {
  local url="$PROJECT_URL/agents/$AGENT_NAME/versions/$1?api-version=$API_VERSION" status state waited=0
  while :; do
    status="$(request GET "$url")"
    [ "$status" = 200 ] || fail_with_body "Reading version $1 returned $status"
    state="$(jq -r '.status' "$BODY_FILE")"
    echo "Version $1: $state"
    case "$state" in
      active) return ;;
      failed) fail_with_body "Version $1 failed" ;;
    esac
    if [ "$waited" -ge "$ACTIVATION_TIMEOUT_SECONDS" ]; then
      fail_with_body "Version $1 is still $state after ${ACTIVATION_TIMEOUT_SECONDS}s. Run this script again: it keeps waiting for this version and does not create another"
    fi
    sleep "$POLL_INTERVAL_SECONDS"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
}

create_version() {
  local status version
  status="$(request POST "$1" "$2")"
  [ "$status" = 200 ] || [ "$status" = 201 ] || fail_with_body "Creating the version returned $status"
  version="$(jq -r '.versions.latest.version // .version' "$BODY_FILE")"
  require_egress_policy "$version"
  wait_until_active "$version"
}

# The web app accepts token requests only from this identity. azd keeps it for the next provision; the web app gets it
# now, so that no second provision is needed.
hand_identity_to_web_app() {
  local current
  azd env set FOUNDRY_AGENT_PRINCIPAL_ID "$PRINCIPAL_ID"
  current="$(az containerapp show --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$SERVICE_WEB_NAME" --query "properties.template.containers[0].env[?name=='FOUNDRY_AGENT_PRINCIPAL_ID'].value | [0]" \
    --output tsv 2>/dev/null || true)"
  if [ "$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$PRINCIPAL_ID" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "The web app $SERVICE_WEB_NAME already knows the agent identity"
    return
  fi
  az containerapp update --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$AZURE_RESOURCE_GROUP" --name "$SERVICE_WEB_NAME" --set-env-vars "FOUNDRY_AGENT_PRINCIPAL_ID=$PRINCIPAL_ID" --output none
}

PROJECT_URL="${FOUNDRY_PROJECT_ENDPOINT%/}"
AGENT_URL="$PROJECT_URL/agents/$AGENT_NAME?api-version=$API_VERSION"
IMAGE_REPO="$(printf '%s' "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')"

az resource show --ids "$FOUNDRY_AGENT_EGRESS_POLICY_ID" --api-version 2026-05-15-preview --query name -o tsv >/dev/null \
  || { echo "The egress policy $FOUNDRY_AGENT_EGRESS_POLICY_ID does not exist; a missing policy fails open" >&2; exit 1; }

TAG="$(image_tag)"
build_image "$TAG"

IMAGE="$AZURE_CONTAINER_REGISTRY_ENDPOINT/$IMAGE_REPO:$TAG"
DEFINITION="$(definition_for "$IMAGE")"
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
  "$(az account get-access-token --resource https://ai.azure.com --query accessToken -o tsv)" > "$CURL_CONFIG"

status="$(request GET "$AGENT_URL")"
case "$status" in
  200)
    case "$(matching_status "$DEFINITION")" in
      active) echo "The latest version already runs $IMAGE" ;;
      creating) wait_until_active "$(jq -r '.versions.latest.version' "$BODY_FILE")" ;;
      *) create_version "$PROJECT_URL/agents/$AGENT_NAME/versions?api-version=$API_VERSION" \
        "$(jq -n --argjson definition "$DEFINITION" '{definition: $definition}')" ;;
    esac
    ;;
  404)
    create_version "$PROJECT_URL/agents?api-version=$API_VERSION" \
      "$(jq -n --arg name "$AGENT_NAME" --argjson definition "$DEFINITION" '{name: $name, definition: $definition}')"
    ;;
  *) fail_with_body "Reading the agent returned $status" ;;
esac

status="$(request GET "$AGENT_URL")"
[ "$status" = 200 ] || fail_with_body "Reading the agent returned $status"
PRINCIPAL_ID="$(jq -r '.instance_identity.principal_id // .versions.latest.instance_identity.principal_id // empty' "$BODY_FILE")"
[ -n "$PRINCIPAL_ID" ] || fail_with_body "The agent has no instance identity yet"

hand_identity_to_web_app

echo "Agent $AGENT_NAME is active on $IMAGE; its identity reaches the web app and holds no Azure role"
echo "Responses endpoint: $PROJECT_URL/agents/$AGENT_NAME/endpoint/protocols/openai/responses?api-version=$API_VERSION"
