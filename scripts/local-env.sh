#!/usr/bin/env bash
set -euo pipefail

# Exports the selected azd environment as the env vars the local services expect, so a local run
# reads the same single source of configuration a deployed revision does. The azd output names
# and the application env var names differ in a few places, so the mapping is explicit.
#
#   make dev
#
# Emits nothing unless every value resolves, so a half-provisioned environment can never
# produce a partially configured process.

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'LOCAL_ENV_FAIL required command not found: %s\n' "$1" >&2
    exit 1
  }
}

require_command azd
require_command jq

azd_env_json=$(azd env get-values --output json 2>/dev/null) || {
  printf 'LOCAL_ENV_FAIL no azd environment selected; run "azd env select <name>" from the repository root first\n' >&2
  exit 1
}

# APP_ENV_VAR=azd_output_name
MAPPING=(
  "AZURE_SUBSCRIPTION_ID=AZURE_SUBSCRIPTION_ID"
  "AZURE_SUBSCRIPTION_NAME=AZURE_SUBSCRIPTION_NAME"
  "AZURE_RESOURCE_GROUP=AZURE_RESOURCE_GROUP"
  "HEALTH_MODEL_NAME=HEALTH_MODEL_NAME"
  "HEALTH_MODEL_LOCATION=HEALTH_MODEL_LOCATION"
  "QUEUE_URL=AZURE_QUEUE_URL"
  "POSTGRES_HOST=AZURE_POSTGRES_HOST"
  "POSTGRES_DATABASE=AZURE_POSTGRES_DATABASE"
  "POSTGRES_USER=AZURE_IDENTITY_NAME"
  "AZURE_CLIENT_ID=AZURE_IDENTITY_CLIENT_ID"
  "APPLICATIONINSIGHTS_CONNECTION_STRING=APPLICATIONINSIGHTS_CONNECTION_STRING"
  "AZURE_OPENAI_ENDPOINT=AZURE_OPENAI_ENDPOINT"
  "AZURE_OPENAI_CHAT_DEPLOYMENT_NAME=AZURE_OPENAI_CHAT_DEPLOYMENT_NAME"
)

missing=()
exports=()
for pair in "${MAPPING[@]}"; do
  app_var=${pair%%=*}
  azd_key=${pair#*=}
  value=$(jq -r --arg key "$azd_key" '.[$key] // empty' <<<"$azd_env_json")
  if [[ -z $value ]]; then
    missing+=("$azd_key")
    continue
  fi
  exports+=("$(printf 'export %s=%q' "$app_var" "$value")")
done

if ((${#missing[@]})); then
  printf 'LOCAL_ENV_FAIL the selected azd environment does not define: %s\n' "${missing[*]}" >&2
  printf 'LOCAL_ENV_FAIL run "azd provision" so the deployment writes its outputs back\n' >&2
  exit 1
fi

printf '%s\n' "${exports[@]}"
