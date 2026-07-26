#!/usr/bin/env bash
set -euo pipefail

assert_queue_correlation() {
  jq -e '
    .response.just_enqueued.message_id as $messageId
    | (.retainedMessageCount | type == "number")
    and (.response.request_id | type == "string" and length > 0)
    and ($messageId | type == "string" and length > 0)
    and .postgres.request_id == .response.request_id
    and .request.operationId == .dependency.operationId
    and (.dependency.clientRequestId | type == "string" and length > 0)
    and .dependency.success == true
    and .dependency.resultCode == "201"
    and .storage.clientRequestId == .dependency.clientRequestId
    and (.storage.objectKey | endswith("/requests/" + $messageId))
    and .storage.authenticationType == "OAuth"
    and .storage.statusCode == "201"
  ' <<<"$1" >/dev/null
}

assert_invalid_isolation() {
  jq -e '
    (.rowsBefore | type == "number")
    and (.rowsAfter | type == "number")
    and (.queueBefore | type == "number")
    and (.queueAfter | type == "number")
    and (.queueAfterSamples | type == "array" and length >= 2)
    and .rowsBefore == .rowsAfter
    and .queueBefore == .queueAfter
    and (.queueBefore as $before
      | all(.queueAfterSamples[]; . == $before))
  ' <<<"$1" >/dev/null
}

assert_nondestructive_operations() {
  jq -e '
    [
      "GetMessage",
      "GetMessages",
      "GetMessageRead",
      "GetMessageWrite",
      "UpdateMessage",
      "DeleteMessage",
      "DeleteMessages",
      "ClearMessages"
    ] as $expected
    | ((keys | sort) == ($expected | sort))
    and all(.[]; (tonumber) == 0)
  ' <<<"$1" >/dev/null
}

assert_exception_correlation() {
  jq -e '
    .expectedOperationId as $operationId
    | .verifyStart as $verifyStart
    | ($operationId | type == "string" and length == 32)
    and .request.operationId == $operationId
    and .request.timeGenerated >= $verifyStart
    and .request.success == false
    and (.request.httpStatus | tonumber) >= 400
    and (.request.httpStatus | tonumber) < 600
    and any(
      .exceptions[];
      .operationId == $operationId
      and .timeGenerated >= $verifyStart
    )
  ' <<<"$1" >/dev/null
}

run_self_tests() {
  local failures=0
  local evidence
  local target_in_first_page

  for retained_count in 1 32 33 40; do
    if ((retained_count <= 32)); then
      target_in_first_page=true
    else
      target_in_first_page=false
    fi
    evidence=$(jq -nc \
      --argjson retained "$retained_count" \
      --argjson targetInFirstPage "$target_in_first_page" '
      {
        retainedMessageCount: $retained,
        firstPeekRequestIds: (
          if $targetInFirstPage
          then ([range(0; ($retained - 1)) | "old-\(.)"] + ["request-new"])
          else [range(0; 32) | "old-\(.)"]
          end
        ),
        response: {
          request_id: "request-new",
          just_enqueued: {message_id: "message-new"}
        },
        postgres: {request_id: "request-new"},
        request: {operationId: "operation-new"},
        dependency: {
          operationId: "operation-new",
          clientRequestId: "client-new",
          success: true,
          resultCode: "201"
        },
        storage: {
          clientRequestId: "client-new",
          objectKey: "/account/requests/message-new",
          authenticationType: "OAuth",
          statusCode: "201"
        }
      }')
    if assert_queue_correlation "$evidence"; then
      printf 'SELF_TEST_CASE_OK retained=%s target_in_first_32=%s\n' \
        "$retained_count" "$target_in_first_page"
    else
      printf 'SELF_TEST_CASE_FAIL retained=%s target_in_first_32=%s\n' \
        "$retained_count" "$target_in_first_page"
      failures=$((failures + 1))
    fi
  done
  bad_correlation=$(jq -c \
    '.storage.objectKey = "/account/requests/wrong-message"' \
    <<<"$evidence")
  if assert_queue_correlation "$bad_correlation"; then
    printf 'SELF_TEST_CORRELATION_FAIL accepted_wrong_message=true\n'
    failures=$((failures + 1))
  fi

  isolation='{"rowsBefore":10,"rowsAfter":10,"queueBefore":4,"queueAfter":4,"queueAfterSamples":[4,4,4]}'
  if ! assert_invalid_isolation "$isolation"; then
    printf 'SELF_TEST_DIRECT_ISOLATION_FAIL rejected_equal_counts=true\n'
    failures=$((failures + 1))
  else
    printf 'SELF_TEST_DIRECT_ISOLATION_OK queue=4->4 rows=10->10 samples=3\n'
  fi
  for isolation in \
    '{"rowsBefore":10,"rowsAfter":11,"queueBefore":4,"queueAfter":4,"queueAfterSamples":[4,4,4]}' \
    '{"rowsBefore":10,"rowsAfter":10,"queueBefore":4,"queueAfter":5,"queueAfterSamples":[5,5,5]}'; do
    if assert_invalid_isolation "$isolation"; then
      printf 'SELF_TEST_ISOLATION_FAIL accepted_nonzero_delta=%s\n' "$isolation"
      failures=$((failures + 1))
    fi
  done

  operation_names=(
    GetMessage
    GetMessages
    GetMessageRead
    GetMessageWrite
    UpdateMessage
    DeleteMessage
    DeleteMessages
    ClearMessages
  )
  zero_operations=$(jq -nc '{
    GetMessage: 0,
    GetMessages: 0,
    GetMessageRead: 0,
    GetMessageWrite: 0,
    UpdateMessage: 0,
    DeleteMessage: 0,
    DeleteMessages: 0,
    ClearMessages: 0
  }')
  assert_nondestructive_operations "$zero_operations" ||
    failures=$((failures + 1))
  for operation_name in "${operation_names[@]}"; do
    nonzero_operations=$(jq -c --arg operation "$operation_name" \
      '.[$operation] = 1' <<<"$zero_operations")
    if assert_nondestructive_operations "$nonzero_operations"; then
      printf 'SELF_TEST_DESTRUCTIVE_FAIL accepted_nonzero_operation=%s\n' \
        "$operation_name"
      failures=$((failures + 1))
    else
      printf 'SELF_TEST_DESTRUCTIVE_OK operation=%s rejected_nonzero=true\n' \
        "$operation_name"
    fi
  done

  exception='{
    "verifyStart":"2026-07-26T06:00:00Z",
    "expectedOperationId":"11111111111111111111111111111111",
    "request":{"operationId":"11111111111111111111111111111111","timeGenerated":"2026-07-26T06:00:01Z","success":false,"httpStatus":"503"},
    "exceptions":[{"operationId":"11111111111111111111111111111111","timeGenerated":"2026-07-26T06:00:02Z"}]
  }'
  assert_exception_correlation "$exception" || failures=$((failures + 1))
  exception='{
    "verifyStart":"2026-07-26T06:00:00Z",
    "expectedOperationId":"11111111111111111111111111111111",
    "request":{"operationId":"11111111111111111111111111111111","timeGenerated":"2026-07-26T06:00:01Z","success":false,"httpStatus":"503"},
    "exceptions":[{"operationId":"22222222222222222222222222222222","timeGenerated":"2026-07-26T06:00:02Z"}]
  }'
  if assert_exception_correlation "$exception"; then
    printf 'SELF_TEST_EXCEPTION_FAIL accepted_unrelated_operation=true\n'
    failures=$((failures + 1))
  fi
  exception='{
    "verifyStart":"2026-07-26T06:00:00Z",
    "expectedOperationId":"11111111111111111111111111111111",
    "request":{"operationId":"11111111111111111111111111111111","timeGenerated":"2026-07-26T06:00:01Z","success":false,"httpStatus":"503"},
    "exceptions":[{"operationId":"11111111111111111111111111111111","timeGenerated":"2026-07-26T05:59:59Z"}]
  }'
  if assert_exception_correlation "$exception"; then
    printf 'SELF_TEST_EXCEPTION_FAIL accepted_stale_exception=true\n'
    failures=$((failures + 1))
  fi

  if ((failures > 0)); then
    printf 'VERIFY_SELF_TEST_FAIL failures=%s\n' "$failures" >&2
    return 1
  fi
  printf 'VERIFY_SELF_TEST_OK retained_cases=1,32,33,40 isolation=direct-counts destructive_operations=8 exception=correlated\n'
}

if [[ "${1:-}" == '--self-test' ]]; then
  run_self_tests
  exit
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/preflight.sh"

readonly ENVIRONMENT_NAME='cae-ahm-movie-demo'
readonly VNET_NAME='vnet-ahm-movie-demo'
readonly INFRASTRUCTURE_SUBNET_NAME='snet-container-apps'
readonly PRIVATE_ENDPOINT_SUBNET_NAME='snet-private-endpoints'
readonly QUEUE_PRIVATE_ENDPOINT_NAME='pe-ahm-movie-demo-queue'
readonly QUEUE_PRIVATE_DNS_ZONE='privatelink.queue.core.windows.net'
readonly QUEUE_PRIVATE_DNS_LINK_NAME='link-vnet-ahm-movie-demo'
readonly QUEUE_DNS_ZONE_GROUP_NAME='default'
readonly HEALTH_REPORT_ROLE_NAME='AHM Demo Health Report Operator'
readonly HEALTH_REPORT_ROLE_GUID='b2dde5f8-a8ae-5896-90d9-09c87b55c8f8'
readonly HEALTH_REPORT_SIGNAL='web-ui-health-report'
readonly RESERVED_REPORT_SIGNAL='database-connectivity-probe'
readonly COPILOT_APP_NAME='app-ahm-health-copilot'
readonly AI_ACCOUNT_NAME=${AZURE_OPENAI_ACCOUNT_NAME:-oai-ahm-movie-demo}
readonly AI_DEPLOYMENT_NAME=${AZURE_OPENAI_DEPLOYMENT_NAME:-gpt-54-mini}
VERIFY_START_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
require_command script

resources_json=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/resourceGroups/$RG/resources?api-version=2021-04-01" \
  --output json |
  jq -c '.value')

require_one_type() {
  local type=$1
  local count
  count=$(jq --arg type "$type" '
    [.[] | select((.type | ascii_downcase) == ($type | ascii_downcase))] | length
  ' <<<"$resources_json")
  [[ "$count" == '1' ]] || {
    printf 'VERIFY_FAIL expected one %s; found %s\n' "$type" "$count" >&2
    exit 1
  }
}

for type in \
  Microsoft.App/managedEnvironments \
  Microsoft.Storage/storageAccounts \
  Microsoft.DBforPostgreSQL/flexibleServers \
  Microsoft.ManagedIdentity/userAssignedIdentities \
  Microsoft.ContainerRegistry/registries \
  Microsoft.OperationalInsights/workspaces \
  Microsoft.Insights/components \
  Microsoft.CloudHealth/healthModels \
  Microsoft.Network/virtualNetworks \
  Microsoft.Network/privateEndpoints \
  Microsoft.Network/privateDnsZones; do
  require_one_type "$type"
done

resource_by_type() {
  jq -er --arg type "$1" '
    .[] | select((.type | ascii_downcase) == ($type | ascii_downcase))
  ' <<<"$resources_json"
}

resource_by_type_and_name() {
  jq -er --arg type "$1" --arg name "$2" '
    .[]
    | select((.type | ascii_downcase) == ($type | ascii_downcase))
    | select(.name == $name)
  ' <<<"$resources_json"
}

app_summary=$(resource_by_type_and_name Microsoft.App/containerApps app-ahm-movie-demo)
environment_summary=$(resource_by_type Microsoft.App/managedEnvironments)
storage_summary=$(resource_by_type Microsoft.Storage/storageAccounts)
postgres_summary=$(resource_by_type Microsoft.DBforPostgreSQL/flexibleServers)
identity_summary=$(resource_by_type Microsoft.ManagedIdentity/userAssignedIdentities)
registry_summary=$(resource_by_type Microsoft.ContainerRegistry/registries)
workspace_summary=$(resource_by_type Microsoft.OperationalInsights/workspaces)
appinsights_summary=$(resource_by_type Microsoft.Insights/components)
vnet_summary=$(resource_by_type Microsoft.Network/virtualNetworks)
private_endpoint_summary=$(resource_by_type Microsoft.Network/privateEndpoints)
private_dns_zone_summary=$(resource_by_type Microsoft.Network/privateDnsZones)

APP_ID=$(jq -er '.id' <<<"$app_summary")
APP_NAME=$(jq -er '.name' <<<"$app_summary")
ENVIRONMENT_ID=$(jq -er '.id' <<<"$environment_summary")
actual_environment_name=$(jq -er '.name' <<<"$environment_summary")
STORAGE_ID=$(jq -er '.id' <<<"$storage_summary")
STORAGE_NAME=$(jq -er '.name' <<<"$storage_summary")
PG_ID=$(jq -er '.id' <<<"$postgres_summary")
PG_NAME=$(jq -er '.name' <<<"$postgres_summary")
IDENTITY_ID=$(jq -er '.id' <<<"$identity_summary")
IDENTITY_NAME=$(jq -er '.name' <<<"$identity_summary")
ACR_NAME=$(jq -er '.name' <<<"$registry_summary")
LAW_ID=$(jq -er '.id' <<<"$workspace_summary")
APPINSIGHTS_ID=$(jq -er '.id' <<<"$appinsights_summary")
VNET_ID=$(jq -er '.id' <<<"$vnet_summary")
actual_vnet_name=$(jq -er '.name' <<<"$vnet_summary")
QUEUE_PRIVATE_ENDPOINT_ID=$(jq -er '.id' <<<"$private_endpoint_summary")
actual_private_endpoint_name=$(jq -er '.name' <<<"$private_endpoint_summary")
QUEUE_PRIVATE_DNS_ZONE_ID=$(jq -er '.id' <<<"$private_dns_zone_summary")
actual_private_dns_zone_name=$(jq -er '.name' <<<"$private_dns_zone_summary")
if [[ "$DEPLOY_COPILOT" == 'true' ]]; then
  copilot_summary=$(resource_by_type_and_name \
    Microsoft.App/containerApps "$COPILOT_APP_NAME")
  ai_account_summary=$(resource_by_type_and_name \
    Microsoft.CognitiveServices/accounts "$AI_ACCOUNT_NAME")
  COPILOT_APP_ID=$(jq -er '.id' <<<"$copilot_summary")
  AI_ACCOUNT_ID=$(jq -er '.id' <<<"$ai_account_summary")
fi
QUEUE_ID="$STORAGE_ID/queueServices/default/queues/requests"
MODEL_ID="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.CloudHealth/healthmodels/$MODEL"
HEALTH_REPORT_ROLE_ID="/subscriptions/$SUB_ID/providers/Microsoft.Authorization/roleDefinitions/$HEALTH_REPORT_ROLE_GUID"
EXPECTED_INFRASTRUCTURE_SUBNET_ID="$VNET_ID/subnets/$INFRASTRUCTURE_SUBNET_NAME"
EXPECTED_PRIVATE_ENDPOINT_SUBNET_ID="$VNET_ID/subnets/$PRIVATE_ENDPOINT_SUBNET_NAME"

[[ "$actual_environment_name" == "$ENVIRONMENT_NAME" ]]
[[ "$actual_vnet_name" == "$VNET_NAME" ]]
[[ "$actual_private_endpoint_name" == "$QUEUE_PRIVATE_ENDPOINT_NAME" ]]
[[ "$actual_private_dns_zone_name" == "$QUEUE_PRIVATE_DNS_ZONE" ]]

az resource show \
  --ids "$QUEUE_ID" \
  --subscription "$SUB_ID" \
  --api-version 2023-05-01 \
  --output none
printf 'INVENTORY_OK expected_task_top_level=12 queue=%s network=%s,%s,%s preserved_other_resources=true\n' \
  "$QUEUE_ID" "$VNET_NAME" "$QUEUE_PRIVATE_ENDPOINT_NAME" "$QUEUE_PRIVATE_DNS_ZONE"

environment_json=$(az containerapp env show \
  --name "$ENVIRONMENT_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg environmentId "$ENVIRONMENT_ID" \
  --arg subnetId "$EXPECTED_INFRASTRUCTURE_SUBNET_ID" '
    (.id | ascii_downcase) == ($environmentId | ascii_downcase)
    and (.properties.vnetConfiguration.infrastructureSubnetId | ascii_downcase) ==
      ($subnetId | ascii_downcase)
    and .properties.vnetConfiguration.internal == false
    and .properties.environmentMode == "ConsumptionOnly"
    and .properties.provisioningState == "Succeeded"
  ' <<<"$environment_json" >/dev/null || {
  printf 'VERIFY_FAIL environment is not attached to the exact correction subnet\n' >&2
  exit 1
}

vnet_json=$(az network vnet show \
  --name "$VNET_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg vnetId "$VNET_ID" \
  --arg infraName "$INFRASTRUCTURE_SUBNET_NAME" \
  --arg endpointName "$PRIVATE_ENDPOINT_SUBNET_NAME" '
    (.id | ascii_downcase) == ($vnetId | ascii_downcase)
    and (.addressSpace.addressPrefixes == ["10.42.0.0/22"])
    and any(
      .subnets[];
      .name == $infraName
      and .addressPrefix == "10.42.0.0/23"
      and ((.delegations // []) | length == 0)
    )
    and any(
      .subnets[];
      .name == $endpointName
      and .addressPrefix == "10.42.2.0/29"
      and .privateEndpointNetworkPolicies == "Disabled"
      and ((.delegations // []) | length == 0)
    )
  ' <<<"$vnet_json" >/dev/null || {
  printf 'VERIFY_FAIL correction VNet/subnet boundary does not match the consumption-only design\n' >&2
  exit 1
}

private_endpoint_json=$(az network private-endpoint show \
  --name "$QUEUE_PRIVATE_ENDPOINT_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg endpointId "$QUEUE_PRIVATE_ENDPOINT_ID" \
  --arg subnetId "$EXPECTED_PRIVATE_ENDPOINT_SUBNET_ID" \
  --arg storageId "$STORAGE_ID" '
    (.id | ascii_downcase) == ($endpointId | ascii_downcase)
    and (.subnet.id | ascii_downcase) == ($subnetId | ascii_downcase)
    and .provisioningState == "Succeeded"
    and any(
      .privateLinkServiceConnections[];
      (.privateLinkServiceId | ascii_downcase) == ($storageId | ascii_downcase)
      and .groupIds == ["queue"]
      and .privateLinkServiceConnectionState.status == "Approved"
    )
  ' <<<"$private_endpoint_json" >/dev/null || {
  printf 'VERIFY_FAIL Queue private endpoint is not Approved/Succeeded\n' >&2
  exit 1
}

private_endpoint_nic_id=$(jq -er '.networkInterfaces[0].id' <<<"$private_endpoint_json")
private_endpoint_nic_json=$(az network nic show \
  --ids "$private_endpoint_nic_id" \
  --subscription "$SUB_ID" \
  --output json)
QUEUE_PRIVATE_IP=$(jq -er '.ipConfigurations[0].privateIPAddress' <<<"$private_endpoint_nic_json")

private_dns_link_json=$(az network private-dns link vnet show \
  --name "$QUEUE_PRIVATE_DNS_LINK_NAME" \
  --resource-group "$RG" \
  --zone-name "$QUEUE_PRIVATE_DNS_ZONE" \
  --subscription "$SUB_ID" \
  --output json)
jq -e --arg vnetId "$VNET_ID" '
  (.virtualNetwork.id | ascii_downcase) == ($vnetId | ascii_downcase)
  and .registrationEnabled == false
  and .provisioningState == "Succeeded"
' <<<"$private_dns_link_json" >/dev/null

dns_zone_group_json=$(az network private-endpoint dns-zone-group show \
  --endpoint-name "$QUEUE_PRIVATE_ENDPOINT_NAME" \
  --name "$QUEUE_DNS_ZONE_GROUP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e --arg zoneId "$QUEUE_PRIVATE_DNS_ZONE_ID" '
  any(
    .privateDnsZoneConfigs[];
    (.privateDnsZoneId | ascii_downcase) == ($zoneId | ascii_downcase)
  )
' <<<"$dns_zone_group_json" >/dev/null

dns_record_json=$(az network private-dns record-set a show \
  --name "$STORAGE_NAME" \
  --resource-group "$RG" \
  --zone-name "$QUEUE_PRIVATE_DNS_ZONE" \
  --subscription "$SUB_ID" \
  --output json)
jq -e --arg privateIp "$QUEUE_PRIVATE_IP" '
  any((.aRecords // .arecords // [])[]; .ipv4Address == $privateIp)
' <<<"$dns_record_json" >/dev/null || {
  printf 'VERIFY_FAIL Queue private DNS A record does not equal the private endpoint IP\n' >&2
  exit 1
}
printf 'PRIVATE_NETWORK_OK environment_subnet=%s endpoint=Approved/Succeeded dns=%s->%s link=Succeeded\n' \
  "$EXPECTED_INFRASTRUCTURE_SUBNET_ID" "$STORAGE_NAME" "$QUEUE_PRIVATE_IP"

identity_json=$(az identity show \
  --name "$IDENTITY_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
UAMI_OBJECT_ID=$(jq -er '.principalId' <<<"$identity_json")
UAMI_CLIENT_ID=$(jq -er '.clientId' <<<"$identity_json")

storage_json=$(az storage account show \
  --name "$STORAGE_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e '
  .allowSharedKeyAccess == false
  and .defaultToOAuthAuthentication == true
  and .minimumTlsVersion == "TLS1_2"
  and .publicNetworkAccess == "Disabled"
' <<<"$storage_json" >/dev/null
printf 'STORAGE_NETWORK_OK publicNetworkAccess=Disabled shared_key=false oauth_default=true\n'

queue_roles=$(az role assignment list \
  --assignee-object-id "$UAMI_OBJECT_ID" \
  --scope "$QUEUE_ID" \
  --subscription "$SUB_ID" \
  --output json)
jq -e 'any(.[]; .roleDefinitionName == "Storage Queue Data Contributor")' \
  <<<"$queue_roles" >/dev/null

app_json=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg identity "$IDENTITY_ID" \
  --arg environmentId "$ENVIRONMENT_ID" \
  --arg queueUrl "https://$STORAGE_NAME.queue.core.windows.net/requests" \
  --arg subscriptionId "$SUB_ID" \
  --arg subscriptionName "$SUB_NAME" \
  --arg resourceGroup "$RG" \
  --arg healthModelName "$MODEL" \
  --arg healthModelLocation "$HEALTH_MODEL_LOCATION" '
  (.identity.type == "UserAssigned")
  and (.properties.environmentId | ascii_downcase) == ($environmentId | ascii_downcase)
  and any(
    .identity.userAssignedIdentities | keys[];
    (ascii_downcase == ($identity | ascii_downcase))
  )
  and ((.properties.configuration.secrets // []) | length == 0)
  and .properties.configuration.ingress.external == true
  and (.properties.template.containers[0].image | test("@sha256:[0-9a-f]{64}$"))
  and any(.properties.template.containers[0].env[]; .name == "QUEUE_URL" and .value == $queueUrl)
  and any(.properties.template.containers[0].env[]; .name == "AZURE_SUBSCRIPTION_ID" and .value == $subscriptionId)
  and any(.properties.template.containers[0].env[]; .name == "AZURE_SUBSCRIPTION_NAME" and .value == $subscriptionName)
  and any(.properties.template.containers[0].env[]; .name == "AZURE_RESOURCE_GROUP" and .value == $resourceGroup)
  and any(.properties.template.containers[0].env[]; .name == "HEALTH_MODEL_NAME" and .value == $healthModelName)
  and any(.properties.template.containers[0].env[]; .name == "HEALTH_MODEL_LOCATION" and .value == $healthModelLocation)
  and all(
    .properties.template.containers[0].env[];
    (.name | test("PASSWORD|ACCOUNT_KEY|SAS|STORAGE_CONNECTION"; "i") | not)
    and (has("secretRef") | not)
    and .name != "COPILOT_URL"
  )
' <<<"$app_json" >/dev/null
APP_FQDN=$(jq -er '.properties.configuration.ingress.fqdn' <<<"$app_json")
revisions_json=$(az containerapp revision list \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e 'any(
  .[];
  .properties.active == true
  and (.properties.provisioningState == "Succeeded" or .properties.provisioningState == "Provisioned")
  and .properties.healthState == "Healthy"
)' <<<"$revisions_json" >/dev/null
printf 'QUEUE_IDENTITY_OK shared_key=false role=StorageQueueDataContributor secrets=0 revision=Healthy\n'

if [[ "$DEPLOY_COPILOT" == 'true' ]]; then
ai_account_json=$(az resource show \
  --ids "$AI_ACCOUNT_ID" \
  --api-version 2024-10-01 \
  --subscription "$SUB_ID" \
  --output json)
jq -e '
  .kind == "OpenAI"
  and .properties.disableLocalAuth == true
  and .properties.publicNetworkAccess == "Enabled"
' <<<"$ai_account_json" >/dev/null
ai_deployment_json=$(az resource show \
  --ids "$AI_ACCOUNT_ID/deployments/$AI_DEPLOYMENT_NAME" \
  --api-version 2024-10-01 \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg model "$AZURE_OPENAI_MODEL_NAME" \
  --arg version "$AZURE_OPENAI_MODEL_VERSION" \
  --arg sku "$AZURE_OPENAI_DEPLOYMENT_SKU" '
    .properties.model.name == $model
    and .properties.model.version == $version
    and .sku.name == $sku
  ' <<<"$ai_deployment_json" >/dev/null
inference_roles=$(az role assignment list \
  --assignee-object-id "$UAMI_OBJECT_ID" \
  --scope "$AI_ACCOUNT_ID" \
  --subscription "$SUB_ID" \
  --output json)
jq -e '
  length == 1
  and .[0].roleDefinitionName == "Cognitive Services OpenAI User"
' <<<"$inference_roles" >/dev/null

copilot_json=$(az containerapp show \
  --name "$COPILOT_APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg identity "$IDENTITY_ID" \
  --arg environmentId "$ENVIRONMENT_ID" \
  --arg deployment "$AI_DEPLOYMENT_NAME" \
  --arg healthUrl "https://$APP_FQDN" '
    (.identity.type == "UserAssigned")
    and (.properties.environmentId | ascii_downcase) == ($environmentId | ascii_downcase)
    and any(
      .identity.userAssignedIdentities | keys[];
      (ascii_downcase == ($identity | ascii_downcase))
    )
    and ((.properties.configuration.secrets // []) | length == 0)
    and .properties.configuration.ingress.external == true
    and (.properties.template.containers | length) == 2
    and all(
      .properties.template.containers[];
      (.image | test("@sha256:[0-9a-f]{64}$"))
      and all(
        .env[];
        (.name | test("API_KEY|PASSWORD|TOKEN|SECRET"; "i") | not)
        and (has("secretRef") | not)
      )
    )
    and any(
      .properties.template.containers[];
      .name == "agent"
      and any(.env[]; .name == "AZURE_OPENAI_CHAT_DEPLOYMENT_NAME" and .value == $deployment)
      and any(.env[]; .name == "HEALTH_APP_BASE_URL" and .value == $healthUrl)
    )
  ' <<<"$copilot_json" >/dev/null
COPILOT_FQDN=$(jq -er '.properties.configuration.ingress.fqdn' <<<"$copilot_json")
copilot_revisions_json=$(az containerapp revision list \
  --name "$COPILOT_APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e 'any(
  .[];
  .properties.active == true
  and (.properties.provisioningState == "Succeeded" or .properties.provisioningState == "Provisioned")
  and .properties.healthState == "Healthy"
)' <<<"$copilot_revisions_json" >/dev/null
curl --fail --silent --show-error "https://$COPILOT_FQDN/health" |
  jq -e '.status == "ok" and .component == "health-copilot-web"' >/dev/null
printf 'COPILOT_IDENTITY_OK account=OpenAI local_auth=false role=OpenAIUser secrets=0 revision=Healthy\n'
fi

health_report_role_json=$(az role definition list \
  --name "$HEALTH_REPORT_ROLE_GUID" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg id "$HEALTH_REPORT_ROLE_ID" \
  --arg name "$HEALTH_REPORT_ROLE_NAME" \
  --arg scope "/subscriptions/$SUB_ID/resourceGroups/$RG" '
    length == 1
    and (.[0].id | ascii_downcase) == ($id | ascii_downcase)
    and .[0].roleName == $name
    and .[0].roleType == "CustomRole"
    and (.[0].assignableScopes | map(ascii_downcase)) == [($scope | ascii_downcase)]
    and (.[0].permissions | length) == 1
    and (.[0].permissions[0].actions | sort) == ([
      "Microsoft.CloudHealth/healthmodels/read",
      "Microsoft.CloudHealth/healthmodels/entities/read",
      "Microsoft.CloudHealth/healthmodels/relationships/read",
      "Microsoft.CloudHealth/healthmodels/entities/getHistory/action",
      "Microsoft.CloudHealth/healthmodels/entities/getSignalHistory/action",
      "Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action"
    ] | sort)
    and .[0].permissions[0].notActions == []
    and .[0].permissions[0].dataActions == []
    and .[0].permissions[0].notDataActions == []
    and all(.[0].permissions[0].actions[]; contains("*") | not)
  ' <<<"$health_report_role_json" >/dev/null || {
  printf 'VERIFY_FAIL Health Report custom role is not the exact six-Action role\n' >&2
  exit 1
}

health_report_assignments=$(az role assignment list \
  --assignee-object-id "$UAMI_OBJECT_ID" \
  --scope "$MODEL_ID" \
  --subscription "$SUB_ID" \
  --output json)
jq -e \
  --arg role "$HEALTH_REPORT_ROLE_ID" \
  --arg scope "$MODEL_ID" \
  --arg principal "$UAMI_OBJECT_ID" '
    [.[] | select((.roleDefinitionId | ascii_downcase) == ($role | ascii_downcase))] as $matches
    | ($matches | length) == 1
    and ($matches[0].scope | ascii_downcase) == ($scope | ascii_downcase)
    and $matches[0].principalId == $principal
    and $matches[0].principalType == "ServicePrincipal"
  ' <<<"$health_report_assignments" >/dev/null || {
  printf 'VERIFY_FAIL Health Report role assignment is not exact-model scoped\n' >&2
  exit 1
}
printf 'HEALTH_REPORT_RBAC_OK actions=6 data_actions=0 wildcards=0 assignment_scope=%s\n' \
  "$MODEL_ID"

public_queue_result=$(curl \
  --silent \
  --show-error \
  --output - \
  --write-out $'\n%{http_code}' \
  "https://$STORAGE_NAME.queue.core.windows.net/requests?comp=metadata")
public_queue_status=${public_queue_result##*$'\n'}
public_queue_body=${public_queue_result%$'\n'*}
[[ "$public_queue_status" == '403' ]]
[[ "$public_queue_body" == *'<Code>'* ]]
printf 'PUBLIC_QUEUE_DENIED_OK credentials=none http_status=%s publicNetworkAccess=Disabled\n' \
  "$public_queue_status"

servers_json=$(az postgres flexible-server list \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
PG_HOST=$(jq -er --arg name "$PG_NAME" '
  .[] | select(.name == $name) | .fullyQualifiedDomainName
' <<<"$servers_json")

token_json=$(az account get-access-token \
  --subscription "$SUB_ID" \
  --resource-type oss-rdbms \
  --output json)
PGPASSWORD=$(jq -er '.accessToken' <<<"$token_json")
export PGPASSWORD
trap 'unset PGPASSWORD token_json' EXIT
export PGHOST="$PG_HOST"
export PGPORT=5432
export PGUSER="$ADMIN_UPN"
export PGSSLMODE=require

principal_map=$(PGDATABASE=postgres psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT coalesce(json_agg(p), '\''[]'\''::json) FROM pgaadauth_list_principals(false) AS p')
jq -e --arg oid "$UAMI_OBJECT_ID" --arg name "$IDENTITY_NAME" '
  any(.[]; ([.. | scalars | tostring] | index($oid)) != null
    and ([.. | scalars | tostring] | index($name)) != null
    and ([.. | scalars | tostring | ascii_downcase] | index("service")) != null)
' <<<"$principal_map" >/dev/null

grant_json=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --set=uami_name="$IDENTITY_NAME" <<'SQL'
SELECT json_build_object(
    'connect', has_database_privilege(:'uami_name', 'demo', 'CONNECT'),
    'usage', has_schema_privilege(:'uami_name', 'public', 'USAGE'),
    'select', has_table_privilege(:'uami_name', 'public.request_events', 'SELECT'),
    'insert', has_table_privilege(:'uami_name', 'public.request_events', 'INSERT'),
    'update', has_table_privilege(:'uami_name', 'public.request_events', 'UPDATE'),
    'delete', has_table_privilege(:'uami_name', 'public.request_events', 'DELETE'),
    'create', has_schema_privilege(:'uami_name', 'public', 'CREATE')
  );
SQL
)
jq -e '
  .connect and .usage and .select and .insert
  and (.update | not) and (.delete | not) and (.create | not)
' <<<"$grant_json" >/dev/null
printf 'POSTGRES_IDENTITY_OK oid=%s type=service grants=CONNECT,USAGE,SELECT,INSERT\n' \
  "$UAMI_OBJECT_ID"

workspace_json=$(az monitor log-analytics workspace show \
  --resource-group "$RG" \
  --workspace-name "$(jq -er '.name' <<<"$workspace_summary")" \
  --subscription "$SUB_ID" \
  --output json)
LAW_CUSTOMER_ID=$(jq -er '.customerId' <<<"$workspace_json")

containerapp_python_probe() {
  local encoded_probe=$1
  local marker=$2
  local probe_output=''
  local probe_json=''
  local probe_status=1
  local active_revision
  local active_replica
  local warmup_attempted=false

  for _ in $(seq 1 20); do
    set +e
    active_revision=$(az containerapp revision list \
      --name "$APP_NAME" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --output json 2>/dev/null |
      jq -er '.[] | select(.properties.active == true) | .name')
    revision_status=$?
    active_replica=''
    if [[ "$revision_status" == '0' ]]; then
      active_replica=$(az containerapp replica list \
        --name "$APP_NAME" \
        --resource-group "$RG" \
        --revision "$active_revision" \
        --subscription "$SUB_ID" \
        --output json 2>/dev/null |
        jq -er '.[0].name')
      replica_status=$?
    else
      replica_status=1
    fi
    if [[ "$revision_status" != '0' || "$replica_status" != '0' ]]; then
      set -e
      if [[ "$warmup_attempted" == false ]]; then
        warmup_status=$(curl \
          --silent \
          --show-error \
          --max-time 180 \
          --output /dev/null \
          --write-out '%{http_code}' \
          "https://$APP_FQDN/?format=invalid&verification_phase=queue-count-warmup")
        [[ "$warmup_status" == '503' ]] || {
          printf 'VERIFY_FAIL Queue-count warmup returned HTTP %s\n' \
            "$warmup_status" >&2
          return 1
        }
        warmup_attempted=true
        printf 'QUEUE_COUNT_WARMUP_OK status=503 writes=outside-measured-window\n' >&2
      fi
      sleep 15
      continue
    fi
    probe_output=$(script -q /dev/null \
      az containerapp exec \
        --name "$APP_NAME" \
        --resource-group "$RG" \
        --revision "$active_revision" \
        --replica "$active_replica" \
        --subscription "$SUB_ID" \
        --command "python -c exec(__import__('base64').b64decode('$encoded_probe'))" \
      2>&1)
    probe_status=$?
    set -e
    if [[ "$probe_status" == '0' && "$probe_output" == *"$marker="* ]]; then
      probe_json=$(PROBE_MARKER="$marker" python3 -c '
import os
import re
import sys
marker = re.escape(os.environ["PROBE_MARKER"])
match = re.search(marker + r"=(\{[^\r\n]*\})", sys.stdin.read())
if match is None:
    raise SystemExit(1)
print(match.group(1))
' <<<"$probe_output")
      if jq -e . <<<"$probe_json" >/dev/null; then
        printf '%s\n' "$probe_json"
        return 0
      fi
    fi
    sleep 15
  done

  printf 'VERIFY_FAIL Container App Queue probe failed: %s\n' "$probe_output" >&2
  return 1
}

queue_count_probe() {
  local sample_count=$1
  local delay_seconds=$2
  local encoded_probe

  encoded_probe=$(python3 - "$sample_count" "$delay_seconds" <<'PY'
import base64
import sys

sample_count = int(sys.argv[1])
delay_seconds = int(sys.argv[2])
code = f'''import json,os,time
from azure.identity import ManagedIdentityCredential
from azure.storage.queue import QueueClient
q=QueueClient.from_queue_url(os.environ["QUEUE_URL"],credential=ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"]))
c=[]
for i in range({sample_count}):
 c.append(q.get_queue_properties().approximate_message_count)
 if i+1<{sample_count}: time.sleep({delay_seconds})
print("QUEUE_COUNT_JSON="+json.dumps({{"counts":c}},separators=(",",":")))
'''
print(base64.b64encode(code.encode()).decode())
PY
  )
  containerapp_python_probe "$encoded_probe" 'QUEUE_COUNT_JSON'
}

queue_probe() {
  local encoded_probe

  encoded_probe=$(python3 - <<'PY'
import base64

code = f'''import json,socket
from urllib.parse import urlparse
from app import QUEUE_URL,queue_client as q
def s(m):
 c=json.loads(m.content);return {{"message_id":m.id,"request_id":c.get("request_id"),"dequeue_count":m.dequeue_count}}
a=[s(m) for m in q.peek_messages(max_messages=1)]
b=[s(m) for m in q.peek_messages(max_messages=1)]
h=urlparse(QUEUE_URL).hostname
o={{"retained_message_count":q.get_queue_properties().approximate_message_count,"dns_ips":sorted({{x[4][0] for x in socket.getaddrinfo(h,443,socket.AF_INET,socket.SOCK_STREAM)}}),"first_head":a[0] if a else None,"second_head":b[0] if b else None}}
print("QUEUE_PROBE_JSON="+json.dumps(o,separators=(",",":"),sort_keys=True))
'''
print(base64.b64encode(code.encode()).decode())
PY
  )
  containerapp_python_probe "$encoded_probe" 'QUEUE_PROBE_JSON'
}

sdk_probe_encoded=$(python3 - <<'PY'
import base64

code = '''import json,os
from azure.identity import ManagedIdentityCredential
from azure.mgmt.cloudhealth import CloudHealthMgmtClient,__version__
c=CloudHealthMgmtClient(
 ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"]),
 os.environ["AZURE_SUBSCRIPTION_ID"],
 api_version="2026-05-01-preview")
m=c.health_models.get(os.environ["AZURE_RESOURCE_GROUP"],os.environ["HEALTH_MODEL_NAME"])
print("CLOUDHEALTH_SDK_JSON="+json.dumps({
 "version":__version__,
 "api_version":c._config.api_version,
 "model_name":m.name,
 "location":m.location},separators=(",",":")))
'''
print(base64.b64encode(code.encode()).decode())
PY
)
sdk_probe_json=$(containerapp_python_probe \
  "$sdk_probe_encoded" 'CLOUDHEALTH_SDK_JSON')
jq -e \
  --arg model "$MODEL" \
  --arg location "$HEALTH_MODEL_LOCATION" '
    .version == "1.0.0b3"
    and .api_version == "2026-05-01-preview"
    and .model_name == $model
    and (.location | ascii_downcase) == ($location | ascii_downcase)
  ' <<<"$sdk_probe_json" >/dev/null || {
  printf 'VERIFY_FAIL running CloudHealth SDK package/API/model probe\n' >&2
  exit 1
}
printf 'CLOUDHEALTH_SDK_OK package=azure-mgmt-cloudhealth version=1.0.0b3 api=2026-05-01-preview model=%s\n' \
  "$MODEL"

invalid_queue_before_json=$(queue_count_probe 2 1)
jq -e '
  (.counts | length == 2)
  and (.counts[0] == .counts[1])
' <<<"$invalid_queue_before_json" >/dev/null || {
  printf 'VERIFY_FAIL direct Queue baseline was not stable: %s\n' \
    "$(jq -c . <<<"$invalid_queue_before_json")" >&2
  exit 1
}
invalid_queue_before=$(jq -er '.counts[-1]' <<<"$invalid_queue_before_json")
invalid_rows_before=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT count(*) FROM request_events')
INVALID_START_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
invalid_result=$(curl \
  --silent \
  --show-error \
  --max-time 180 \
  --write-out $'\n%{http_code}' \
  "https://$APP_FQDN/?format=invalid")
invalid_status=${invalid_result##*$'\n'}
invalid_body=${invalid_result%$'\n'*}
INVALID_END_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
invalid_rows_after=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT count(*) FROM request_events')
invalid_queue_after_json=$(queue_count_probe 5 2)
invalid_queue_after=$(jq -er '.counts[-1]' <<<"$invalid_queue_after_json")
[[ "$invalid_status" == '503' ]]
[[ "$invalid_body" != *'Traceback'* ]]
jq -e '
  (.request_id | type == "string" and length == 36)
  and (.operation_id | type == "string" and length == 32)
  and .status == "failed"
  and .error == "ValueError"
' <<<"$invalid_body" >/dev/null
ERROR_REQUEST_ID=$(jq -er '.request_id' <<<"$invalid_body")
ERROR_OPERATION_ID=$(jq -er '.operation_id' <<<"$invalid_body")
invalid_isolation=$(jq -nc \
  --argjson rowsBefore "$invalid_rows_before" \
  --argjson rowsAfter "$invalid_rows_after" \
  --argjson queueBefore "$invalid_queue_before" \
  --argjson queueAfter "$invalid_queue_after" \
  --argjson queueAfterSamples "$(jq -c '.counts' <<<"$invalid_queue_after_json")" '{
    rowsBefore: $rowsBefore,
    rowsAfter: $rowsAfter,
    queueBefore: $queueBefore,
    queueAfter: $queueAfter,
    queueAfterSamples: $queueAfterSamples
  }')
assert_invalid_isolation "$invalid_isolation" || {
  printf 'VERIFY_FAIL invalid request changed direct data-plane counts: %s\n' \
    "$(jq -c . <<<"$invalid_isolation")" >&2
  exit 1
}
printf 'ERROR_REQUEST_OK invalid_format_status=%s request_id=%s operation_id=%s window=%s..%s\n' \
  "$invalid_status" "$ERROR_REQUEST_ID" "$ERROR_OPERATION_ID" \
  "$INVALID_START_UTC" "$INVALID_END_UTC"
printf 'INVALID_ISOLATION_OK status=%s operation_id=%s queue_messages=%s->%s queue_after_samples=%s rows=%s->%s oracle=QueueDataPlane+PostgreSQL writes=0\n' \
  "$invalid_status" "$ERROR_OPERATION_ID" \
  "$invalid_queue_before" "$invalid_queue_after" \
  "$(jq -c '.counts' <<<"$invalid_queue_after_json")" \
  "$invalid_rows_before" "$invalid_rows_after"

ui_queue_before=$invalid_queue_after
ui_rows_before=$invalid_rows_after
plain_root_result=$(curl \
  --silent \
  --show-error \
  --max-time 180 \
  --write-out $'\n%{http_code}' \
  "https://$APP_FQDN/")
plain_root_status=${plain_root_result##*$'\n'}
plain_root_body=${plain_root_result%$'\n'*}
[[ "$plain_root_status" == '200' ]]
[[ "$plain_root_body" == *'The Health Pulse'* ]]
[[ "$plain_root_body" == *'Public live-control surface'* ]]

root_headers=$(curl \
  --silent \
  --show-error \
  --head \
  --max-time 180 \
  "https://$APP_FQDN/")
root_headers_lower=$(tr '[:upper:]' '[:lower:]' <<<"$root_headers")
[[ "$root_headers_lower" == *"content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"* ]]
[[ "$root_headers_lower" == *'x-content-type-options: nosniff'* ]]
[[ "$root_headers_lower" == *'cache-control: no-store'* ]]
[[ "$root_headers_lower" != *'www-authenticate:'* ]]
[[ "$root_headers_lower" != *'set-cookie:'* ]]

public_model_json=$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 180 \
  "https://$APP_FQDN/api/health-model")
second_public_model_json=$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 180 \
  "https://$APP_FQDN/api/health-model")
public_detail_json=$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 180 \
  "https://$APP_FQDN/api/entities/$MODEL")
jq -e \
  --arg model "$MODEL" \
  --arg signal "$HEALTH_REPORT_SIGNAL" \
  --arg reserved "$RESERVED_REPORT_SIGNAL" '
    .model.name == $model
    and (.observedAt | type == "string")
    and (.entities | type == "array")
    and (.relationships | type == "array")
    and all(
      .entities[];
      if .healthState == "Deleted"
      then .report.eligible == false and .report.signalName == null
      else .report.eligible == true and .report.signalName == $signal
      end
    )
    and all(
      .entities[].signals[]?;
      if .name == $reserved then .writable == false else true end
    )
  ' <<<"$public_model_json" >/dev/null
jq -e --arg model "$MODEL" --arg signal "$HEALTH_REPORT_SIGNAL" '
  .entity.name == $model
  and .canonicalSignal.name == $signal
  and (.transitions | type == "array")
' <<<"$public_detail_json" >/dev/null
[[ "$(jq -S -c . <<<"$public_model_json")" != '' ]]
[[ "$(jq -r '.model.name' <<<"$second_public_model_json")" == "$MODEL" ]]

direct_entities_json=$(az monitor health-models entity list \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --subscription "$SUB_ID" \
  --output json)
direct_relationships_json=$(az monitor health-models relationship list \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --subscription "$SUB_ID" \
  --output json)
public_entity_names=$(jq -c '[.entities[].name] | sort' <<<"$public_model_json")
direct_entity_names=$(jq -c '[.[].name] | sort' <<<"$direct_entities_json")
public_relationships=$(jq -c '[
  .relationships[] |
  [.name, .parentEntityName, .childEntityName]
] | sort' <<<"$public_model_json")
direct_relationships=$(jq -c '[
  .[] |
  [.name, .properties.parentEntityName, .properties.childEntityName]
] | sort' <<<"$direct_relationships_json")
[[ "$public_entity_names" == "$direct_entity_names" ]]
[[ "$public_relationships" == "$direct_relationships" ]]

target_signal_before=$(az monitor health-models entity show \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name discovered-app-topology \
  --subscription "$SUB_ID" \
  --output json |
  jq --arg signal "$HEALTH_REPORT_SIGNAL" \
    '[.properties.signalGroups[]?.signals[]? | select(.name == $signal)] | length')
invalid_report_result=$(curl \
  --silent \
  --show-error \
  --max-time 180 \
  --header 'Content-Type: application/json' \
  --data "{\"signalName\":\"$HEALTH_REPORT_SIGNAL\",\"healthState\":\"Healthy\",\"value\":1,\"expiresInMinutes\":1,\"reasonPreset\":\"demo-test\",\"subscriptionId\":\"$SUB_ID\"}" \
  --write-out $'\n%{http_code}' \
  "https://$APP_FQDN/api/entities/discovered-app-topology/health-reports")
invalid_report_status=${invalid_report_result##*$'\n'}
invalid_report_body=${invalid_report_result%$'\n'*}
[[ "$invalid_report_status" == '400' ]]
jq -e '.error.code == "unknown_field"' <<<"$invalid_report_body" >/dev/null
target_signal_after=$(az monitor health-models entity show \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name discovered-app-topology \
  --subscription "$SUB_ID" \
  --output json |
  jq --arg signal "$HEALTH_REPORT_SIGNAL" \
    '[.properties.signalGroups[]?.signals[]? | select(.name == $signal)] | length')
[[ "$target_signal_before" == "$target_signal_after" ]]

ui_rows_after=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT count(*) FROM request_events')
ui_queue_after_json=$(queue_count_probe 5 2)
ui_queue_after=$(jq -er '.counts[-1]' <<<"$ui_queue_after_json")
ui_isolation=$(jq -nc \
  --argjson rowsBefore "$ui_rows_before" \
  --argjson rowsAfter "$ui_rows_after" \
  --argjson queueBefore "$ui_queue_before" \
  --argjson queueAfter "$ui_queue_after" \
  --argjson queueAfterSamples "$(jq -c '.counts' <<<"$ui_queue_after_json")" '{
    rowsBefore: $rowsBefore,
    rowsAfter: $rowsAfter,
    queueBefore: $queueBefore,
    queueAfter: $queueAfter,
    queueAfterSamples: $queueAfterSamples
  }')
assert_invalid_isolation "$ui_isolation" || {
  printf 'VERIFY_FAIL UI/status reads changed durable data: %s\n' \
    "$(jq -c . <<<"$ui_isolation")" >&2
  exit 1
}
printf 'PUBLIC_HEALTH_UI_OK auth=none app_limits=none repeated_reads=2 entities=%s relationships=%s risk=visible\n' \
  "$(jq '.entities | length' <<<"$public_model_json")" \
  "$(jq '.relationships | length' <<<"$public_model_json")"
printf 'LIVE_SET_EQUALITY_OK entities=%s relationships=%s hardcoded_count=false\n' \
  "$(jq 'length' <<<"$direct_entity_names")" \
  "$(jq 'length' <<<"$direct_relationships")"
printf 'UI_READ_NO_WRITE_OK queue=%s->%s samples=%s rows=%s->%s cache_control=no-store\n' \
  "$ui_queue_before" "$ui_queue_after" \
  "$(jq -c '.counts' <<<"$ui_queue_after_json")" \
  "$ui_rows_before" "$ui_rows_after"
printf 'INVALID_REPORT_ISOLATION_OK status=400 canonical_signal_points=%s->%s ingest_calls=0\n' \
  "$target_signal_before" "$target_signal_after"

baseline_count=$ui_rows_after
explicit_response=$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 180 \
  --request POST \
  "https://$APP_FQDN/api/demo-request")
jq -e '
  (.request_id | type == "string" and length == 36)
  and .request_id == .just_enqueued.request_id
  and .queue_head.label == "oldest visible / best-effort FIFO"
  and (.row_count | type == "number")
' <<<"$explicit_response" >/dev/null
EXPLICIT_REQUEST_ID=$(jq -er '.request_id' <<<"$explicit_response")
EXPLICIT_MESSAGE_ID=$(jq -er '.just_enqueued.message_id' <<<"$explicit_response")
explicit_response_count=$(jq -er '.row_count' <<<"$explicit_response")
explicit_after_count=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT count(*) FROM request_events')
explicit_row_request_id=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --set=request_id="$EXPLICIT_REQUEST_ID" <<'SQL'
SELECT request_id::text FROM request_events WHERE request_id = :'request_id'::uuid;
SQL
)
explicit_queue_json=$(queue_count_probe 5 2)
explicit_queue_count=$(jq -er '.counts[-1]' <<<"$explicit_queue_json")
[[ "$explicit_after_count" -eq $((baseline_count + 1)) ]]
[[ "$explicit_response_count" == "$explicit_after_count" ]]
[[ "$explicit_row_request_id" == "$EXPLICIT_REQUEST_ID" ]]
[[ "$explicit_queue_count" -eq $((ui_queue_after + 1)) ]]
jq -e --argjson expected "$explicit_queue_count" '
  .counts[-1] == $expected and .counts[-2] == $expected
' <<<"$explicit_queue_json" >/dev/null
printf 'EXPLICIT_DEMO_REQUEST_OK request_id=%s message_id=%s queue=%s->%s rows=%s->%s correlated=true\n' \
  "$EXPLICIT_REQUEST_ID" "$EXPLICIT_MESSAGE_ID" \
  "$ui_queue_after" "$explicit_queue_count" \
  "$baseline_count" "$explicit_after_count"

baseline_count=$explicit_after_count
legacy_queue_before=$explicit_queue_count
sleep 1
FIXTURE_START_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

first_response=$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --max-time 180 \
  --header 'Accept: application/json' \
  "https://$APP_FQDN/?format=json")

jq -e '
  (.request_id | type == "string" and length == 36)
  and .request_id == .just_enqueued.request_id
  and .queue_head.label == "oldest visible / best-effort FIFO"
  and (.row_count | type == "number")
' <<<"$first_response" >/dev/null || {
  printf 'VERIFY_FAIL successful route response contract: %s\n' \
    "$(jq -c . <<<"$first_response")" >&2
  exit 1
}
REQUEST_ID=$(jq -er '.request_id' <<<"$first_response")
MESSAGE_ID=$(jq -er '.just_enqueued.message_id' <<<"$first_response")
response_count=$(jq -er '.row_count' <<<"$first_response")
printf 'REQUEST_HTTP_OK status=200 request_id=%s just_enqueued=%s row_count=%s\n' \
  "$REQUEST_ID" "$MESSAGE_ID" "$response_count"

after_count=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --command='SELECT count(*) FROM request_events')
row_request_id=$(PGDATABASE=demo psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --set=request_id="$REQUEST_ID" <<'SQL'
SELECT request_id::text FROM request_events WHERE request_id = :'request_id'::uuid;
SQL
)

if [[ "$after_count" -ne $((baseline_count + 1)) ||
  "$response_count" != "$after_count" ||
  "$row_request_id" != "$REQUEST_ID" ]]; then
  printf 'VERIFY_FAIL PostgreSQL correlation request=%s row=%s counts=%s->%s response=%s\n' \
    "$REQUEST_ID" "$row_request_id" "$baseline_count" "$after_count" "$response_count" >&2
  exit 1
fi
printf 'ROW_CORRELATION_OK request_id=%s rows=%s->%s response_count=%s\n' \
  "$REQUEST_ID" "$baseline_count" "$after_count" "$response_count"

queue_probe_json=$(queue_probe)
VERIFY_MIN_RETAINED_MESSAGES=${VERIFY_MIN_RETAINED_MESSAGES:-0}
[[ "$VERIFY_MIN_RETAINED_MESSAGES" =~ ^[0-9]+$ ]]
retained_message_count=$(jq -er '.retained_message_count' <<<"$queue_probe_json")
[[ "$retained_message_count" -eq $((legacy_queue_before + 1)) ]] || {
  printf 'VERIFY_FAIL legacy JSON Queue delta expected=%s actual=%s\n' \
    "$((legacy_queue_before + 1))" "$retained_message_count" >&2
  exit 1
}
jq -e --arg privateIp "$QUEUE_PRIVATE_IP" '
    (.retained_message_count | type == "number")
    and (.dns_ips | index($privateIp) != null)
    and .first_head != null
    and .first_head == .second_head
  ' <<<"$queue_probe_json" >/dev/null || {
  printf 'VERIFY_FAIL Queue head/DNS probe=%s\n' \
    "$(jq -c . <<<"$queue_probe_json")" >&2
  exit 1
}
if ((retained_message_count < VERIFY_MIN_RETAINED_MESSAGES)); then
  printf 'VERIFY_FAIL retained Queue count=%s expected_at_least=%s\n' \
    "$retained_message_count" "$VERIFY_MIN_RETAINED_MESSAGES" >&2
  exit 1
fi

head_message_id=$(jq -er '.first_head.message_id' <<<"$queue_probe_json")
head_dequeue_count=$(jq -er '.first_head.dequeue_count' <<<"$queue_probe_json")
head_request_id=$(jq -er '.first_head.request_id' <<<"$queue_probe_json")
printf 'QUEUE_PEEK_OK message_id=%s dequeue_count=%s repeated_peeks=2 visibility_unchanged=true\n' \
  "$head_message_id" "$head_dequeue_count"
printf 'QUEUE_RETAINED_OK count=%s required=%s head_request_id=%s target_lookup=not-used\n' \
  "$retained_message_count" "$VERIFY_MIN_RETAINED_MESSAGES" "$head_request_id"
printf 'LEGACY_JSON_OK request_id=%s message_id=%s queue=%s->%s rows=%s->%s correlated=true\n' \
  "$REQUEST_ID" "$MESSAGE_ID" \
  "$legacy_queue_before" "$retained_message_count" \
  "$baseline_count" "$after_count"
printf 'UI_LABELS_OK keys=just_enqueued,row_count queue_label=\"oldest visible / best-effort FIFO\"\n'
printf 'APP_PRIVATE_DNS_OK host=%s.queue.core.windows.net private_ip=%s\n' \
  "$STORAGE_NAME" "$QUEUE_PRIVATE_IP"

telemetry_ready=false
success_telemetry_json='[]'
error_telemetry_json='[]'
success_telemetry_query="let rid = '$REQUEST_ID';
  let requestRows = AppRequests
    | where TimeGenerated >= datetime($FIXTURE_START_UTC)
    | where tostring(Properties['demo.request_id']) == rid;
  let operationId = toscalar(requestRows | top 1 by TimeGenerated desc | project OperationId);
  let dependencyRows = AppDependencies
    | where TimeGenerated >= datetime($FIXTURE_START_UTC)
    | where OperationId == operationId;
  let queueRows = dependencyRows
    | where DependencyType == 'Azure queue'
    | where ResultCode == '201'
    | where Success == true
    | extend ClientRequestId=tostring(Properties['az.client_request_id'])
    | where isnotempty(ClientRequestId);
  print
    OperationId=operationId,
    RequestCount=toscalar(requestRows | count),
    DependencyCount=toscalar(dependencyRows | count),
    TraceCount=toscalar(
      AppTraces
      | where TimeGenerated >= datetime($FIXTURE_START_UTC)
      | where OperationId == operationId or tostring(Properties['demo.request_id']) == rid
      | count
    ),
    QueueClientRequestId=toscalar(queueRows | top 1 by TimeGenerated desc | project ClientRequestId),
    QueueResultCode=toscalar(queueRows | top 1 by TimeGenerated desc | project ResultCode),
    QueueSuccessCount=toscalar(queueRows | count)"
error_telemetry_query="let requestRows = AppRequests
    | where TimeGenerated >= datetime($VERIFY_START_UTC)
    | where OperationId == '$ERROR_OPERATION_ID';
  let exceptionRows = AppExceptions
    | where TimeGenerated >= datetime($VERIFY_START_UTC)
    | where OperationId == '$ERROR_OPERATION_ID';
  print
    OperationId='$ERROR_OPERATION_ID',
    RequestCount=toscalar(requestRows | count),
    RequestFailureCount=toscalar(requestRows | summarize countif(Success == false)),
    RequestTime=toscalar(requestRows | top 1 by TimeGenerated desc | project TimeGenerated),
    RequestResultCode=toscalar(requestRows | top 1 by TimeGenerated desc | project ResultCode),
    ExceptionCount=toscalar(exceptionRows | count),
    ExceptionTime=toscalar(exceptionRows | summarize min(TimeGenerated))"
for _ in $(seq 1 40); do
  set +e
  success_telemetry_json=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription "$SUB_ID" \
    --analytics-query "$success_telemetry_query" \
    --output json 2>/dev/null)
  success_query_status=$?
  error_telemetry_json=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription "$SUB_ID" \
    --analytics-query "$error_telemetry_query" \
    --output json 2>/dev/null)
  error_query_status=$?
  set -e
  if [[ "$success_query_status" == '0' && "$error_query_status" == '0' ]] &&
    jq -e '
      length == 1
      and (.[0].RequestCount | tonumber) >= 1
      and (.[0].DependencyCount | tonumber) >= 2
      and (.[0].TraceCount | tonumber) >= 1
      and (.[0].QueueClientRequestId | type == "string" and length > 0)
      and .[0].QueueResultCode == "201"
      and (.[0].QueueSuccessCount | tonumber) >= 1
    ' <<<"$success_telemetry_json" >/dev/null &&
    jq -e --arg operationId "$ERROR_OPERATION_ID" '
      length == 1
      and .[0].OperationId == $operationId
      and (.[0].ExceptionCount | tonumber) >= 1
    ' <<<"$error_telemetry_json" >/dev/null; then
    telemetry_ready=true
    break
  fi
  sleep 15
done
[[ "$telemetry_ready" == true ]] || {
  printf 'VERIFY_FAIL exact telemetry did not converge success=%s error=%s\n' \
    "$(jq -c . <<<"$success_telemetry_json")" \
    "$(jq -c . <<<"$error_telemetry_json")" >&2
  exit 1
}

SUCCESS_OPERATION_ID=$(jq -er '.[0].OperationId' <<<"$success_telemetry_json")
QUEUE_CLIENT_REQUEST_ID=$(jq -er '.[0].QueueClientRequestId' <<<"$success_telemetry_json")
error_evidence=$(jq -nc \
  --arg verifyStart "$VERIFY_START_UTC" \
  --arg expectedOperationId "$ERROR_OPERATION_ID" \
  --arg requestOperationId "$ERROR_OPERATION_ID" \
  --arg requestTime "$INVALID_START_UTC" \
  --arg httpStatus "$invalid_status" \
  --arg exceptionOperationId "$ERROR_OPERATION_ID" \
  --arg exceptionTime "$(jq -er '.[0].ExceptionTime' <<<"$error_telemetry_json")" '{
    verifyStart: $verifyStart,
    expectedOperationId: $expectedOperationId,
    request: {
      operationId: $requestOperationId,
      timeGenerated: $requestTime,
      success: false,
      httpStatus: $httpStatus
    },
    exceptions: [{
      operationId: $exceptionOperationId,
      timeGenerated: $exceptionTime
    }]
  }')
assert_exception_correlation "$error_evidence" || {
  printf 'VERIFY_FAIL error telemetry accepted unrelated/stale exception: %s\n' \
    "$(jq -c . <<<"$error_evidence")" >&2
  exit 1
}
printf 'EXCEPTION_CORRELATION_OK operation_id=%s verify_start=%s request_time=%s exception_time=%s\n' \
  "$ERROR_OPERATION_ID" "$VERIFY_START_UTC" \
  "$(jq -r '.request.timeGenerated' <<<"$error_evidence")" \
  "$(jq -r '.exceptions[0].timeGenerated' <<<"$error_evidence")"

dependencies_json=$(az monitor log-analytics query \
  --workspace "$LAW_CUSTOMER_ID" \
  --subscription "$SUB_ID" \
  --analytics-query "AppDependencies
    | where TimeGenerated >= datetime($FIXTURE_START_UTC)
    | where OperationId == '$SUCCESS_OPERATION_ID'
    | summarize Count=count() by Name, DependencyType, Target, Success
    | order by Count desc" \
  --output json)
jq -e '
  (map(select(
    ((.Name // "") | test("Queue"; "i"))
    or ((.Target // "") | test("queue|azure.storage.queue"; "i"))
  )) | length > 0)
  and
  (map(select(
    ((.Name // "") | test("PostgreSQL"; "i"))
    or ((.Target // "") | test("postgres"; "i"))
  )) | length > 0)
' <<<"$dependencies_json" >/dev/null

appinsights_json=$(az resource show \
  --ids "$APPINSIGHTS_ID" \
  --subscription "$SUB_ID" \
  --api-version 2020-02-02 \
  --output json)
jq -e '.properties.DisableLocalAuth == true' <<<"$appinsights_json" >/dev/null
printf 'TELEMETRY_OK request_id=%s success_operation=%s error_operation=%s counts=%s dependencies=Queue,PostgreSQL local_auth=false\n' \
  "$REQUEST_ID" "$SUCCESS_OPERATION_ID" "$ERROR_OPERATION_ID" \
  "$(jq -c '.[0] | {requests:.RequestCount,dependencies:.DependencyCount,traces:.TraceCount,exceptions:"exact-error-operation"}' <<<"$success_telemetry_json")"

exact_put_ready=false
exact_put_json='[]'
exact_put_query="StorageQueueLogs
  | where TimeGenerated >= datetime($FIXTURE_START_UTC)
  | where AccountName == '$STORAGE_NAME'
  | where OperationName == 'PutMessage'
  | where ClientRequestId == '$QUEUE_CLIENT_REQUEST_ID'
  | where ObjectKey endswith '/requests/$MESSAGE_ID'
  | where AuthenticationType == 'OAuth'
  | where RequesterAppId == '$UAMI_CLIENT_ID'
  | where RequesterObjectId == '$UAMI_OBJECT_ID'
  | where StatusCode == '201'
  | project TimeGenerated, ClientRequestId, ObjectKey, AuthenticationType,
            RequesterAppId, RequesterObjectId, StatusCode"
for _ in $(seq 1 40); do
  set +e
  exact_put_json=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription "$SUB_ID" \
    --analytics-query "$exact_put_query" \
    --output json 2>/dev/null)
  exact_put_status=$?
  set -e
  if [[ "$exact_put_status" == '0' ]] &&
    jq -e 'length == 1' <<<"$exact_put_json" >/dev/null; then
    exact_put_ready=true
    break
  fi
  sleep 15
done
[[ "$exact_put_ready" == true ]] || {
  printf 'VERIFY_FAIL exact Queue PutMessage diagnostic did not converge: %s\n' \
    "$(jq -c . <<<"$exact_put_json")" >&2
  exit 1
}

correlation_evidence=$(jq -nc \
  --argjson retainedMessageCount "$retained_message_count" \
  --argjson response "$first_response" \
  --arg postgresRequestId "$row_request_id" \
  --arg requestOperationId "$SUCCESS_OPERATION_ID" \
  --arg dependencyOperationId "$SUCCESS_OPERATION_ID" \
  --arg clientRequestId "$QUEUE_CLIENT_REQUEST_ID" \
  --arg storageClientRequestId "$(jq -er '.[0].ClientRequestId' <<<"$exact_put_json")" \
  --arg objectKey "$(jq -er '.[0].ObjectKey' <<<"$exact_put_json")" \
  --arg authenticationType "$(jq -er '.[0].AuthenticationType' <<<"$exact_put_json")" \
  --arg statusCode "$(jq -er '.[0].StatusCode' <<<"$exact_put_json")" \
  --arg headRequestId "$head_request_id" '{
    retainedMessageCount: $retainedMessageCount,
    firstPeekRequestIds: [$headRequestId],
    response: $response,
    postgres: {request_id: $postgresRequestId},
    request: {operationId: $requestOperationId},
    dependency: {
      operationId: $dependencyOperationId,
      clientRequestId: $clientRequestId,
      success: true,
      resultCode: "201"
    },
    storage: {
      clientRequestId: $storageClientRequestId,
      objectKey: $objectKey,
      authenticationType: $authenticationType,
      statusCode: $statusCode
    }
  }')
assert_queue_correlation "$correlation_evidence" || {
  printf 'VERIFY_FAIL independent Queue correlation: %s\n' \
    "$(jq -c . <<<"$correlation_evidence")" >&2
  exit 1
}
printf 'RETAINED_QUEUE_CORRELATION_OK request_id=%s message_id=%s retained=%s client_request_id=%s oracle=AppDependency+StorageObjectKey+PostgreSQL target_lookup=not-used\n' \
  "$REQUEST_ID" "$MESSAGE_ID" "$retained_message_count" "$QUEUE_CLIENT_REQUEST_ID"

queue_logs_ready=false
queue_logs_json='[]'
queue_logs_query="StorageQueueLogs
  | where TimeGenerated >= datetime($FIXTURE_START_UTC)
  | where AccountName == '$STORAGE_NAME'
  | where AuthenticationType == 'OAuth'
  | where RequesterAppId == '$UAMI_CLIENT_ID'
  | where RequesterObjectId == '$UAMI_OBJECT_ID'
  | where OperationName in ('PutMessage', 'PeekMessages', 'GetQueueProperties')
  | summarize Success=countif(toint(StatusCode) between (200 .. 299)),
              Failed=countif(toint(StatusCode) < 200 or toint(StatusCode) >= 300)
              by OperationName, AuthenticationType, RequesterAppId, RequesterObjectId"
for _ in $(seq 1 40); do
  set +e
  queue_logs_json=$(az monitor log-analytics query \
    --workspace "$LAW_CUSTOMER_ID" \
    --subscription "$SUB_ID" \
    --analytics-query "$queue_logs_query" \
    --output json 2>/dev/null)
  queue_logs_status=$?
  set -e
  if [[ "$queue_logs_status" == '0' ]] &&
    jq -e '
      any(.[]; .OperationName == "PutMessage" and (.Success | tonumber) == 1 and (.Failed | tonumber) == 0)
      and all(.[];
        .AuthenticationType == "OAuth"
        and (.Success | tonumber) >= 1
        and (.Failed | tonumber) == 0
      )
    ' <<<"$queue_logs_json" >/dev/null; then
    queue_logs_ready=true
    break
  fi
  sleep 15
done
[[ "$queue_logs_ready" == true ]] || {
  printf 'VERIFY_FAIL Queue OAuth diagnostics did not converge: %s\n' \
    "$(jq -c . <<<"$queue_logs_json")" >&2
  exit 1
}
printf 'QUEUE_DIAGNOSTICS_OK auth=OAuth requester_app=%s requester_object=%s operations=%s\n' \
  "$UAMI_CLIENT_ID" "$UAMI_OBJECT_ID" \
  "$(jq -c '[.[] | {operation:.OperationName,success:.Success,failed:.Failed}]' <<<"$queue_logs_json")"
printf 'QUEUE_OPERATION_DELTA_OK fixture_start=%s put_messages=0->1\n' "$FIXTURE_START_UTC"
QUEUE_AUDIT_END_UTC=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
destructive_queue_json=$(az monitor log-analytics query \
  --workspace "$LAW_CUSTOMER_ID" \
  --subscription "$SUB_ID" \
  --analytics-query "StorageQueueLogs
    | where TimeGenerated >= datetime($VERIFY_START_UTC)
    | where TimeGenerated <= datetime($QUEUE_AUDIT_END_UTC)
    | summarize
        GetMessage=countif(OperationName == 'GetMessage'),
        GetMessages=countif(OperationName == 'GetMessages'),
        GetMessageRead=countif(OperationName == 'GetMessageRead'),
        GetMessageWrite=countif(OperationName == 'GetMessageWrite'),
        UpdateMessage=countif(OperationName == 'UpdateMessage'),
        DeleteMessage=countif(OperationName == 'DeleteMessage'),
        DeleteMessages=countif(OperationName == 'DeleteMessages'),
        ClearMessages=countif(OperationName == 'ClearMessages')" \
  --output json)
jq -e 'length == 1' <<<"$destructive_queue_json" >/dev/null
destructive_counts=$(jq -c '.[0] | del(.TableName)' <<<"$destructive_queue_json")
assert_nondestructive_operations "$destructive_counts" || {
  printf 'VERIFY_FAIL destructive Queue operation observed: %s\n' \
    "$destructive_counts" >&2
  exit 1
}
printf 'QUEUE_NONDESTRUCTIVE_OK window=%s..%s counts=%s\n' \
  "$VERIFY_START_UTC" "$QUEUE_AUDIT_END_UTC" "$destructive_counts"

activity_diagnostics=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" \
  --output json)
jq -e --arg name "$ACTIVITY_DIAGNOSTIC_NAME" --arg workspace "$LAW_ID" '
  any(
    .value[];
    .name == $name
    and .properties.workspaceId == $workspace
    and ([
      .properties.logs[]
      | select(.enabled)
      | .category
    ] | sort) == (["Administrative", "Alert", "ResourceHealth", "ServiceHealth"] | sort)
  )
' <<<"$activity_diagnostics" >/dev/null

platform_query=$(az monitor log-analytics query \
  --workspace "$LAW_CUSTOMER_ID" \
  --subscription "$SUB_ID" \
  --analytics-query 'AzureActivity
    | where TimeGenerated > ago(30m)
    | summarize ServiceHealth=countif(CategoryValue == "ServiceHealth"),
                FailedAdministrative=countif(CategoryValue == "Administrative" and ActivityStatusValue == "Failed")' \
  --output json)
jq -e '
  length == 1
  and ((.[0].ServiceHealth | tonumber) >= 0)
  and ((.[0].FailedAdministrative | tonumber) >= 0)
' <<<"$platform_query" >/dev/null
printf 'PLATFORM_CONTEXT_OK categories=Administrative,Alert,ResourceHealth,ServiceHealth values=%s\n' \
  "$(jq -c '.[0]' <<<"$platform_query")"

signals_ready=false
entities_json='[]'
for _ in $(seq 1 40); do
  set +e
  entities_json=$(az monitor health-models entity list \
    --resource-group "$RG" \
    --health-model-name "$MODEL" \
    --subscription "$SUB_ID" \
    --output json 2>/dev/null)
  entities_status=$?
  set -e
  if [[ "$entities_status" == '0' ]] && jq -e '
    def has_live_signal:
      [.properties.signalGroups[]?.signals[]?.status.healthState
       | select(. != null and . != "Unknown")] | length > 0;
    ([.[] | select(.name == "container-app" or .name == "postgres" or .name == "queue-storage")]
      | length == 3)
    and all(
      .[];
      if (.name == "container-app" or .name == "postgres" or .name == "queue-storage")
      then has_live_signal
      else true
      end
    )
  ' <<<"$entities_json" >/dev/null; then
    signals_ready=true
    break
  fi
  sleep 15
done
[[ "$signals_ready" == true ]] || {
  printf 'VERIFY_FAIL health signals did not converge: %s\n' \
    "$(jq -c '[.[] | {name,healthState:.properties.healthState}]' <<<"$entities_json")" >&2
  exit 1
}

jq -e '
  (map(select(.name == "container-app"))[0].properties.signalGroups
    | has("azureResource") and has("azureLogAnalytics"))
  and
  ([.[] | .properties.signalGroups[]?.signals[]?.signalKind] | unique
    | (index("AzureResourceMetric") != null)
    and (index("LogAnalyticsQuery") != null)
    and (index("External") != null))
  and
  all(
    .[];
    if .name == "container-app" or .name == "postgres" or .name == "queue-storage"
    then .properties.signalGroups.azureResource.resourceHealth.enabled == "Enabled"
    else true
    end
  )
' <<<"$entities_json" >/dev/null

discovery_json=$(az monitor health-models discovery-rule show \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --discovery-rule-name discover-app-insights \
  --subscription "$SUB_ID" \
  --output json)
jq -e '
  .properties.specification.kind == "ApplicationInsightsTopology"
  and ((.properties.error.message // "") == "")
' <<<"$discovery_json" >/dev/null
printf 'HEALTH_SIGNALS_OK entities=%s kinds=%s discovery=%s\n' \
  "$(jq '[.[] | {name,healthState:.properties.healthState}] | length' <<<"$entities_json")" \
  "$(jq -c '[.[] | .properties.signalGroups[]?.signals[]?.signalKind] | unique' <<<"$entities_json")" \
  "$(jq -r '.properties.provisioningState // "configured"' <<<"$discovery_json")"

root_state=$(jq -er --arg model "$MODEL" '
  .[] | select(.name == $model) | .properties.healthState
' <<<"$entities_json")
[[ "$root_state" == 'Healthy' ]] || {
  printf 'VERIFY_FAIL final root health is %s, expected Healthy\n' "$root_state" >&2
  exit 1
}
active_root_alerts=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.AlertsManagement/alerts?api-version=2019-03-01&targetResourceGroup=$RG" \
  --output json |
  jq --arg model "$MODEL_ID" '[
    .value[]
    | select(.properties.essentials.monitorCondition == "Fired")
    | select(.id | ascii_downcase | contains($model | ascii_downcase))
  ] | length')
[[ "$active_root_alerts" == '0' ]] || {
  printf 'VERIFY_FAIL active root alerts=%s\n' "$active_root_alerts" >&2
  exit 1
}
printf 'FINAL_HEALTH_OK root=Healthy active_root_alerts=0\n'

postgres_json=$(az postgres flexible-server show \
  --name "$PG_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
registry_json=$(az acr show \
  --name "$ACR_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
jq -e '
  .sku.name == "Standard_B1ms"
  and .sku.tier == "Burstable"
  and ((.storage.storageSizeGb // .storage.storageSizeGB) == 32)
  and .backup.backupRetentionDays == 7
  and .highAvailability.mode == "Disabled"
  and .authConfig.passwordAuth == "Disabled"
' <<<"$postgres_json" >/dev/null
jq -e '
  .properties.template.scale.minReplicas == 0
  and .properties.template.scale.maxReplicas == 1
' <<<"$app_json" >/dev/null
jq -e '.sku.name == "Basic" and .adminUserEnabled == false' <<<"$registry_json" >/dev/null
jq -e '.sku.name == "Standard_LRS" and .allowSharedKeyAccess == false' <<<"$storage_json" >/dev/null
printf 'CHEAP_POSTURE_OK postgres=Standard_B1ms/32GiB/noHA/7d app=Consumption,0-1 acr=Basic storage=Standard_LRS\n'

printf 'VERIFY_OK request_id=%s row_count=%s app=https://%s model=%s\n' \
  "$REQUEST_ID" "$response_count" "$APP_FQDN" "$MODEL"
