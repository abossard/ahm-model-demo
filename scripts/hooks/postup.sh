#!/usr/bin/env bash
set -euo pipefail

: "${SERVICE_WEB_FQDN:?SERVICE_WEB_FQDN deployment output is required}"

web_url="https://${SERVICE_WEB_FQDN}"

printf '\nOpen the deployed application:\n'
printf '  Web application: %s/\n' "$web_url"
printf '  Health model API: %s/api/health-model\n' "$web_url"
