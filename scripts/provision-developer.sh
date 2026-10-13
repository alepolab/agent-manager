#!/usr/bin/env bash
#
# Give one developer their own Unix user and private directory, so their
# agents run as them and nobody else's agents can read their work.
#
#   sudo scripts/provision-developer.sh <github-login> [--server-user NAME]
#        [--developers-root DIR] [--workspace-root DIR] [--claude-dir DIR]
#        [--docker]
#
# Run scripts/install-run-as.sh once first. Safe to run again for the same
# login. The names here must match server/utils/osUsers.ts (osUserFor,
# developerPaths) and workspace.ts (workspaceRootFor).
#
# --docker adds the user to the docker group. Read this first: membership of
# the docker group is root on this host - `docker run -v /:/host` reads every
# file, the server's secret included - so it undoes the isolation this script
# exists for. Grant it only where every developer is already trusted with root.
set -euo pipefail

die() { echo "provision-developer: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ $# -ge 1 ] || die "usage: provision-developer.sh <github-login> [options]"

LOGIN=$1; shift
SERVER_USER=${SUDO_USER:-}
DEV_ROOT=${AGENT_DEVELOPERS_ROOT:-/srv/agent-manager/developers}
WS_ROOT=${AGENT_WORKSPACE_ROOT:-}
CLAUDE_SHARED=${CLAUDE_DIR:-}
DOCKER=0
while [ $# -gt 0 ]; do
  case $1 in
    --server-user) SERVER_USER=$2; shift 2 ;;
    --developers-root) DEV_ROOT=$2; shift 2 ;;
    --workspace-root) WS_ROOT=$2; shift 2 ;;
    --claude-dir) CLAUDE_SHARED=$2; shift 2 ;;
    --docker) DOCKER=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -n "$SERVER_USER" ] || die "name the user the server runs as: --server-user NAME"
getent group agent-devs >/dev/null || die "run scripts/install-run-as.sh first"
SERVER_HOME=$(getent passwd "$SERVER_USER" | cut -d: -f6)
WS_ROOT=${WS_ROOT:-$SERVER_HOME/alepo-workspace}
CLAUDE_SHARED=${CLAUDE_SHARED:-$SERVER_HOME/.claude}

# Same derivations as osUsers.ts / workspace.ts.
SAFE=$(printf '%s' "$LOGIN" | sed 's/[^A-Za-z0-9_.-]/_/g')
PREFIX=${AGENT_OS_USER_PREFIX:-am-}
OS_USER=$(printf '%s%s' "$PREFIX" "$(printf '%s' "$SAFE" | tr 'A-Z' 'a-z' | sed 's/^[^a-z_]*//')" | cut -c1-32)
ROOT=$DEV_ROOT/$SAFE
HOME_DIR=$ROOT/home
WORKSPACE=$WS_ROOT/$SAFE

# The user. The comment records whose it is, so a second login that cuts to
# the same 32 characters is refused rather than handed the first one's files.
TAG="agent-manager:$LOGIN"
if id -u "$OS_USER" >/dev/null 2>&1; then
  have=$(getent passwd "$OS_USER" | cut -d: -f5)
  [ "$have" = "$TAG" ] || die "$OS_USER already exists and belongs to '$have', not $LOGIN"
else
  useradd --system --no-create-home --home-dir "$HOME_DIR" \
    --shell /bin/bash --comment "$TAG" --user-group "$OS_USER"
fi
usermod -aG agent-devs "$OS_USER"
if [ "$DOCKER" -eq 1 ]; then
  getent group docker >/dev/null || die "no docker group on this host"
  usermod -aG docker "$OS_USER"
fi

# A private directory both the developer's user and the server can use, and
# nobody else. ACLs rather than a shared group: a process only learns new
# groups when it restarts, and the server should not have to for each
# developer. Default ACLs make every file created inside inherit the same.
share() {
  local d=$1
  install -d -o "$OS_USER" -g "$OS_USER" -m 0770 "$d"
  setfacl -m "u:$SERVER_USER:rwx,u:$OS_USER:rwx,g::---,o::---" "$d"
  setfacl -d -m "u::rwx,u:$SERVER_USER:rwx,u:$OS_USER:rwx,g::---,m::rwx,o::---" "$d"
}
install -d -o "$SERVER_USER" -m 0711 "$DEV_ROOT"
share "$ROOT"
share "$HOME_DIR"
share "$HOME_DIR/.claude"
share "$HOME_DIR/.claude/projects"
share "$ROOT/credentials"
install -d -o "$SERVER_USER" -m 0711 "$WS_ROOT"
share "$WORKSPACE"
# Anything already in the workspace, from before this developer had a user.
setfacl -R -m "u:$OS_USER:rwX,u:$SERVER_USER:rwX" "$WORKSPACE"
setfacl -R -d -m "u::rwx,u:$SERVER_USER:rwx,u:$OS_USER:rwx,g::---,m::rwx,o::---" "$WORKSPACE"

# The team's agents, skills and commands, for their /cli chat: linked, not
# copied, so a change on the Agents page reaches them. Read-only to them.
for name in agents skills commands output-styles plugins CLAUDE.md; do
  [ -e "$CLAUDE_SHARED/$name" ] || continue
  ln -sfn "$CLAUDE_SHARED/$name" "$HOME_DIR/.claude/$name"
done

echo "user        $OS_USER (agent-devs$([ "$DOCKER" -eq 1 ] && echo ', docker'))"
echo "directory   $ROOT"
echo "workspace   $WORKSPACE"
[ "$DOCKER" -eq 1 ] && echo "WARNING     $OS_USER is in the docker group, which is root on this host."
echo "Done. $LOGIN's agents now run as $OS_USER; no restart needed."
