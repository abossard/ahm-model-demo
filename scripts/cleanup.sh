#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/preflight.sh"

readonly HEALTH_REPORT_ROLE_GUID='b2dde5f8-a8ae-5896-90d9-09c87b55c8f8'
readonly HEALTH_REPORT_ROLE_ID="/subscriptions/$SUB_ID/providers/Microsoft.Authorization/roleDefinitions/$HEALTH_REPORT_ROLE_GUID"
readonly HEALTH_MODEL_SCOPE="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.CloudHealth/healthmodels/$MODEL"
readonly COPILOT_APP_NAME='app-ahm-health-copilot'
readonly AI_ACCOUNT_NAME=${AZURE_OPENAI_ACCOUNT_NAME:-oai-ahm-movie-demo}
readonly AI_DEPLOYMENT_NAME=${AZURE_OPENAI_DEPLOYMENT_NAME:-gpt-54-mini}
readonly EXPECTED_COORDINATION_ACK="subscription=$SUB_ID resource_group=$RG resources=$AI_ACCOUNT_NAME,$AI_DEPLOYMENT_NAME,$COPILOT_APP_NAME"

mode=${1:-}
if [[ -n "$mode" && "$mode" != '--execute' ]]; then
  printf 'Usage: %s [--execute]\n' "$0" >&2
  exit 2
fi

plan=$(jq -nc \
  --arg subscription "$SUB_ID" \
  --arg diagnostic "$ACTIVITY_DIAGNOSTIC_NAME" \
  --arg resourceGroup "$RG" \
  --arg roleDefinition "$HEALTH_REPORT_ROLE_ID" '{
    mode: "dry-run",
    subscription: $subscription,
    delete: [
      {type: "subscriptionDiagnosticSetting", name: $diagnostic},
      {type: "resourceGroup", name: $resourceGroup},
      {type: "customRoleDefinition", name: $roleDefinition}
    ]
  }')

if [[ "$mode" != '--execute' ]]; then
  printf '%s\n' "$plan"
  printf 'CLEANUP_DRY_RUN_OK no resources were changed; pass --execute only after filming\n'
  exit 0
fi

[[ "${AZURE_MUTATION_COORDINATION_ACK:-}" == "$EXPECTED_COORDINATION_ACK" ]] || {
  printf 'CLEANUP_FAIL missing current non-overlap acknowledgment; expected AZURE_MUTATION_COORDINATION_ACK=%s\n' \
    "$EXPECTED_COORDINATION_ACK" >&2
  exit 1
}
printf 'SESSION_COORDINATION_OK %s\n' "$EXPECTED_COORDINATION_ACK"

diagnostics=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" \
  --output json)
if jq -e --arg name "$ACTIVITY_DIAGNOSTIC_NAME" \
  'any(.value[]; .name == $name)' <<<"$diagnostics" >/dev/null; then
  az rest \
    --method delete \
    --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Insights/diagnosticSettings/$ACTIVITY_DIAGNOSTIC_NAME?api-version=2021-05-01-preview" \
    --output none
fi

if [[ "$(az group exists \
  --name "$RG" \
  --subscription "$SUB_ID" \
  --output json)" == 'true' ]]; then
  az group delete \
    --name "$RG" \
    --subscription "$SUB_ID" \
    --yes \
    --output none
fi

set +e
model_assignments=$(az role assignment list \
  --scope "$HEALTH_MODEL_SCOPE" \
  --role "$HEALTH_REPORT_ROLE_GUID" \
  --subscription "$SUB_ID" \
  --output json 2>/dev/null)
assignment_status=$?
set -e
if [[ "$assignment_status" != '0' ]]; then
  model_assignments='[]'
fi
jq -e 'length == 0' <<<"$model_assignments" >/dev/null || {
  printf 'CLEANUP_FAIL exact model role assignment still exists\n' >&2
  exit 1
}

if [[ "$(az role definition list \
  --name "$HEALTH_REPORT_ROLE_GUID" \
  --subscription "$SUB_ID" \
  --query 'length(@)' \
  --output tsv)" == '1' ]]; then
  az role definition delete \
    --name "$HEALTH_REPORT_ROLE_GUID" \
    --subscription "$SUB_ID" \
    --output none
fi

remaining_diagnostics=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" \
  --output json)
jq -e --arg name "$ACTIVITY_DIAGNOSTIC_NAME" \
  'all(.value[]; .name != $name)' <<<"$remaining_diagnostics" >/dev/null
[[ "$(az group exists \
  --name "$RG" \
  --subscription "$SUB_ID" \
  --output json)" == 'false' ]]
[[ "$(az role definition list \
  --name "$HEALTH_REPORT_ROLE_GUID" \
  --subscription "$SUB_ID" \
  --query 'length(@)' \
  --output tsv)" == '0' ]]

printf 'CLEANUP_OK subscription=%s diagnostic=%s resource_group=%s role_definition=%s absent=true\n' \
  "$SUB_ID" "$ACTIVITY_DIAGNOSTIC_NAME" "$RG" "$HEALTH_REPORT_ROLE_ID"
