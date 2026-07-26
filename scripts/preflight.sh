#!/usr/bin/env bash
set -euo pipefail

readonly PINNED_SUB_ID='b2af20ad-98fa-4aa7-94c3-059663641d9f'
readonly PINNED_SUB_NAME='ME-MngEnvMCAP462928-anbossar-1'
readonly PINNED_LOCATION='northeurope'
readonly DEFAULT_AI_LOCATION='swedencentral'
readonly DEFAULT_AI_MODEL_NAME='gpt-5.4-mini'
readonly DEFAULT_AI_MODEL_VERSION='2026-03-17'
readonly DEFAULT_AI_DEPLOYMENT_SKU='GlobalStandard'
readonly DEFAULT_AI_DEPLOYMENT_CAPACITY='10'

fail() {
  printf 'PREFLIGHT_FAIL: %s\n' "$*" >&2
  return 1 2>/dev/null || exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

provider_supports() {
  local namespace=$1
  local resource_type=$2
  local location=$3
  local provider_json

  provider_json=$(az provider show \
    --namespace "$namespace" \
    --subscription "$PINNED_SUB_ID" \
    --output json)

  jq -e --arg type "$resource_type" --arg location "$location" '
    .registrationState == "Registered"
    and any(
      .resourceTypes[];
      (.resourceType | ascii_downcase) == ($type | ascii_downcase)
      and any(
        .locations[]?;
        (ascii_downcase | gsub("[^a-z0-9]"; "")) ==
          ($location | ascii_downcase | gsub("[^a-z0-9]"; ""))
      )
    )
  ' <<<"$provider_json" >/dev/null ||
    fail "$namespace/$resource_type is not registered and available in $location"
}

provider_supports_api() {
  local namespace=$1
  local resource_type=$2
  local api_version=$3
  local provider_json

  provider_json=$(az provider show \
    --namespace "$namespace" \
    --subscription "$PINNED_SUB_ID" \
    --output json)

  jq -e \
    --arg type "$resource_type" \
    --arg api "$api_version" '
      .registrationState == "Registered"
      and any(
        .resourceTypes[];
        (.resourceType | ascii_downcase) == ($type | ascii_downcase)
        and (.apiVersions | index($api) != null)
      )
    ' <<<"$provider_json" >/dev/null ||
    fail "$namespace/$resource_type does not advertise API $api_version"
}

require_command az
require_command jq
require_command curl
require_command psql

deploy_copilot=${DEPLOY_COPILOT:-false}
[[ "$deploy_copilot" == 'true' || "$deploy_copilot" == 'false' ]] ||
  fail "DEPLOY_COPILOT must be true or false"
if [[ "$deploy_copilot" == 'true' ]]; then
  requested_ai_location=${AI_LOCATION:-$DEFAULT_AI_LOCATION}
  requested_ai_model=${AZURE_OPENAI_MODEL_NAME:-$DEFAULT_AI_MODEL_NAME}
  requested_ai_version=${AZURE_OPENAI_MODEL_VERSION:-$DEFAULT_AI_MODEL_VERSION}
  requested_ai_sku=${AZURE_OPENAI_DEPLOYMENT_SKU:-$DEFAULT_AI_DEPLOYMENT_SKU}
  requested_ai_capacity=${AZURE_OPENAI_DEPLOYMENT_CAPACITY:-$DEFAULT_AI_DEPLOYMENT_CAPACITY}
  [[ "$requested_ai_location" =~ ^[a-z0-9]+$ ]] ||
    fail "rejected AI location: $requested_ai_location"
  [[ "$requested_ai_model" =~ ^[a-z0-9.-]+$ ]] ||
    fail "rejected AI model: $requested_ai_model"
  [[ "$requested_ai_version" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
    fail "rejected AI model version: $requested_ai_version"
  [[ "$requested_ai_sku" =~ ^[A-Za-z0-9]+$ ]] ||
    fail "rejected AI deployment SKU: $requested_ai_sku"
  [[ "$requested_ai_capacity" =~ ^[1-9][0-9]*$ ]] ||
    fail "rejected AI deployment capacity: $requested_ai_capacity"
fi

requested_id=${PREFLIGHT_EXPECTED_SUB_ID:-$PINNED_SUB_ID}
requested_name=${PREFLIGHT_EXPECTED_SUB_NAME:-$PINNED_SUB_NAME}
requested_location=${DEPLOY_LOCATION:-$PINNED_LOCATION}
[[ "$requested_id" == "$PINNED_SUB_ID" ]] ||
  fail "expected subscription ID is not the pinned ID"
[[ "$requested_name" == "$PINNED_SUB_NAME" ]] ||
  fail "expected subscription name is not the pinned name"
[[ "$requested_location" == "$PINNED_LOCATION" ]] ||
  fail "location must be the pinned location: $PINNED_LOCATION"

accounts_json=$(az account list --all --output json)
match_count=$(jq --arg name "$PINNED_SUB_NAME" '[.[] | select(.name == $name)] | length' <<<"$accounts_json")
[[ "$match_count" == '1' ]] ||
  fail "expected exactly one subscription named $PINNED_SUB_NAME; found $match_count"

jq -e --arg name "$PINNED_SUB_NAME" --arg id "$PINNED_SUB_ID" '
  any(.[]; .name == $name and .id == $id and .state == "Enabled")
' <<<"$accounts_json" >/dev/null ||
  fail "subscription name, ID, or enabled state does not match the pinned boundary"

cli_version=$(az version --output json | jq -r '."azure-cli"')
python3 - "$cli_version" <<'PY' ||
import sys
parts = tuple(int(part) for part in sys.argv[1].split(".")[:3])
raise SystemExit(0 if parts >= (2, 75, 0) else 1)
PY
  fail "Azure CLI 2.75.0 or newer is required; found $cli_version"

extension_json=$(az extension list --output json)
jq -e '
  any(.[]; .name == "health-models" and (.version | startswith("1.0.0b")))
' <<<"$extension_json" >/dev/null ||
  fail "released preview health-models extension 1.0.0b* is required"

cloud_health_json=$(az provider show \
  --namespace Microsoft.CloudHealth \
  --subscription "$PINNED_SUB_ID" \
  --output json)
jq -e --arg location "$requested_location" '
  .registrationState == "Registered"
  and any(
    .resourceTypes[];
    (.resourceType | ascii_downcase) == "healthmodels"
    and (.apiVersions | index("2026-05-01-preview") != null)
    and any(
      .locations[]?;
      (ascii_downcase | gsub("[^a-z0-9]"; "")) ==
        ($location | ascii_downcase | gsub("[^a-z0-9]"; ""))
    )
  )
' <<<"$cloud_health_json" >/dev/null ||
  fail "Microsoft.CloudHealth healthModels 2026-05-01-preview is unavailable in $requested_location"

provider_supports Microsoft.App managedEnvironments "$requested_location"
provider_supports Microsoft.App containerApps "$requested_location"
provider_supports Microsoft.ContainerRegistry registries "$requested_location"
provider_supports Microsoft.Storage storageAccounts "$requested_location"
provider_supports Microsoft.DBforPostgreSQL flexibleServers "$requested_location"
provider_supports Microsoft.OperationalInsights workspaces "$requested_location"
provider_supports Microsoft.Insights components "$requested_location"
provider_supports Microsoft.ManagedIdentity userAssignedIdentities "$requested_location"
provider_supports Microsoft.Network virtualNetworks "$requested_location"
provider_supports Microsoft.Network privateEndpoints "$requested_location"
provider_supports_api Microsoft.App managedEnvironments 2025-10-02-preview
provider_supports_api Microsoft.App containerApps 2024-03-01
provider_supports_api Microsoft.Network virtualNetworks 2025-07-01
provider_supports_api Microsoft.Network privateEndpoints 2025-07-01
provider_supports_api Microsoft.Network privateDnsZones 2024-06-01
provider_supports_api Microsoft.Network privateDnsZones/virtualNetworkLinks 2024-06-01
provider_supports_api Microsoft.Storage storageAccounts 2023-05-01
if [[ "$deploy_copilot" == 'true' ]]; then
  provider_supports Microsoft.CognitiveServices accounts "$requested_ai_location"
  provider_supports_api Microsoft.CognitiveServices accounts 2024-10-01

  models_json=$(az rest \
    --method get \
    --url "https://management.azure.com/subscriptions/$PINNED_SUB_ID/providers/Microsoft.CognitiveServices/locations/$requested_ai_location/models?api-version=2024-10-01" \
    --output json)
  jq -e \
    --arg model "$requested_ai_model" \
    --arg version "$requested_ai_version" \
    --arg sku "$requested_ai_sku" '
      any(
        .value[]?;
        .model.name == $model
        and .model.version == $version
        and (
          (((.model.lifecycleStatus // "") | ascii_downcase) == "generallyavailable")
          or (((.model.lifecycleStatus // "") | ascii_downcase) == "ga")
          or (((.model.lifecycleStatus // "") | ascii_downcase) == "active")
        )
        and (
          any(.model.skus[]?; (.name // "") == $sku)
          or any(.skus[]?; (.name // .sku.name // "") == $sku)
        )
      )
    ' <<<"$models_json" >/dev/null ||
    fail "model/location/SKU unavailable: $requested_ai_model $requested_ai_version $requested_ai_location $requested_ai_sku"

  ai_usage_json=$(az cognitiveservices usage list \
    --location "$requested_ai_location" \
    --subscription "$PINNED_SUB_ID" \
    --output json)
  jq -e \
    --arg model "$requested_ai_model" \
    --argjson capacity "$requested_ai_capacity" '
      any(
        .[]?;
        ((.name.value // .name.localizedValue // "") | contains($model))
        and ((.limit | tonumber) - (.currentValue | tonumber)) >= $capacity
      )
    ' <<<"$ai_usage_json" >/dev/null ||
    fail "model quota unavailable: $requested_ai_model $requested_ai_location $requested_ai_sku"
  printf 'AI_PREFLIGHT_OK model=%s version=%s location=%s sku=%s capacity=%s quota=available\n' \
    "$requested_ai_model" "$requested_ai_version" "$requested_ai_location" \
    "$requested_ai_sku" "$requested_ai_capacity"
fi

sku_json=$(az postgres flexible-server list-skus \
  --location "$requested_location" \
  --subscription "$PINNED_SUB_ID" \
  --output json)
jq -e '
  any(
    .[]?.supportedServerEditions[]?;
    .name == "Burstable"
    and any(.supportedServerSkus[]?; .name == "Standard_B1ms" and .restricted != true)
  )
' \
  <<<"$sku_json" >/dev/null ||
  fail "PostgreSQL Standard_B1ms Burstable is unavailable in $requested_location"

subscription_tenant_id=$(jq -r --arg id "$PINNED_SUB_ID" '
  .[] | select(.id == $id) | .tenantId
' <<<"$accounts_json")
postgres_token_json=$(az account get-access-token \
  --subscription "$PINNED_SUB_ID" \
  --resource-type oss-rdbms \
  --output json)
postgres_token=$(jq -er '.accessToken' <<<"$postgres_token_json")
read -r ADMIN_OBJECT_ID ADMIN_UPN token_tenant_id < <(
  python3 - "$postgres_token" <<'PY'
import base64
import json
import sys

payload = sys.argv[1].split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload))
print(
    claims.get("oid", ""),
    claims.get("upn") or claims.get("preferred_username") or claims.get("unique_name", ""),
    claims.get("tid", ""),
)
PY
)
unset postgres_token postgres_token_json
[[ -n "$ADMIN_OBJECT_ID" && -n "$ADMIN_UPN" ]] ||
  fail "the target-subscription token is not for a usable Entra user"
[[ "$token_tenant_id" == "$subscription_tenant_id" ]] ||
  fail "the target-subscription token tenant does not match the subscription tenant"

export SUB_ID="$PINNED_SUB_ID"
export SUB_NAME="$PINNED_SUB_NAME"
export LOCATION="$requested_location"
export HEALTH_MODEL_LOCATION="$requested_location"
export DEPLOY_COPILOT="$deploy_copilot"
if [[ "$deploy_copilot" == 'true' ]]; then
  export AI_LOCATION="$requested_ai_location"
  export AZURE_OPENAI_MODEL_NAME="$requested_ai_model"
  export AZURE_OPENAI_MODEL_VERSION="$requested_ai_version"
  export AZURE_OPENAI_DEPLOYMENT_SKU="$requested_ai_sku"
  export AZURE_OPENAI_DEPLOYMENT_CAPACITY="$requested_ai_capacity"
fi
export RG='rg-ahm-movie-demo'
export MODEL='hm-ahm-movie-demo'
export ACTIVITY_DIAGNOSTIC_NAME='diag-ahm-movie-demo-activity'
export ADMIN_OBJECT_ID
export ADMIN_UPN

printf 'PREFLIGHT_OK subscription_name=%s subscription_id=%s state=Enabled location=%s health_api=%s cli=%s\n' \
  "$SUB_NAME" "$SUB_ID" "$LOCATION" '2026-05-01-preview' "$cli_version"
