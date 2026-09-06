#!/usr/bin/env bash
#
# Turn GitHub sign-in on for this compose stack.
#
# Asks for the OAuth app's client secret on the terminal (never echoed, never
# passed through an agent), generates the server secret once, writes both to
# the compose environment file (mode 600, gitignored; compose reads it for
# ${VAR} interpolation) and restarts the stack. Re-running keeps the existing
# server secret: changing it would invalidate every token developers stored.
#
#   scripts/configure-auth.sh          # switch sign-in on
#   scripts/configure-auth.sh off      # back to AUTH_DISABLED=1 (local mode)
#
# Overrides: GITHUB_CLIENT_ID, GITHUB_ORG, AGENT_MANAGER_URL, ENV_FILE.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
CLIENT_ID="${GITHUB_CLIENT_ID:-Ov23li6YqqSmJDwFYsrz}"
ORG="${GITHUB_ORG:-alepolab}"
URL="${AGENT_MANAGER_URL:-http://localhost:3030}"
MANAGED='^(AUTH_DISABLED|AGENT_MANAGER_SECRET|GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET|GITHUB_ORG|AGENT_MANAGER_URL)='

existing() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

if [ "${1:-}" = "off" ]; then
  umask 077
  { [ -f "$ENV_FILE" ] && grep -vE '^AUTH_DISABLED=' "$ENV_FILE" || true; echo 'AUTH_DISABLED=1'; } > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  echo "sign-in off; restarting"
  exec docker compose up -d
fi

read -rsp "GitHub OAuth client secret for '$CLIENT_ID' (not echoed): " CLIENT_SECRET; echo
[ -n "$CLIENT_SECRET" ] || { echo "no secret given, nothing changed" >&2; exit 1; }

SERVER_SECRET="$(existing AGENT_MANAGER_SECRET)"
[ -n "$SERVER_SECRET" ] || SERVER_SECRET="$(openssl rand -hex 32)"

umask 077
{
  [ -f "$ENV_FILE" ] && grep -vE "$MANAGED" "$ENV_FILE" || true
  printf 'AUTH_DISABLED=0\nAGENT_MANAGER_SECRET=%s\nGITHUB_CLIENT_ID=%s\nGITHUB_CLIENT_SECRET=%s\nGITHUB_ORG=%s\nAGENT_MANAGER_URL=%s\n' \
    "$SERVER_SECRET" "$CLIENT_ID" "$CLIENT_SECRET" "$ORG" "$URL"
} > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"

echo "wrote $ENV_FILE (mode 600): sign-in on, org $ORG, callback $URL/api/auth/callback"
echo "restarting the stack"
exec docker compose up -d
