#!/usr/bin/env bash
# Installs the ase-crm Defect Register pipeline on the agent-manager VM.
#   sudo ~/defect-pipeline/install.sh [developer-login]   (default vivekojha-alepo)
# Safe to run again: files are replaced, the group is merged, tools already
# present at the right version are left alone.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
LOGIN=${1:-vivekojha-alepo}
SERVER_USER=agentmgr
ENV_FILE=/srv/agent-manager/app/.env
NODE_VERSION=22.20.0
PW_VERSION=1.63.0
PW_DIR=/opt/ms-playwright

CLAUDE=$(grep -E '^CLAUDE_DIR=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)
CLAUDE=${CLAUDE:-$(getent passwd "$SERVER_USER" | cut -d: -f6)/.claude}
echo "== config dir: $CLAUDE"

echo "== agents and workflows"
install -d -o "$SERVER_USER" -g "$SERVER_USER" "$CLAUDE/agents" "$CLAUDE/workflows"
install -m 644 -o "$SERVER_USER" -g "$SERVER_USER" "$HERE"/agents/*.md "$CLAUDE/agents/"
install -m 644 -o "$SERVER_USER" -g "$SERVER_USER" "$HERE"/workflows/*.json "$CLAUDE/workflows/"

echo "== workflow group"
GROUPS="$CLAUDE/workflow-groups.json"
python3 - "$GROUPS" "$HERE/workflow-groups.add.json" <<'PY'
import json, os, sys
path, add = sys.argv[1], json.load(open(sys.argv[2]))
try: cur = json.load(open(path)); cur = cur if isinstance(cur, list) else []
except Exception: cur = []
ids = {g['id'] for g in add}
out = [g for g in cur if g.get('id') not in ids] + add
open(path, 'w').write(json.dumps(out, indent=2) + '\n')
print('  groups:', ', '.join(g['id'] for g in out))
PY
chown "$SERVER_USER:$SERVER_USER" "$GROUPS"; chmod 660 "$GROUPS"

echo "== Java 21"
if ! java -version 2>&1 | grep -q '"21'; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openjdk-21-jdk-headless
fi
java -version 2>&1 | head -1

echo "== Node $NODE_VERSION, pnpm"
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  T=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$T/node.tar.xz"
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$T/node.tar.xz" -C /opt/node --strip-components=1 && rm -rf "$T"
  for b in node npm npx corepack; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done
fi
corepack enable --install-directory /usr/local/bin pnpm
COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10.33.2 --activate >/dev/null
chmod -R a+rX /opt/corepack
node -v; COREPACK_HOME=/opt/corepack pnpm -v

echo "== Playwright $PW_VERSION Chromium into $PW_DIR"
mkdir -p "$PW_DIR"
PLAYWRIGHT_BROWSERS_PATH=$PW_DIR npx -y "playwright@$PW_VERSION" install --with-deps chromium
chmod -R a+rX "$PW_DIR"

echo "== service environment"
mkdir -p /etc/systemd/system/agent-manager.service.d
cat > /etc/systemd/system/agent-manager.service.d/toolchain.conf <<CONF
# Real node ahead of data/bin (whose node is a Bun shim); Playwright browsers shared.
[Service]
Environment=PATH=/usr/local/bin:/srv/agent-manager/data/bin:/srv/agent-manager/data/bun:/usr/bin:/bin
Environment=PLAYWRIGHT_BROWSERS_PATH=$PW_DIR
Environment=COREPACK_HOME=/opt/corepack
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
CONF
systemctl daemon-reload
systemctl restart agent-manager

echo "== register for @$LOGIN"
OS_USER=am-$(echo "$LOGIN" | tr 'A-Z' 'a-z')
DEV_HOME=/srv/agent-manager/developers/$LOGIN/home
[ -d "$DEV_HOME" ] || { echo "  $DEV_HOME missing: run provision-developer.sh $LOGIN first"; exit 1; }
install -d -o "$OS_USER" -g "$OS_USER" "$DEV_HOME/defect-register"
# Optional: the run dialog uploads the register, so a copy here is only the default path.
for h in "$HERE"/*.html; do [ -e "$h" ] && cp "$h" "$DEV_HOME/defect-register/"; done
chown -R "$OS_USER:$OS_USER" "$DEV_HOME/defect-register"
ls -l "$DEV_HOME/defect-register"

echo "== checks as $OS_USER"
sleep 3
sudo -u "$OS_USER" env PATH=/usr/local/bin:/usr/bin:/bin PLAYWRIGHT_BROWSERS_PATH=$PW_DIR COREPACK_HOME=/opt/corepack HOME="$DEV_HOME" \
  bash -c 'java -version 2>&1 | head -1; node -v; pnpm -v; ls '"$PW_DIR"' | tr "\n" " "; echo'
systemctl is-active agent-manager
echo "done"
