#!/usr/bin/env bash
# Grants tenant-wide admin consent for the delegated permissions of the web and MCP app registrations. The on-behalf-of
# exchange has no interactive consent step, so without it every token request answers a claims challenge.
# This consents in the directory the app belongs to only. An administrator of any other directory consents once for
# their organization (infra/README.md, "Another directory").
# Safe to run again. Needs an Entra role that may consent for the organization (Global Administrator, Privileged Role
# Administrator, Cloud Application Administrator or Application Administrator). Optional: CONSENT_WAIT_SECONDS (180),
# POLL_INTERVAL_SECONDS (10).
set -euo pipefail

CONSENT_WAIT_SECONDS="${CONSENT_WAIT_SECONDS:-180}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"

for name in ENTRA_CLIENT_ID ENTRA_MCP_CLIENT_ID; do
  [ -n "${!name:-}" ] || { echo "$name is not set; run this from an azd environment after azd provision" >&2; exit 1; }
done

manual_commands() {
  cat >&2 <<COMMANDS
An administrator can grant the consent by hand, in this order:
  az ad app permission admin-consent --id $ENTRA_MCP_CLIENT_ID
  az ad app permission admin-consent --id $ENTRA_CLIENT_ID
COMMANDS
}

DEADLINE=$(($(date +%s) + CONSENT_WAIT_SECONDS))
ERROR_FILE="$(mktemp)"
trap 'rm -f "$ERROR_FILE"' EXIT

# A new app registration and its service principal replicate for a short while; consent can only target a visible one.
wait_for_service_principal() {
  until az ad sp show --id "$1" --query id -o tsv >/dev/null 2>"$ERROR_FILE"; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "The service principal of app $1 is still not visible after ${CONSENT_WAIT_SECONDS}s:" >&2
      cat "$ERROR_FILE" >&2
      manual_commands
      exit 1
    fi
    echo "Waiting for the service principal of app $1 to replicate" >&2
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

# Both service principals are visible before the first grant, so a failure never leaves one app consented and one not.
consent() {
  until az ad app permission admin-consent --id "$1" >/dev/null 2>"$ERROR_FILE"; do
    if grep -qiE 'insufficient|authorization_requestdenied|forbidden|access ?denied|not authorized|privileges' "$ERROR_FILE"; then
      echo "You lack the Entra role to grant admin consent for app $1:" >&2
      cat "$ERROR_FILE" >&2
      manual_commands
      exit 1
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "Admin consent for app $1 still fails after ${CONSENT_WAIT_SECONDS}s:" >&2
      cat "$ERROR_FILE" >&2
      manual_commands
      exit 1
    fi
    echo "Admin consent for app $1 is not accepted yet, retrying in ${POLL_INTERVAL_SECONDS}s" >&2
    sleep "$POLL_INTERVAL_SECONDS"
  done
  echo "Admin consent granted for app $1"
}

wait_for_service_principal "$ENTRA_MCP_CLIENT_ID"
wait_for_service_principal "$ENTRA_CLIENT_ID"
consent "$ENTRA_MCP_CLIENT_ID"
consent "$ENTRA_CLIENT_ID"
