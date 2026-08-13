#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL data-plane bootstrap. Maps the workload's user-assigned identity to a database
# role and creates the request_events table the public API writes to. Neither is expressible
# in ARM, so it runs as the azd postprovision hook.

: "${AZURE_SUBSCRIPTION_ID:?}"
: "${AZURE_POSTGRES_HOST:?}"
: "${AZURE_POSTGRES_DATABASE:?}"
: "${AZURE_IDENTITY_NAME:?}"
: "${AZURE_IDENTITY_PRINCIPAL_ID:?}"
: "${AZURE_HEALTH_MODEL_NAME:?}"
: "${HEALTH_REPORT_ROLE_NAME:?}"
: "${ADMIN_UPN:?}"

UAMI_NAME="$AZURE_IDENTITY_NAME"
UAMI_OBJECT_ID="$AZURE_IDENTITY_PRINCIPAL_ID"

PGPASSWORD=$(az account get-access-token \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-type oss-rdbms \
  --only-show-errors \
  --query accessToken \
  --output tsv)
[[ "$PGPASSWORD" == eyJ*.*.* ]] || {
  printf 'BOOTSTRAP_FAIL az account get-access-token returned no usable token: %q\n' "$PGPASSWORD" >&2
  exit 1
}
export PGPASSWORD
trap 'unset PGPASSWORD' EXIT

export PGHOST="$AZURE_POSTGRES_HOST"
export PGPORT=5432
export PGUSER="$ADMIN_UPN"
export PGSSLMODE=require

PGDATABASE=postgres psql \
  --set=ON_ERROR_STOP=1 \
  --set=uami_name="$UAMI_NAME" \
  --set=uami_oid="$UAMI_OBJECT_ID" \
  --set=demo_database="$AZURE_POSTGRES_DATABASE" <<'SQL'
SELECT format(
  'SELECT * FROM pgaadauth_create_principal_with_oid(%L, %L, %L, false, false);',
  :'uami_name',
  :'uami_oid',
  'service'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'uami_name')
\gexec

REVOKE ALL PRIVILEGES ON DATABASE :"demo_database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"demo_database" TO :"uami_name";
SQL

PGDATABASE="$AZURE_POSTGRES_DATABASE" psql \
  --set=ON_ERROR_STOP=1 \
  --set=uami_name="$UAMI_NAME" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE TABLE IF NOT EXISTS request_events (
  request_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);
REVOKE ALL PRIVILEGES ON TABLE request_events FROM :"uami_name";
GRANT USAGE ON SCHEMA public TO :"uami_name";
GRANT SELECT, INSERT ON TABLE request_events TO :"uami_name";
SQL

role_exists=$(PGDATABASE=postgres psql --tuples-only --no-align \
  --set=ON_ERROR_STOP=1 \
  --set=uami_name="$UAMI_NAME" <<'SQL'
SELECT count(*) FROM pg_roles WHERE rolname = :'uami_name';
SQL
)
[[ "$role_exists" == '1' ]] || {
  printf 'BOOTSTRAP_FAIL mapped role missing\n' >&2
  exit 1
}

printf 'BOOTSTRAP_OK server=%s database=%s principal=%s oid=%s grants=CONNECT,USAGE,SELECT,INSERT\n' \
  "$AZURE_POSTGRES_HOST" "$AZURE_POSTGRES_DATABASE" "$UAMI_NAME" "$UAMI_OBJECT_ID"

# The workload identity is only granted on the demo's own health model, so the frontend lists and
# reports on just that one. Reaching every model in the subscription needs subscription-scoped
# grants, which are deliberately left to the operator instead of being provisioned by the template.
subscription_scope="/subscriptions/$AZURE_SUBSCRIPTION_ID"

assignment_count() {
  az role assignment list \
    --assignee "$UAMI_OBJECT_ID" \
    --scope "$subscription_scope" \
    --only-show-errors \
    --query "length([?scope=='$subscription_scope' && roleDefinitionName=='$1'])" \
    --output tsv
}

grant_command() {
  printf "az role assignment create --assignee-object-id %s --assignee-principal-type ServicePrincipal --role '%s' --scope %s" \
    "$UAMI_OBJECT_ID" "$1" "$subscription_scope"
}

missing=()
[[ "$(assignment_count Reader)" == '0' ]] && missing+=(Reader)
[[ "$(assignment_count "$HEALTH_REPORT_ROLE_NAME")" == '0' ]] && missing+=("$HEALTH_REPORT_ROLE_NAME")

if (( ${#missing[@]} == 0 )); then
  printf 'CATALOG_SCOPE subscription principal=%s\n' "$UAMI_NAME"
else
  printf 'CATALOG_SCOPE single-model missing=%s\n' "$(IFS=,; printf '%s' "${missing[*]}")"
  printf 'The web frontend is limited to health model %s. Grant %s these subscription-wide roles to browse and report on every model:\n\n' \
    "$AZURE_HEALTH_MODEL_NAME" "$UAMI_NAME"
  printf '  Reader lists the models, %s submits health reports.\n\n' "$HEALTH_REPORT_ROLE_NAME"
  for role in "${missing[@]}"; do
    printf '  %s\n' "$(grant_command "$role")"
  done
  printf '\n'
fi
