#!/usr/bin/env bash
set -euo pipefail

: "${SERVICE_WEB_FQDN:?SERVICE_WEB_FQDN deployment output is required}"
: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP deployment output is required}"
: "${SHOP_HEALTH_MODEL_NAME:?SHOP_HEALTH_MODEL_NAME deployment output is required}"

web_url="https://${SERVICE_WEB_FQDN}"

printf '\nOpen the deployed application:\n'
printf '  Web application: %s/\n' "$web_url"
printf '  AI assistant:    %s/agent\n' "$web_url"
printf '  Health model API: %s/api/health-model\n' "$web_url"
printf '  Shop demo:       %s/?model=%s&resourceGroup=%s\n' \
  "$web_url" "$SHOP_HEALTH_MODEL_NAME" "$AZURE_RESOURCE_GROUP"
if [[ -n "${SERVICE_SURVEY_FQDN:-}" ]]; then
  printf '  Survey:          https://%s/\n' "$SERVICE_SURVEY_FQDN"
fi
