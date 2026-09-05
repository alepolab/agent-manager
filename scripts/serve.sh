#!/usr/bin/env bash
#
# Run agent-manager directly on this machine, as you, rather than in a
# container.
#
#   scripts/serve.sh start | stop | restart | status | logs
#
# Why run it on the host at all: the app manages ~/.claude, and a container has
# its own copy. That split caused real confusion — a workflow run started with
# scripts/run-ticket.mjs wrote to the host's ~/.claude while the container read
# its own named volume, so the UI showed no runs and there was no signal saying
# why. It also meant private GitHub imports worked on the host and failed in the
# container, because the app shells out to `git` and only the host has your
# credential helper. Running as you removes both problems by construction
# rather than by configuration.
#
# There is no systemd on this box (not as PID 1, and no user instance), so this
# supervises with a pid file rather than a unit. That means the app does NOT
# survive a reboot on its own — run `start` again, or call it from your shell
# profile if you want it always up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

PORT="${PORT:-3030}"
HOST_BIND="${HOST:-0.0.0.0}"
RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/agent-manager"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="${AGENT_MANAGER_LOG:-$RUN_DIR/server.log}"
ENTRY="$REPO_ROOT/.output/server/index.mjs"

mkdir -p "$RUN_DIR"

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  # Confirm the pid is OUR server and not a recycled pid belonging to something
  # else — a stale pid file that happens to match a live unrelated process would
  # otherwise make `stop` kill an innocent bystander.
  grep -qs "index.mjs" "/proc/$pid/cmdline" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE")) on port $PORT"
    return 0
  fi

  if [[ ! -f "$ENTRY" ]]; then
    echo "No build found at .output/server/index.mjs — run 'npm run build' first." >&2
    return 1
  fi

  # Nitro's build does not carry node-pty's compiled binding into .output, so
  # `node .output/server/index.mjs` dies on startup with "Failed to load native
  # module: pty.node". The Dockerfile has always copied it in as a separate
  # step; running on the host needs the same, or the terminal feature takes the
  # whole server down at import time rather than failing when someone opens it.
  local pty_src="$REPO_ROOT/node_modules/node-pty/build"
  local pty_dst="$REPO_ROOT/.output/server/node_modules/node-pty/build"
  if [[ -d "$pty_src" && ! -e "$pty_dst/Release/pty.node" ]]; then
    mkdir -p "$(dirname "$pty_dst")"
    cp -r "$pty_src" "$pty_dst"
    echo "copied node-pty native binding into .output"
  fi

  # CLAUDE_DIR and AGENT_RUNS_DIR are left to their defaults on purpose: the
  # app then reads the same ~/.claude and ~/.agent-manager this shell does, so
  # a run started from the CLI shows up in the UI. Overriding them here would
  # quietly reintroduce the split this deployment exists to remove.
  HOST="$HOST_BIND" PORT="$PORT" NODE_ENV=production \
    setsid nohup node "$ENTRY" >>"$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  disown || true

  # Wait for the app to actually answer rather than reporting success because
  # the process spawned. A process that starts and immediately dies is the
  # failure mode worth catching here.
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
      echo "started (pid $(cat "$PID_FILE")) — http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done

  echo "started process $(cat "$PID_FILE") but /api/health never answered; see $LOG_FILE" >&2
  return 1
}

stop() {
  if ! is_running; then
    echo "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    is_running || { rm -f "$PID_FILE"; echo "stopped"; return 0; }
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "stopped (forced)"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE")) on port $PORT"
    curl -fsS -m 3 "http://localhost:$PORT/api/health" 2>/dev/null || echo "  (process alive but /api/health not answering)"
    echo
  else
    echo "not running"
    return 1
  fi
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -n "${2:-50}" "$LOG_FILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs [n]}" >&2; exit 2 ;;
esac
