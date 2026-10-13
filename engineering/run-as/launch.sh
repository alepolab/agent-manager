#!/bin/sh
# Starts one agent's Claude Code process as a developer's own Unix user.
#
# Installed root-owned at /usr/local/libexec/agent-manager/launch by
# scripts/install-run-as.sh, and the only command the sudoers rule lets the
# server run as anyone else. The server starts it as
#
#   sudo -n -E -u am-<login> -- launch <command> <args...>
#
# with the environment the agent is meant to have. sudo replaces PATH with
# secure_path, which loses nvm's node and the toolchain, so the server carries
# it across as AM_PATH; HOME the same way as AM_HOME. Nothing secret is ever an
# argument: argv is visible to every user in `ps`.
set -eu
if [ -n "${AM_PATH:-}" ]; then PATH=$AM_PATH; export PATH; fi
if [ -n "${AM_HOME:-}" ]; then HOME=$AM_HOME; export HOME; fi
unset AM_PATH AM_HOME
# Outside the ACL'd directories nothing this user writes is anyone else's.
umask 077
[ "$#" -gt 0 ] || { echo "launch: no command" >&2; exit 64; }
exec "$@"
