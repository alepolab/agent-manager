#!/usr/bin/env bash
#
# One-time host setup for running each developer's agents as their own user.
#
#   sudo scripts/install-run-as.sh [--server-user NAME] [--developers-root DIR]
#
# Then set AGENT_RUN_AS=user for the server, restart it, and provision each
# developer with scripts/provision-developer.sh. See server/utils/osUsers.ts
# for why.
#
# What it does, and nothing else:
#   1. installs the launcher, root-owned, at /usr/local/libexec/agent-manager/launch
#   2. creates the agent-devs group every developer user joins
#   3. writes /etc/sudoers.d/agent-manager: the server user may run THAT launcher,
#      and only it, as any member of agent-devs, keeping the environment it passes
#   4. creates the developers root, and closes the server's own secrets to
#      everyone but the server: ~/.agent-manager (traverse only), its secret and
#      users directory, and the app's .env
#
# It never touches a developer's files, and is safe to run again.
set -euo pipefail

die() { echo "install-run-as: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

SERVER_USER=${SUDO_USER:-}
DEV_ROOT=/srv/agent-manager/developers
while [ $# -gt 0 ]; do
  case $1 in
    --server-user) SERVER_USER=$2; shift 2 ;;
    --developers-root) DEV_ROOT=$2; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$SERVER_USER" ] || die "name the user the server runs as: --server-user NAME"
id -u "$SERVER_USER" >/dev/null 2>&1 || die "no such user: $SERVER_USER"
command -v setfacl >/dev/null || die "setfacl is missing; install the acl package (apt install acl)"
command -v sudo >/dev/null || die "sudo is missing"

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
SERVER_HOME=$(getent passwd "$SERVER_USER" | cut -d: -f6)
LAUNCHER=/usr/local/libexec/agent-manager/launch

# 1. the launcher: root-owned, so the server cannot change what the rule allows
install -d -o root -g root -m 0755 "$(dirname "$LAUNCHER")"
install -o root -g root -m 0755 "$APP_DIR/engineering/run-as/launch.sh" "$LAUNCHER"
echo "launcher       $LAUNCHER"

# 2. the group developer users join; the sudoers rule names it, not each user
getent group agent-devs >/dev/null || groupadd --system agent-devs
echo "group          agent-devs"

# 3. one rule. SETENV is what lets -E carry the agent's environment through;
#    it is granted for this launcher alone.
SUDOERS=/etc/sudoers.d/agent-manager
TMP=$(mktemp)
cat > "$TMP" <<EOF
# agent-manager: start a developer's agent as their own user. See $APP_DIR/server/utils/osUsers.ts
$SERVER_USER ALL=(%agent-devs) NOPASSWD:SETENV: $LAUNCHER
EOF
visudo -cf "$TMP" >/dev/null || { rm -f "$TMP"; die "the sudoers rule did not validate"; }
install -o root -g root -m 0440 "$TMP" "$SUDOERS"
rm -f "$TMP"
echo "sudoers        $SUDOERS"

# 4. where developers' private directories go, owned by the server
install -d -o "$SERVER_USER" -m 0711 "$(dirname "$DEV_ROOT")" "$DEV_ROOT"
echo "developers     $DEV_ROOT"

# The server's own secrets, closed to everyone but the server. Traverse-only
# on ~/.agent-manager so an agent can reach a run's artifacts directory it was
# granted, and list nothing.
AM=$SERVER_HOME/.agent-manager
if [ -d "$AM" ]; then
  chmod 0711 "$AM"
  [ -f "$AM/secret" ] && chmod 0600 "$AM/secret"
  [ -d "$AM/users" ] && chmod 0700 "$AM/users"
  [ -d "$AM/workflow-runs" ] && chmod 0711 "$AM/workflow-runs"
  echo "secured        $AM"
fi
[ -f "$APP_DIR/.env" ] && chmod 0600 "$APP_DIR/.env" && echo "secured        $APP_DIR/.env"
# The server's Claude directory: developers' agents need the team config in it
# - agents, skills, commands, output styles, plugins (the guardrail hooks),
# settings.json and CLAUDE.md - and nothing else. Everything else is closed to
# them: run records (workflow-runs/<id>.json holds every run's ticket,
# parameters and step output, and its id leads to the run's artifacts), the
# roles and team files, watches, and the server user's own Claude data
# (transcripts, file history, paste cache, shell snapshots). Top level only:
# a closed directory closes everything under it.
CLAUDE_OWN=${CLAUDE_DIR:-$SERVER_HOME/.claude}
SHARED_CLAUDE=" agents skills commands output-styles plugins settings.json CLAUDE.md "
if [ -d "$CLAUDE_OWN" ]; then
  # Run records are written later than this script runs: make sure the
  # directory exists closed, so the first run does not create it world-readable.
  install -d -o "$SERVER_USER" -m 0700 "$CLAUDE_OWN/workflow-runs"
  closed=0
  for entry in "$CLAUDE_OWN"/* "$CLAUDE_OWN"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$SHARED_CLAUDE" in *" $(basename "$entry") "*) continue ;; esac
    chmod o-rwx "$entry" && closed=$((closed + 1))
  done
  echo "secured        $CLAUDE_OWN ($closed entries closed; shared:$SHARED_CLAUDE)"
fi

# Developers' processes must reach the app (the SDK's CLI lives in its
# node_modules) and node. Report a closed directory on the way rather than
# opening anyone's home without asking.
# The team's ~/.claude too: pipeline agents read its skills, and each
# developer's chat links its agents and commands.
CLAUDE_SHARED=${CLAUDE_DIR:-$SERVER_HOME/.claude}
blocked=""
for target in "$APP_DIR" "$CLAUDE_SHARED"; do
  p=$target
  while [ "$p" != "/" ]; do
    mode=$(stat -c %a "$p" 2>/dev/null || echo 7)
    [ $(( 0${mode: -1} & 1 )) -eq 1 ] || case " $blocked " in *" $p "*) ;; *) blocked="$blocked $p" ;; esac
    p=$(dirname "$p")
  done
done
if [ -n "$blocked" ]; then
  echo
  echo "WARNING: developer users cannot reach $APP_DIR or $CLAUDE_SHARED through:$blocked"
  echo "  Agents will fail to start. Grant traverse (not read) on each, e.g.:"
  for d in $blocked; do echo "    chmod o+x $d"; done
  echo "  and make sure node itself (e.g. under ~/.nvm) is reachable the same way."
fi

echo
echo "Done. Next: set AGENT_RUN_AS=user (and AGENT_DEVELOPERS_ROOT=$DEV_ROOT if"
echo "you changed it), restart the server, then for each developer:"
echo "  sudo $APP_DIR/scripts/provision-developer.sh <github-login>"
