#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
source "$SCRIPT_DIR/preflight.sh"

readonly ENVIRONMENT_NAME='cae-ahm-movie-demo'
readonly APP_NAME='app-ahm-movie-demo'
readonly COPILOT_APP_NAME='app-ahm-health-copilot'
readonly AI_ACCOUNT_NAME=${AZURE_OPENAI_ACCOUNT_NAME:-oai-ahm-movie-demo}
readonly AI_DEPLOYMENT_NAME=${AZURE_OPENAI_DEPLOYMENT_NAME:-gpt-54-mini}
readonly VNET_NAME='vnet-ahm-movie-demo'
readonly INFRASTRUCTURE_SUBNET_NAME='snet-container-apps'
readonly QUEUE_PRIVATE_ENDPOINT_NAME='pe-ahm-movie-demo-queue'
readonly QUEUE_PRIVATE_DNS_ZONE='privatelink.queue.core.windows.net'
readonly ENVIRONMENT_RESOURCE_ID="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.App/managedEnvironments/$ENVIRONMENT_NAME"
readonly APP_RESOURCE_ID="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.App/containerApps/$APP_NAME"
readonly VNET_RESOURCE_ID="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Network/virtualNetworks/$VNET_NAME"
readonly EXPECTED_INFRASTRUCTURE_SUBNET_ID="$VNET_RESOURCE_ID/subnets/$INFRASTRUCTURE_SUBNET_NAME"
readonly EXPECTED_COORDINATION_ACK="subscription=$SUB_ID resource_group=$RG resources=$AI_ACCOUNT_NAME,$AI_DEPLOYMENT_NAME,$COPILOT_APP_NAME"
LINK_COPILOT_TO_HEALTH_PULSE=${LINK_COPILOT_TO_HEALTH_PULSE:-false}
[[ "$LINK_COPILOT_TO_HEALTH_PULSE" == 'true' ||
  "$LINK_COPILOT_TO_HEALTH_PULSE" == 'false' ]] || {
  printf 'DEPLOY_FAIL LINK_COPILOT_TO_HEALTH_PULSE must be true or false\n' >&2
  exit 1
}

if [[ "$DEPLOY_COPILOT" == 'true' ]]; then
  [[ "${AZURE_MUTATION_COORDINATION_ACK:-}" == "$EXPECTED_COORDINATION_ACK" ]] || {
    printf 'DEPLOY_FAIL missing current non-overlap acknowledgment; expected AZURE_MUTATION_COORDINATION_ACK=%s\n' \
      "$EXPECTED_COORDINATION_ACK" >&2
    exit 1
  }
  printf 'SESSION_COORDINATION_OK %s\n' "$EXPECTED_COORDINATION_ACK"
fi

EXPIRES_ON=${EXPIRES_ON:-2026-07-31}
[[ "$EXPIRES_ON" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || {
  printf 'DEPLOY_FAIL invalid EXPIRES_ON\n' >&2
  exit 1
}

ADMIN_IP=$(curl --fail --silent --show-error https://api.ipify.org)
python3 - "$ADMIN_IP" <<'PY'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
raise SystemExit(0 if address.version == 4 else 1)
PY

tags_json=$(jq -nc --arg expires "$EXPIRES_ON" '{
  purpose: "azure-health-model-movie-demo",
  expiresOn: $expires,
  owner: "anbossar"
}')

templates=(
  "$ROOT_DIR/infra/foundation.bicep" \
  "$ROOT_DIR/infra/subscription-monitoring.bicep" \
  "$ROOT_DIR/infra/workload.bicep" \
  "$ROOT_DIR/infra/health-model.bicep"
)
if [[ "$DEPLOY_COPILOT" == 'true' ]]; then
  templates+=("$ROOT_DIR/infra/copilot.bicep")
fi
for template in "${templates[@]}"; do
  az bicep build --file "$template" --stdout >/dev/null
done
printf 'BICEP_BUILD_OK templates=%s copilot=%s\n' \
  "${#templates[@]}" "$DEPLOY_COPILOT"

group_exists=$(az group exists \
  --name "$RG" \
  --subscription "$SUB_ID" \
  --output tsv)
if [[ "$group_exists" == 'true' ]]; then
  group_json=$(az group show \
    --name "$RG" \
    --subscription "$SUB_ID" \
    --output json)
  jq -e --arg name "$RG" --arg location "$LOCATION" '
    .name == $name and (.location | ascii_downcase) == ($location | ascii_downcase)
  ' <<<"$group_json" >/dev/null || {
    printf 'DEPLOY_FAIL exact resource group name/location mismatch\n' >&2
    exit 1
  }
fi

if [[ "$group_exists" == 'true' ]]; then
  group_deployments_json=$(az rest \
    --method get \
    --url "https://management.azure.com/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.Resources/deployments?api-version=2022-09-01" \
    --output json)
else
  group_deployments_json='{"value":[]}'
fi
subscription_deployments_json=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Resources/deployments?api-version=2022-09-01" \
  --output json)
for deployments_json in "$group_deployments_json" "$subscription_deployments_json"; do
  jq -e '
    all(
      .value[];
      (.properties.provisioningState == "Succeeded")
      or (.properties.provisioningState == "Failed")
      or (.properties.provisioningState == "Canceled")
    )
  ' <<<"$deployments_json" >/dev/null || {
    printf 'DEPLOY_FAIL a competing ARM deployment is active\n' >&2
    exit 1
  }
done
printf 'DEPLOYMENT_CONCURRENCY_OK group_active=0 subscription_active=0\n'

if [[ "$group_exists" == 'false' ]]; then
  az group create \
    --name "$RG" \
    --location "$LOCATION" \
    --subscription "$SUB_ID" \
    --tags purpose=azure-health-model-movie-demo expiresOn="$EXPIRES_ON" owner=anbossar \
    --output none
fi
printf 'RESOURCE_GROUP_OK name=%s location=%s\n' "$RG" "$LOCATION"

foundation_what_if=$(az deployment group what-if \
  --name ahm-foundation-what-if \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/foundation.bicep" \
  --parameters \
    location="$LOCATION" \
    adminObjectId="$ADMIN_OBJECT_ID" \
    adminUpn="$ADMIN_UPN" \
    adminIpAddress="$ADMIN_IP" \
    tags="$tags_json" \
  --no-pretty-print \
  --result-format ResourceIdOnly \
  --output json)
jq -e \
  --arg scope "/subscriptions/$SUB_ID/resourceGroups/$RG/" '
    all(
      .changes[];
      (.resourceId | ascii_downcase | startswith($scope | ascii_downcase))
      and .changeType != "Delete"
    )
  ' <<<"$foundation_what_if" >/dev/null || {
  printf 'DEPLOY_FAIL foundation what-if escaped the exact task scope or planned deletion\n' >&2
  exit 1
}
printf 'FOUNDATION_WHAT_IF_OK scope=/subscriptions/%s/resourceGroups/%s deletes=0 changes=%s\n' \
  "$SUB_ID" "$RG" \
  "$(jq -c '[.changes[] | .changeType] | group_by(.) | map({(.[0]): length}) | add // {}' <<<"$foundation_what_if")"

replacement_required=false
set +e
current_environment_json=$(az resource show \
  --ids "$ENVIRONMENT_RESOURCE_ID" \
--api-version 2025-10-02-preview \
  --subscription "$SUB_ID" \
  --output json 2>/dev/null)
environment_show_status=$?
set -e
if [[ "$environment_show_status" == '0' ]]; then
  current_infrastructure_subnet=$(jq -r \
    '.properties.vnetConfiguration.infrastructureSubnetId // ""' \
    <<<"$current_environment_json")
  if [[ "$current_infrastructure_subnet" != "$EXPECTED_INFRASTRUCTURE_SUBNET_ID" ]]; then
    replacement_required=true
  fi
fi

if [[ "$replacement_required" == true ]]; then
  if az resource show \
    --ids "$APP_RESOURCE_ID" \
    --api-version 2024-03-01 \
    --subscription "$SUB_ID" \
    --output none 2>/dev/null; then
    az containerapp delete \
      --name "$APP_NAME" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --yes \
      --output none
    az resource wait \
      --deleted \
      --ids "$APP_RESOURCE_ID" \
      --api-version 2024-03-01 \
      --subscription "$SUB_ID" \
      --interval 15 \
      --timeout 900
  fi

  az containerapp env delete \
    --name "$ENVIRONMENT_NAME" \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --yes \
    --output none
  az resource wait \
    --deleted \
    --ids "$ENVIRONMENT_RESOURCE_ID" \
    --api-version 2025-10-02-preview \
    --subscription "$SUB_ID" \
    --interval 15 \
    --timeout 1800
  printf 'MANAGED_ENVIRONMENT_REPLACEMENT_OK app=%s environment=%s old_subnet=%s desired_subnet=%s\n' \
    "$APP_NAME" "$ENVIRONMENT_NAME" "${current_infrastructure_subnet:-none}" \
    "$EXPECTED_INFRASTRUCTURE_SUBNET_ID"
else
  printf 'MANAGED_ENVIRONMENT_REPLACEMENT_OK action=reuse environment=%s subnet=%s\n' \
    "$ENVIRONMENT_NAME" "${current_infrastructure_subnet:-pending-create}"
fi

foundation_ready=false
foundation_json=''
for attempt in $(seq 1 6); do
  set +e
  foundation_output=$(az deployment group create \
    --name ahm-foundation \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --template-file "$ROOT_DIR/infra/foundation.bicep" \
    --parameters \
      location="$LOCATION" \
      adminObjectId="$ADMIN_OBJECT_ID" \
      adminUpn="$ADMIN_UPN" \
      adminIpAddress="$ADMIN_IP" \
      tags="$tags_json" \
    --only-show-errors \
    --output json 2>&1)
  foundation_status=$?
  set -e
  if [[ "$foundation_status" == '0' ]]; then
    foundation_json=$foundation_output
    foundation_ready=true
    break
  fi
  if [[ "$foundation_output" != *'AadAuthOperationCannotBePerformedWhenServerIsNotAccessible'* ]]; then
    printf '%s\n' "$foundation_output" >&2
    exit "$foundation_status"
  fi
  printf 'FOUNDATION_RETRY attempt=%s reason=postgres-entra-admin-propagation\n' "$attempt"
  postgres_name=$(az rest \
    --method get \
    --url "https://management.azure.com/subscriptions/$SUB_ID/resourceGroups/$RG/resources?api-version=2021-04-01" \
    --output json |
    jq -er '.value[]
      | select((.type | ascii_downcase) == "microsoft.dbforpostgresql/flexibleservers")
      | .name')
  for _ in $(seq 1 20); do
    postgres_state=$(az postgres flexible-server show \
      --name "$postgres_name" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --output json |
      jq -er '.state')
    [[ "$postgres_state" == 'Ready' ]] && break
    sleep 15
  done
  sleep 30
done
[[ "$foundation_ready" == true ]] || {
  printf 'DEPLOY_FAIL foundation did not converge after PostgreSQL became Ready\n' >&2
  exit 1
}

outputs=$(jq -e '.properties.outputs' <<<"$foundation_json")
IDENTITY_ID=$(jq -er '.identityId.value' <<<"$outputs")
IDENTITY_PRINCIPAL_ID=$(jq -er '.identityPrincipalId.value' <<<"$outputs")
ACR_ID=$(jq -er '.registryId.value' <<<"$outputs")
ACR_NAME=$(jq -er '.registryName.value' <<<"$outputs")
ACR_LOGIN_SERVER=$(jq -er '.registryLoginServer.value' <<<"$outputs")
LAW_ID=$(jq -er '.workspaceId.value' <<<"$outputs")
APPINSIGHTS_ID=$(jq -er '.applicationInsightsId.value' <<<"$outputs")
APPINSIGHTS_CONNECTION=$(jq -er '.applicationInsightsConnectionString.value' <<<"$outputs")
STORAGE_ID=$(jq -er '.storageId.value' <<<"$outputs")
STORAGE_NAME=$(jq -er '.storageName.value' <<<"$outputs")
PG_ID=$(jq -er '.postgresId.value' <<<"$outputs")
PG_NAME=$(jq -er '.postgresName.value' <<<"$outputs")
PG_HOST=$(jq -er '.postgresHost.value' <<<"$outputs")
ENVIRONMENT_ID=$(jq -er '.environmentId.value' <<<"$outputs")
DEPLOYED_VNET_ID=$(jq -er '.vnetId.value' <<<"$outputs")
DEPLOYED_INFRASTRUCTURE_SUBNET_ID=$(jq -er '.infrastructureSubnetId.value' <<<"$outputs")
QUEUE_PRIVATE_ENDPOINT_ID=$(jq -er '.queuePrivateEndpointId.value' <<<"$outputs")
QUEUE_PRIVATE_DNS_ZONE_ID=$(jq -er '.queuePrivateDnsZoneId.value' <<<"$outputs")
[[ "$DEPLOYED_VNET_ID" == "$VNET_RESOURCE_ID" ]]
[[ "$DEPLOYED_INFRASTRUCTURE_SUBNET_ID" == "$EXPECTED_INFRASTRUCTURE_SUBNET_ID" ]]
printf 'FOUNDATION_DEPLOY_OK acr=%s storage=%s postgres=%s vnet=%s endpoint=%s dns=%s\n' \
  "$ACR_NAME" "$STORAGE_NAME" "$PG_NAME" "$DEPLOYED_VNET_ID" \
  "$QUEUE_PRIVATE_ENDPOINT_ID" "$QUEUE_PRIVATE_DNS_ZONE_ID"

az deployment sub what-if \
  --name ahm-subscription-monitoring-what-if \
  --location "$LOCATION" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/subscription-monitoring.bicep" \
  --parameters \
    diagnosticSettingName="$ACTIVITY_DIAGNOSTIC_NAME" \
    logAnalyticsWorkspaceId="$LAW_ID" \
    taskResourceGroupId="/subscriptions/$SUB_ID/resourceGroups/$RG" \
  --no-pretty-print \
  --output json >/dev/null

subscription_monitoring_ready=false
subscription_monitoring_json=''
for attempt in $(seq 1 10); do
  set +e
  subscription_monitoring_output=$(az deployment sub create \
    --name ahm-subscription-monitoring \
    --location "$LOCATION" \
    --subscription "$SUB_ID" \
    --template-file "$ROOT_DIR/infra/subscription-monitoring.bicep" \
    --parameters \
      diagnosticSettingName="$ACTIVITY_DIAGNOSTIC_NAME" \
      logAnalyticsWorkspaceId="$LAW_ID" \
      taskResourceGroupId="/subscriptions/$SUB_ID/resourceGroups/$RG" \
    --only-show-errors \
    --output json 2>&1)
  subscription_monitoring_status=$?
  set -e
  if [[ "$subscription_monitoring_status" == '0' ]]; then
    subscription_monitoring_json=$subscription_monitoring_output
    subscription_monitoring_ready=true
    break
  fi
  if [[ "$subscription_monitoring_output" != *'ResourceNotFound'* ]]; then
    printf '%s\n' "$subscription_monitoring_output" >&2
    exit "$subscription_monitoring_status"
  fi
  printf 'SUBSCRIPTION_MONITORING_RETRY attempt=%s reason=workspace-propagation\n' "$attempt"
  sleep 30
done
[[ "$subscription_monitoring_ready" == true ]] || {
  printf 'DEPLOY_FAIL subscription diagnostic setting did not converge\n' >&2
  exit 1
}
HEALTH_REPORT_ROLE_ID=$(jq -er \
  '.properties.outputs.healthReportRoleDefinitionId.value' \
  <<<"$subscription_monitoring_json")
health_report_role_ready=false
for _ in $(seq 1 20); do
  health_report_role_json=$(az role definition list \
    --name "${HEALTH_REPORT_ROLE_ID##*/}" \
    --subscription "$SUB_ID" \
    --output json)
  if jq -e --arg id "$HEALTH_REPORT_ROLE_ID" '
    length == 1 and (.[0].id | ascii_downcase) == ($id | ascii_downcase)
  ' <<<"$health_report_role_json" >/dev/null; then
    health_report_role_ready=true
    break
  fi
  sleep 15
done
[[ "$health_report_role_ready" == true ]] || {
  printf 'DEPLOY_FAIL Health Report custom role did not propagate\n' >&2
  exit 1
}
printf 'SUBSCRIPTION_MONITORING_OK name=%s health_report_role=%s\n' \
  "$ACTIVITY_DIAGNOSTIC_NAME" "$HEALTH_REPORT_ROLE_ID"

image_hash=$(
  shasum -a 256 \
    "$ROOT_DIR/app/app.py" \
    "$ROOT_DIR/app/requirements.txt" \
    "$ROOT_DIR/app/Dockerfile" \
    "$ROOT_DIR/app/templates/index.html" \
    "$ROOT_DIR/app/static/app.css" \
    "$ROOT_DIR/app/static/app.js" |
    shasum -a 256 |
    cut -c1-12
)
image_tag="ahm-demo:$image_hash"

if az acr repository show \
  --name "$ACR_NAME" \
  --image "$image_tag" \
  --subscription "$SUB_ID" \
  --output none 2>/dev/null; then
  printf 'ACR_IMAGE_REUSE image=%s\n' "$image_tag"
else
  az acr build \
    --registry "$ACR_NAME" \
    --subscription "$SUB_ID" \
    --image "$image_tag" \
    --file "$ROOT_DIR/app/Dockerfile" \
    "$ROOT_DIR/app" \
    --platform linux/amd64 \
    --output none
fi

digest=$(az acr repository show \
  --name "$ACR_NAME" \
  --image "$image_tag" \
  --subscription "$SUB_ID" \
  --output json |
  jq -er '.digest')
image="$ACR_LOGIN_SERVER/ahm-demo@$digest"
printf 'ACR_BUILD_OK image=%s digest=%s\n' "$image_tag" "$digest"

az deployment group what-if \
  --name ahm-workload-what-if \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/workload.bicep" \
  --parameters \
    location="$LOCATION" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    image="$image" \
    storageName="$STORAGE_NAME" \
    postgresHost="$PG_HOST" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    azureSubscriptionId="$SUB_ID" \
    azureSubscriptionName="$SUB_NAME" \
    healthModelResourceGroup="$RG" \
    healthModelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    tags="$tags_json" \
  --no-pretty-print \
  --output none

workload_json=$(az deployment group create \
  --name ahm-workload \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/workload.bicep" \
  --parameters \
    location="$LOCATION" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    image="$image" \
    storageName="$STORAGE_NAME" \
    postgresHost="$PG_HOST" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    azureSubscriptionId="$SUB_ID" \
    azureSubscriptionName="$SUB_NAME" \
    healthModelResourceGroup="$RG" \
    healthModelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    tags="$tags_json" \
  --output json)

APP_ID=$(jq -er '.properties.outputs.containerAppId.value' <<<"$workload_json")
APP_FQDN=$(jq -er '.properties.outputs.fqdn.value' <<<"$workload_json")

revision_ready=false
for _ in $(seq 1 40); do
  revisions_json=$(az containerapp revision list \
    --name app-ahm-movie-demo \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --output json)
  if jq -e 'any(
    .[];
    .properties.active == true
    and (.properties.provisioningState == "Succeeded" or .properties.provisioningState == "Provisioned")
    and .properties.healthState == "Healthy"
  )' \
    <<<"$revisions_json" >/dev/null; then
    revision_ready=true
    break
  fi
  sleep 15
done
[[ "$revision_ready" == true ]] || {
  printf 'DEPLOY_FAIL Container App revision did not become ready\n' >&2
  exit 1
}
printf 'WORKLOAD_DEPLOY_OK fqdn=%s image_digest=%s\n' "$APP_FQDN" "$digest"

if [[ "$DEPLOY_COPILOT" == 'true' ]]; then
web_hash=$(
  {
    find "$ROOT_DIR/copilot/src" -type f -print0
    printf '%s\0' \
      "$ROOT_DIR/copilot/package.json" \
      "$ROOT_DIR/copilot/package-lock.json" \
      "$ROOT_DIR/copilot/tsconfig.json" \
      "$ROOT_DIR/copilot/next.config.ts" \
      "$ROOT_DIR/copilot/Dockerfile.web"
  } |
    sort -z |
    xargs -0 shasum -a 256 |
    shasum -a 256 |
    cut -c1-12
)
agent_hash=$(
  {
    find "$ROOT_DIR/copilot/agent/src" -type f -print0
    printf '%s\0' \
      "$ROOT_DIR/copilot/agent/pyproject.toml" \
      "$ROOT_DIR/copilot/agent/uv.lock" \
      "$ROOT_DIR/copilot/agent/Dockerfile"
  } |
    sort -z |
    xargs -0 shasum -a 256 |
    shasum -a 256 |
    cut -c1-12
)
web_tag="ahm-health-copilot-web:$web_hash"
agent_tag="ahm-health-copilot-agent:$agent_hash"

if ! az acr repository show \
  --name "$ACR_NAME" \
  --image "$web_tag" \
  --subscription "$SUB_ID" \
  --output none 2>/dev/null; then
  az acr build \
    --registry "$ACR_NAME" \
    --subscription "$SUB_ID" \
    --image "$web_tag" \
    --file "$ROOT_DIR/copilot/Dockerfile.web" \
    --build-arg NEXT_PUBLIC_HEALTH_APP_URL="https://$APP_FQDN" \
    "$ROOT_DIR/copilot" \
    --platform linux/amd64 \
    --output none
fi
if ! az acr repository show \
  --name "$ACR_NAME" \
  --image "$agent_tag" \
  --subscription "$SUB_ID" \
  --output none 2>/dev/null; then
  az acr build \
    --registry "$ACR_NAME" \
    --subscription "$SUB_ID" \
    --image "$agent_tag" \
    --file "$ROOT_DIR/copilot/agent/Dockerfile" \
    "$ROOT_DIR/copilot/agent" \
    --platform linux/amd64 \
    --output none
fi
web_digest=$(az acr repository show \
  --name "$ACR_NAME" \
  --image "$web_tag" \
  --subscription "$SUB_ID" \
  --output json |
  jq -er '.digest')
agent_digest=$(az acr repository show \
  --name "$ACR_NAME" \
  --image "$agent_tag" \
  --subscription "$SUB_ID" \
  --output json |
  jq -er '.digest')
web_image="$ACR_LOGIN_SERVER/ahm-health-copilot-web@$web_digest"
agent_image="$ACR_LOGIN_SERVER/ahm-health-copilot-agent@$agent_digest"

copilot_what_if=$(az deployment group what-if \
  --name ahm-copilot-what-if \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/copilot.bicep" \
  --parameters \
    aiLocation="$AI_LOCATION" \
    aiAccountName="$AI_ACCOUNT_NAME" \
    aiDeploymentName="$AI_DEPLOYMENT_NAME" \
    aiModelName="$AZURE_OPENAI_MODEL_NAME" \
    aiModelVersion="$AZURE_OPENAI_MODEL_VERSION" \
    aiDeploymentSkuName="$AZURE_OPENAI_DEPLOYMENT_SKU" \
    aiDeploymentCapacity="$AZURE_OPENAI_DEPLOYMENT_CAPACITY" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    webImage="$web_image" \
    agentImage="$agent_image" \
    healthAppUrl="https://$APP_FQDN" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    tags="$tags_json" \
  --no-pretty-print \
  --result-format ResourceIdOnly \
  --output json)
jq -e \
  --arg scope "/subscriptions/$SUB_ID/resourceGroups/$RG/" '
    all(
      .changes[];
      (.resourceId | ascii_downcase | startswith($scope | ascii_downcase))
      and .changeType != "Delete"
    )
  ' <<<"$copilot_what_if" >/dev/null || {
  printf 'DEPLOY_FAIL copilot what-if escaped scope or planned deletion\n' >&2
  exit 1
}

copilot_json=$(az deployment group create \
  --name ahm-copilot \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/copilot.bicep" \
  --parameters \
    aiLocation="$AI_LOCATION" \
    aiAccountName="$AI_ACCOUNT_NAME" \
    aiDeploymentName="$AI_DEPLOYMENT_NAME" \
    aiModelName="$AZURE_OPENAI_MODEL_NAME" \
    aiModelVersion="$AZURE_OPENAI_MODEL_VERSION" \
    aiDeploymentSkuName="$AZURE_OPENAI_DEPLOYMENT_SKU" \
    aiDeploymentCapacity="$AZURE_OPENAI_DEPLOYMENT_CAPACITY" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    webImage="$web_image" \
    agentImage="$agent_image" \
    healthAppUrl="https://$APP_FQDN" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    tags="$tags_json" \
  --output json)
COPILOT_FQDN=$(jq -er '.properties.outputs.copilotFqdn.value' <<<"$copilot_json")

copilot_ready=false
for _ in $(seq 1 40); do
  revisions_json=$(az containerapp revision list \
    --name "$COPILOT_APP_NAME" \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --output json)
  if jq -e 'any(
    .[];
    .properties.active == true
    and (.properties.provisioningState == "Succeeded" or .properties.provisioningState == "Provisioned")
    and .properties.healthState == "Healthy"
  )' <<<"$revisions_json" >/dev/null; then
    copilot_ready=true
    break
  fi
  sleep 15
done
[[ "$copilot_ready" == true ]] || {
  printf 'DEPLOY_FAIL Copilot Container App revision did not become ready\n' >&2
  exit 1
}

workload_link_what_if=$(az deployment group what-if \
  --name ahm-workload-copilot-link-what-if \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/workload.bicep" \
  --parameters \
    location="$LOCATION" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    image="$image" \
    storageName="$STORAGE_NAME" \
    postgresHost="$PG_HOST" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    azureSubscriptionId="$SUB_ID" \
    azureSubscriptionName="$SUB_NAME" \
    healthModelResourceGroup="$RG" \
    healthModelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    copilotUrl="https://$COPILOT_FQDN" \
    tags="$tags_json" \
  --no-pretty-print \
  --result-format ResourceIdOnly \
  --output json)
jq -e \
  --arg scope "/subscriptions/$SUB_ID/resourceGroups/$RG/" '
    all(
      .changes[];
      (.resourceId | ascii_downcase | startswith($scope | ascii_downcase))
      and .changeType != "Delete"
    )
  ' <<<"$workload_link_what_if" >/dev/null || {
  printf 'DEPLOY_FAIL copilot link what-if escaped scope or planned deletion\n' >&2
  exit 1
}

if [[ "$LINK_COPILOT_TO_HEALTH_PULSE" == 'true' ]]; then
az deployment group create \
  --name ahm-workload-copilot-link \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/workload.bicep" \
  --parameters \
    location="$LOCATION" \
    environmentId="$ENVIRONMENT_ID" \
    registryName="$ACR_NAME" \
    registryLoginServer="$ACR_LOGIN_SERVER" \
    image="$image" \
    storageName="$STORAGE_NAME" \
    postgresHost="$PG_HOST" \
    applicationInsightsConnectionString="$APPINSIGHTS_CONNECTION" \
    azureSubscriptionId="$SUB_ID" \
    azureSubscriptionName="$SUB_NAME" \
    healthModelResourceGroup="$RG" \
    healthModelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    copilotUrl="https://$COPILOT_FQDN" \
    tags="$tags_json" \
  --output none
else
  printf 'COPILOT_LINK_DEFERRED health_app=%s copilot=%s\n' \
    "$APP_NAME" "$COPILOT_APP_NAME"
fi
printf 'COPILOT_DEPLOY_OK fqdn=%s account=%s deployment=%s web_digest=%s agent_digest=%s\n' \
  "$COPILOT_FQDN" "$AI_ACCOUNT_NAME" "$AI_DEPLOYMENT_NAME" "$web_digest" "$agent_digest"
fi

bash "$SCRIPT_DIR/bootstrap-db.sh"

validate_metric() {
  local resource_id=$1
  local metric_name=$2
  local aggregation=$3
  local grain=$4
  local definitions

  definitions=$(az monitor metrics list-definitions \
    --resource "$resource_id" \
    --subscription "$SUB_ID" \
    --output json)
  jq -e \
    --arg name "$metric_name" \
    --arg aggregation "$aggregation" \
    --arg grain "$grain" '
      any(
        .[];
        .name.value == $name
        and any(.supportedAggregationTypes[]?; . == $aggregation)
        and any(.metricAvailabilities[]?; .timeGrain == $grain)
      )
    ' <<<"$definitions" >/dev/null || {
      printf 'METRIC_VALIDATION_FAIL resource=%s metric=%s aggregation=%s grain=%s\n' \
        "$resource_id" "$metric_name" "$aggregation" "$grain" >&2
      exit 1
    }
  printf 'METRIC_OK metric=%s aggregation=%s grain=%s\n' \
    "$metric_name" "$aggregation" "$grain"
}

validate_metric "$APP_ID" CpuPercentage Average PT1M
validate_metric "$APP_ID" MemoryPercentage Average PT1M
validate_metric "$APP_ID" ResponseTime Average PT1M
validate_metric "$PG_ID" is_db_alive Average PT1M
validate_metric "$PG_ID" connections_failed Total PT1M
validate_metric "$PG_ID" cpu_percent Average PT1M
validate_metric "$PG_ID" memory_percent Average PT1M
validate_metric "$PG_ID" storage_percent Average PT1M
validate_metric "$PG_ID" cpu_credits_remaining Average PT1M
validate_metric "$STORAGE_ID" Availability Average PT1M
validate_metric "$STORAGE_ID" SuccessE2ELatency Average PT1M
validate_metric "$STORAGE_ID" Transactions Total PT1M
validate_metric "$STORAGE_ID/queueServices/default" QueueMessageCount Average PT1H

az deployment group what-if \
  --name ahm-health-model-what-if \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/health-model.bicep" \
  --parameters \
    modelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    containerAppId="$APP_ID" \
    postgresId="$PG_ID" \
    storageId="$STORAGE_ID" \
    logAnalyticsWorkspaceId="$LAW_ID" \
    applicationInsightsId="$APPINSIGHTS_ID" \
    appIdentityPrincipalId="$IDENTITY_PRINCIPAL_ID" \
    healthReportRoleDefinitionId="$HEALTH_REPORT_ROLE_ID" \
    tags="$tags_json" \
  --no-pretty-print \
  --output none

health_json=$(az deployment group create \
  --name ahm-health-model \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --template-file "$ROOT_DIR/infra/health-model.bicep" \
  --parameters \
    modelName="$MODEL" \
    healthModelLocation="$HEALTH_MODEL_LOCATION" \
    containerAppId="$APP_ID" \
    postgresId="$PG_ID" \
    storageId="$STORAGE_ID" \
    logAnalyticsWorkspaceId="$LAW_ID" \
    applicationInsightsId="$APPINSIGHTS_ID" \
    appIdentityPrincipalId="$IDENTITY_PRINCIPAL_ID" \
    healthReportRoleDefinitionId="$HEALTH_REPORT_ROLE_ID" \
    tags="$tags_json" \
  --output json)
MODEL_ID=$(jq -er '.properties.outputs.modelId.value' <<<"$health_json")
printf 'HEALTH_MODEL_DEPLOY_OK model=%s id=%s api=2026-05-01-preview\n' "$MODEL" "$MODEL_ID"

az monitor health-models entity ingest-health-report \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --signal-name database-connectivity-probe \
  --health-state Healthy \
  --value 1 \
  --expires-in-minutes 120 \
  --additional-context 'Initial managed-identity connectivity baseline' \
  --subscription "$SUB_ID" \
  --output none

deployment_annotation=$(jq -nc \
  --arg resourceGroup "$RG" \
  --arg imageDigest "$digest" \
  '{phase: "deployment", resourceGroup: $resourceGroup, imageDigest: $imageDigest}')
az monitor health-models entity add-data-annotation \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name "$MODEL" \
  --annotation-details "$deployment_annotation" \
  --description 'Demo deployment completed' \
  --subscription "$SUB_ID" \
  --output none
az monitor health-models entity add-data-annotation \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --annotation-details "$deployment_annotation" \
  --description 'Demo deployment completed' \
  --subscription "$SUB_ID" \
  --output none
printf 'HEALTH_MODEL_BASELINE_OK external=Healthy annotation=deployment\n'

bash "$SCRIPT_DIR/verify.sh"

printf 'DEPLOY_OK subscription=%s resource_group=%s app=https://%s model=%s\n' \
  "$SUB_ID" "$RG" "$APP_FQDN" "$MODEL"
