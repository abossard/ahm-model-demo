#!/usr/bin/env bash
set -euo pipefail

# Exports the selected azd environment as the env vars the web app expects, so a local run
# reads the same single source of configuration a deployed revision does. Every name is both
# an azd output and an app env var.
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

NAMES=(
  "AZURE_SUBSCRIPTION_ID"
  "AZURE_RESOURCE_GROUP"
  "HEALTH_MODEL_NAME"
  "HEALTH_MODEL_DESIGN_NAME"
  "APPLICATIONINSIGHTS_CONNECTION_STRING"
  "FOUNDRY_PROJECT_ENDPOINT"
  "FOUNDRY_AGENT_NAME"
)

exports=()
missing=()
for name in "${NAMES[@]}"; do
  value=$(jq -r --arg key "$name" '.[$key] // empty' <<<"$azd_env_json")
  if [[ -z $value ]]; then
    missing+=("$name")
    continue
  fi
  exports+=("$(printf 'export %s=%q' "$name" "$value")")
done

if ((${#missing[@]})); then
  printf 'LOCAL_ENV_FAIL the selected azd environment does not define: %s\n' "${missing[*]}" >&2
  printf 'LOCAL_ENV_FAIL run "azd provision" so the deployment writes its outputs back\n' >&2
  exit 1
fi

# The session store accepts only private endpoint traffic, so a local run keeps Sessions in process memory.
exports+=("export SESSIONS_CONTAINER_URL=memory:")
# A local run has no managed identity, so no on-behalf-of: the web app acts as the developer's az login identity and
# asks nobody to sign in. The app refuses this mode inside a Container App.
exports+=("export AUTH_MODE=local")

printf '%s\n' "${exports[@]}"
