#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/preflight.sh"

resources_json=$(az rest \
  --method get \
  --url "https://management.azure.com/subscriptions/$SUB_ID/resourceGroups/$RG/resources?api-version=2021-04-01" \
  --output json |
  jq -c '.value')
PG_NAME=$(jq -er '
  .[] | select((.type | ascii_downcase) == "microsoft.dbforpostgresql/flexibleservers") | .name
' <<<"$resources_json")
APP_NAME=$(jq -er '
  .[] | select((.type | ascii_downcase) == "microsoft.app/containerapps") | .name
' <<<"$resources_json")
app_json=$(az containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
APP_FQDN=$(jq -er '.properties.configuration.ingress.fqdn' <<<"$app_json")
require_command script

INCIDENT_START=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
restoration_complete=false

app_postgres_probe() {
  local encoded_probe
  local probe_output

  encoded_probe=$(python3 - <<'PY'
import base64

code = '''import os
import psycopg
from azure.identity import ManagedIdentityCredential

try:
    credential = ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"])
    token = credential.get_token(
        "https://ossrdbms-aad.database.windows.net/.default"
    ).token
    with psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        dbname=os.environ["POSTGRES_DATABASE"],
        user=os.environ["POSTGRES_USER"],
        password=token,
        sslmode="require",
        connect_timeout=15,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM request_events")
            row_count = cursor.fetchone()[0]
    print(f"APP_POSTGRES_PROBE_OK row_count={row_count}")
except Exception as exc:
    print(f"APP_POSTGRES_PROBE_FAILED error={type(exc).__name__}")
'''
print(base64.b64encode(code.encode()).decode())
PY
)
  probe_output=$(script -q /dev/null \
    az containerapp exec \
      --name "$APP_NAME" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --command "python -c exec(__import__('base64').b64decode('$encoded_probe'))" \
    2>&1)
  printf '%s\n' "$probe_output"
}

entity_state() {
  az monitor health-models entity show \
    --resource-group "$RG" \
    --health-model-name "$MODEL" \
    --entity-name "$1" \
    --subscription "$SUB_ID" \
    --output json |
    jq -er '.properties.healthState'
}

poll_entity_state() {
  local entity=$1
  local expected=$2
  local attempts=${3:-60}
  local state='Unknown'
  for _ in $(seq 1 "$attempts"); do
    state=$(entity_state "$entity")
    if [[ "$state" == "$expected" ]]; then
      printf 'STATE_OK entity=%s state=%s\n' "$entity" "$state"
      return 0
    fi
    sleep 15
  done
  printf 'STATE_TIMEOUT entity=%s expected=%s actual=%s\n' "$entity" "$expected" "$state" >&2
  return 1
}

active_alerts_json() {
  local model_id="/subscriptions/$SUB_ID/resourceGroups/$RG/providers/Microsoft.CloudHealth/healthModels/$MODEL"
  az rest \
    --method get \
    --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.AlertsManagement/alerts?api-version=2019-03-01&targetResourceGroup=$RG" \
    --output json |
    jq --arg model_id "$model_id" '{
      data: [
        .value[]
        | select(.properties.essentials.monitorCondition == "Fired")
        | select(.id | ascii_downcase | contains($model_id | ascii_downcase))
      ]
    }'
}

active_alert_count() {
  active_alerts_json | jq '(.data // .) | length'
}

poll_alert_count() {
  local expected=$1
  local count=-1
  for _ in $(seq 1 60); do
    count=$(active_alert_count)
    if [[ "$count" == "$expected" ]]; then
      printf 'ALERT_COUNT_OK active=%s\n' "$count"
      return 0
    fi
    sleep 15
  done
  printf 'ALERT_COUNT_TIMEOUT expected=%s actual=%s\n' "$expected" "$count" >&2
  return 1
}

add_annotation() {
  local entity=$1
  local phase=$2
  local description=$3
  local annotation_details
  annotation_details=$(jq -nc \
    --arg phase "$phase" \
    --arg incidentStart "$INCIDENT_START" \
    '{phase: $phase, incidentStart: $incidentStart}')
  az monitor health-models entity add-data-annotation \
    --resource-group "$RG" \
    --health-model-name "$MODEL" \
    --entity-name "$entity" \
    --annotation-details "$annotation_details" \
    --description "$description" \
    --subscription "$SUB_ID" \
    --output none
}

restore_database() {
  local state
  state=$(az postgres flexible-server show \
    --name "$PG_NAME" \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --output json |
    jq -er '.state')

  if [[ "$state" != 'Ready' ]]; then
    az postgres flexible-server start \
      --name "$PG_NAME" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --output none
  fi

  for _ in $(seq 1 60); do
    state=$(az postgres flexible-server show \
      --name "$PG_NAME" \
      --resource-group "$RG" \
      --subscription "$SUB_ID" \
      --output json |
      jq -er '.state')
    [[ "$state" == 'Ready' ]] && break
    sleep 15
  done
  [[ "$state" == 'Ready' ]] || {
    printf 'RESTORE_FAIL PostgreSQL state=%s\n' "$state" >&2
    return 1
  }

  recovery_probe=$(app_postgres_probe)
  if [[ "$recovery_probe" != *'APP_POSTGRES_PROBE_'* ]]; then
    curl --silent --show-error --max-time 120 \
      "https://$APP_FQDN/__wake" >/dev/null || true
  fi
  for _ in $(seq 1 40); do
    recovery_probe=$(app_postgres_probe)
    [[ "$recovery_probe" == *'APP_POSTGRES_PROBE_OK'* ]] && break
    sleep 15
  done
  [[ "$recovery_probe" == *'APP_POSTGRES_PROBE_OK'* ]] || {
    printf 'RESTORE_FAIL managed-identity PostgreSQL probe did not recover\n' >&2
    return 1
  }
  printf '%s\n' "$recovery_probe"

  az monitor health-models entity ingest-health-report \
    --resource-group "$RG" \
    --health-model-name "$MODEL" \
    --entity-name postgres \
    --signal-name database-connectivity-probe \
    --health-state Healthy \
    --value 1 \
    --expires-in-minutes 120 \
    --additional-context 'PostgreSQL started and managed-identity request succeeded' \
    --subscription "$SUB_ID" \
    --output none
  add_annotation postgres recovery 'PostgreSQL and request journey recovered'
  add_annotation "$MODEL" recovery 'Root request experience recovered'

  poll_entity_state postgres Healthy 60
  poll_entity_state "$MODEL" Healthy 60
  poll_alert_count 0
  printf 'RECOVERY_STABILITY_WAIT seconds=330\n'
  sleep 330
  poll_entity_state postgres Healthy 60
  poll_entity_state "$MODEL" Healthy 60
  poll_alert_count 0
  printf 'RESTORE_OK postgres=Ready app_mi_probe=Healthy root=Healthy active_alerts=0\n'
  restoration_complete=true
}

on_exit() {
  status=$?
  if [[ "$restoration_complete" != true ]]; then
    set +e
    restore_database
    restore_status=$?
    set -e
    if [[ "$restore_status" != '0' ]]; then
      printf 'RESTORE_TRAP_FAIL status=%s\n' "$restore_status" >&2
      exit "$restore_status"
    fi
  fi
  exit "$status"
}
trap on_exit EXIT INT TERM

poll_entity_state postgres Healthy 60
poll_entity_state "$MODEL" Healthy 60
poll_alert_count 0
INCIDENT_START=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
printf 'FAILURE_BASELINE_OK postgres=Healthy root=Healthy active_alerts=0\n'

az postgres flexible-server stop \
  --name "$PG_NAME" \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output none

pg_state=''
for _ in $(seq 1 60); do
  pg_state=$(az postgres flexible-server show \
    --name "$PG_NAME" \
    --resource-group "$RG" \
    --subscription "$SUB_ID" \
    --output json |
    jq -er '.state')
  [[ "$pg_state" == 'Stopped' ]] && break
  sleep 15
done
[[ "$pg_state" == 'Stopped' ]] || {
  printf 'FAILURE_SCENARIO_FAIL PostgreSQL did not stop; state=%s\n' "$pg_state" >&2
  exit 1
}

failed_probe=$(app_postgres_probe)
if [[ "$failed_probe" != *'APP_POSTGRES_PROBE_'* ]]; then
  curl --silent --show-error --max-time 120 \
    "https://$APP_FQDN/__wake" >/dev/null || true
  failed_probe=$(app_postgres_probe)
fi
[[ "$failed_probe" == *'APP_POSTGRES_PROBE_FAILED'* ]] || {
  printf 'FAILURE_SCENARIO_FAIL app managed-identity PostgreSQL probe unexpectedly succeeded\n' >&2
  exit 1
}
printf '%s\n' "$failed_probe"

az monitor health-models entity ingest-health-report \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --signal-name database-connectivity-probe \
  --health-state Unhealthy \
  --value 0 \
  --expires-in-minutes 30 \
  --additional-context 'PostgreSQL stopped; app managed-identity connectivity probe failed' \
  --subscription "$SUB_ID" \
  --output none
add_annotation postgres failure-detected 'PostgreSQL connectivity failure detected'
add_annotation "$MODEL" failure-detected 'Request journey failure propagated from PostgreSQL'
printf 'FAILURE_INJECTED postgres=Stopped app_mi_probe=Failed external=Unhealthy\n'

poll_entity_state postgres Unhealthy 60
poll_entity_state container-app Unhealthy 60
poll_entity_state request-journey Unhealthy 60
poll_entity_state "$MODEL" Unhealthy 60

entities_json=$(az monitor health-models entity list \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --subscription "$SUB_ID" \
  --output json)
jq -e --arg root "$MODEL" '
  (map(select(.name == $root and .properties.alerts.unhealthy != null)) | length == 1)
  and (map(select(.name != $root and .properties.alerts != null)) | length == 0)
' <<<"$entities_json" >/dev/null
poll_alert_count 1
fired_alerts=$(active_alerts_json)
printf 'ROOT_ALERT_OK configured_root=1 configured_children=0 fired=%s\n' \
  "$(jq '(.data // .) | length' <<<"$fired_alerts")"

add_annotation postgres remediation-start 'Starting PostgreSQL remediation'
add_annotation "$MODEL" remediation-start 'Root remediation started'
restore_database

INCIDENT_END=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
root_annotations=$(az monitor health-models entity get-data-annotations \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name "$MODEL" \
  --end-at "$INCIDENT_END" \
  --subscription "$SUB_ID" \
  --output json)
postgres_annotations=$(az monitor health-models entity get-data-annotations \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --end-at "$INCIDENT_END" \
  --subscription "$SUB_ID" \
  --output json)
for annotation_json in "$root_annotations" "$postgres_annotations"; do
  jq -e '
    [.annotations[]?.annotationDetails.phase] as $phases
    | ($phases | index("deployment") != null)
    and ($phases | index("failure-detected") != null)
    and ($phases | index("remediation-start") != null)
    and ($phases | index("recovery") != null)
  ' <<<"$annotation_json" >/dev/null
done

root_history=$(az monitor health-models entity get-history \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name "$MODEL" \
  --start-at "$INCIDENT_START" \
  --end-at "$INCIDENT_END" \
  --subscription "$SUB_ID" \
  --output json)
postgres_history=$(az monitor health-models entity get-history \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --start-at "$INCIDENT_START" \
  --end-at "$INCIDENT_END" \
  --subscription "$SUB_ID" \
  --output json)
signal_history=$(az monitor health-models entity get-signal-history \
  --resource-group "$RG" \
  --health-model-name "$MODEL" \
  --entity-name postgres \
  --signal-name database-connectivity-probe \
  --start-at "$INCIDENT_START" \
  --end-at "$INCIDENT_END" \
  --subscription "$SUB_ID" \
  --output json)

jq -e '
  any(.history[]; .previousState == "Healthy" and .newState == "Unhealthy")
  and any(.history[]; .previousState == "Unhealthy" and .newState == "Healthy")
' <<<"$root_history" >/dev/null
jq -e '
  any(.history[]; .previousState == "Healthy" and .newState == "Unhealthy")
  and any(.history[]; .previousState == "Unhealthy" and .newState == "Healthy")
' <<<"$postgres_history" >/dev/null
jq -e '
  any(.history[]; .healthState == "Unhealthy")
  and any(.history[]; .healthState == "Healthy")
' <<<"$signal_history" >/dev/null

printf 'TIMELINE_OK root_annotations=%s postgres_annotations=%s root_history_items=%s postgres_history_items=%s signal_history_items=%s\n' \
  "$(jq '.annotations | length' <<<"$root_annotations")" \
  "$(jq '.annotations | length' <<<"$postgres_annotations")" \
  "$(jq '.history | length' <<<"$root_history")" \
  "$(jq '.history | length' <<<"$postgres_history")" \
  "$(jq '.history | length' <<<"$signal_history")"
printf 'FAILURE_SCENARIO_OK start=%s end=%s propagation=postgres,container-app,request-journey,root recovery=Healthy\n' \
  "$INCIDENT_START" "$INCIDENT_END"
