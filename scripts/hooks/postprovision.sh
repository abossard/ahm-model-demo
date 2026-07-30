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
: "${ADMIN_UPN:?}"

UAMI_NAME="$AZURE_IDENTITY_NAME"
UAMI_OBJECT_ID="$AZURE_IDENTITY_PRINCIPAL_ID"

token_json=$(az account get-access-token \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-type oss-rdbms \
  --output json)
PGPASSWORD=$(jq -er '.accessToken' <<<"$token_json")
export PGPASSWORD
trap 'unset PGPASSWORD token_json' EXIT

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
