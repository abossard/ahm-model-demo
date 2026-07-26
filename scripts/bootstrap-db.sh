#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/preflight.sh"

servers_json=$(az postgres flexible-server list \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
PG_NAME=$(jq -er '
  [.[] | select(.name | startswith("pg-ahm-"))]
  | if length == 1 then .[0].name else error("expected one demo PostgreSQL server") end
' <<<"$servers_json")
PG_HOST=$(jq -er --arg name "$PG_NAME" '
  .[] | select(.name == $name) | .fullyQualifiedDomainName
' <<<"$servers_json")

identity_json=$(az identity show \
  --name id-ahm-demo-app \
  --resource-group "$RG" \
  --subscription "$SUB_ID" \
  --output json)
UAMI_NAME=$(jq -er '.name' <<<"$identity_json")
UAMI_OBJECT_ID=$(jq -er '.principalId' <<<"$identity_json")

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

PGDATABASE=postgres psql \
  --set=ON_ERROR_STOP=1 \
  --set=uami_name="$UAMI_NAME" \
  --set=uami_oid="$UAMI_OBJECT_ID" <<'SQL'
SELECT format(
  'SELECT * FROM pgaadauth_create_principal_with_oid(%L, %L, %L, false, false);',
  :'uami_name',
  :'uami_oid',
  'service'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'uami_name')
\gexec

REVOKE ALL PRIVILEGES ON DATABASE demo FROM PUBLIC;
GRANT CONNECT ON DATABASE demo TO :"uami_name";
SQL

PGDATABASE=demo psql \
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

printf 'BOOTSTRAP_OK server=%s database=demo principal=%s oid=%s grants=CONNECT,USAGE,SELECT,INSERT\n' \
  "$PG_NAME" "$UAMI_NAME" "$UAMI_OBJECT_ID"
