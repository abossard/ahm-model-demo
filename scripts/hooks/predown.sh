#!/usr/bin/env bash
# Deletes the subscription-scope activity log diagnostic setting (infra/modules/subscription-monitoring.bicep) before
# `azd down`. It lives outside the resource group, so `azd down` leaves it behind: it keeps pointing at the deleted
# workspace and takes one of the subscription's five diagnostic setting slots. Safe to run again: a setting that is
# already gone is not an error. `azd provision` creates it again.
set -euo pipefail

for name in AZURE_ENV_NAME AZURE_SUBSCRIPTION_ID; do
  [ -n "${!name:-}" ] || { echo "$name is not set; run this from an azd environment" >&2; exit 1; }
done

setting="diag-${AZURE_ENV_NAME}-activity"
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

if ! az monitor diagnostic-settings subscription show --subscription "$AZURE_SUBSCRIPTION_ID" --name "$setting" --output none 2>"$error_file"; then
  if grep -q 'ResourceNotFound' "$error_file"; then
    echo "Activity log diagnostic setting $setting is already gone"
    exit 0
  fi
  cat "$error_file" >&2
  exit 1
fi

az monitor diagnostic-settings subscription delete --subscription "$AZURE_SUBSCRIPTION_ID" --name "$setting" --yes
echo "Deleted activity log diagnostic setting $setting"
