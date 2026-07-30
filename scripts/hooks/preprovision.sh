#!/usr/bin/env bash
set -euo pipefail

# Resolves the two values ARM cannot derive itself: the Entra UPN that becomes the PostgreSQL
# administrator, and the single public IP allowed through the PostgreSQL firewall to run the
# postprovision bootstrap.

admin_upn=$(az ad signed-in-user show --query userPrincipalName --output tsv)
[[ -n "$admin_upn" ]] || {
  printf 'PREPROVISION_FAIL could not resolve the signed-in user UPN\n' >&2
  exit 1
}

admin_ip=$(curl --fail --silent --show-error https://api.ipify.org)
[[ "$admin_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
  printf 'PREPROVISION_FAIL could not resolve a public IPv4 address: %s\n' "$admin_ip" >&2
  exit 1
}

azd env set ADMIN_UPN "$admin_upn"
azd env set ADMIN_IP_ADDRESS "$admin_ip"

printf 'PREPROVISION_OK admin_upn=%s admin_ip=%s\n' "$admin_upn" "$admin_ip"
