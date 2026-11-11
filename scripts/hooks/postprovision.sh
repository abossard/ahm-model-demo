#!/usr/bin/env bash
# Grants tenant-wide admin consent for the delegated permissions of the web and MCP app registrations. The on-behalf-of
# exchange has no interactive consent step, so without it every token request answers a claims challenge.
# This consents in the directory the app belongs to only. An administrator of any other directory consents once for
# their organization (infra/README.md, "Another directory").
# Safe to run again: an app whose delegated permissions all have a grant is left alone. A deployer without an Entra role
# that may consent for the organization (Global Administrator, Privileged Role Administrator, Cloud Application
# Administrator or Application Administrator) gets the commands an administrator runs, and the hook ends with 0 so that
# `azd up` goes on to deploy. Optional: CONSENT_WAIT_SECONDS (180), POLL_INTERVAL_SECONDS (10).
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

# Succeeds when every delegated permission the app requests has a tenant-wide grant. It only reads, and a read that
# fails counts as "not granted", so the consent below decides.
consented() {
  local required grants resources app
  required="$(az ad app show --id "$1" --query "requiredResourceAccess[].{app: resourceAppId, ids: resourceAccess[?type=='Scope'].id}" -o json 2>/dev/null)" || return 1
  grants="$(az ad app permission list-grants --id "$1" --query "[?consentType=='AllPrincipals'].{resource: resourceId, scope: scope}" -o json 2>/dev/null)" || return 1
  resources="[]"
  for app in $(jq -r '.[].app' <<<"$required"); do
    resources="$(az ad sp show --id "$app" --query "{app: appId, id: id, scopes: oauth2PermissionScopes[].{id: id, value: value}}" -o json 2>/dev/null | jq -c --argjson all "$resources" '$all + [.]')" || return 1
  done
  jq -e --argjson resources "$resources" --argjson grants "$grants" '
    all(.[]; . as $need
      | ([$resources[] | select(.app == $need.app)] | first) as $resource
      | if $resource == null then false else
          ([$grants[] | select(.resource == $resource.id) | .scope | split(" ")[]]) as $granted
          | all($need.ids[]; . as $id
              | ([$resource.scopes[] | select(.id == $id) | .value] | first) as $name
              | $name != null and ($granted | any(. == $name)))
        end)' <<<"$required" >/dev/null
}

# Both service principals are visible before the first grant, so a failure never leaves one app consented and one not.
consent() {
  until az ad app permission admin-consent --id "$1" >/dev/null 2>"$ERROR_FILE"; do
    if grep -qiE 'insufficient|authorization_requestdenied|forbidden|access ?denied|not authorized|privileges' "$ERROR_FILE"; then
      echo "You lack the Entra role to grant admin consent for app $1:" >&2
      cat "$ERROR_FILE" >&2
      echo "Nothing was granted and the deployment goes on. Until an administrator grants it, every token request answers a claims challenge." >&2
      manual_commands
      exit 0
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
for app in "$ENTRA_MCP_CLIENT_ID" "$ENTRA_CLIENT_ID"; do
  if consented "$app"; then
    echo "Admin consent already granted for app $app"
  else
    consent "$app"
  fi
done
