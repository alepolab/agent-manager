#!/bin/bash
# The ui-to-api-optimization lanes' suite checkouts, /work/ase-crm-testPlaywright-opt1 (stack ui) and -opt2 (stack
# ui2), each on branch optimization. Idempotent: the entrypoint runs it every boot once the workflow is installed,
# and an operator can run it by hand (docker exec pwmig-am /opt/pwmig/opt-setup.sh) without a restart.
# Each clone is made from lane 1's clone, with GitHub as its origin and the deploy key as its push URL
# (wire-push.sh). It shares lane 1's node_modules, and points the stacks' faketime files at the same volume,
# so utils/serverClock.ts reads the clock the migration may have moved. Optimization runs never move it.
set -euo pipefail
S=/work/ase-crm-testPlaywright-workflow B=optimization
[[ -f /data/am/claude/workflows/ui-to-api-optimization.json ]] || exit 0
log() { echo "[pwmig] $*"; }
for O in /work/ase-crm-testPlaywright-opt1 /work/ase-crm-testPlaywright-opt2; do
  if [[ ! -d $O/.git ]]; then
    log "cloning $O for the optimization lanes"
    git clone --quiet --branch workflow/main "$S" "$O"
    git -C "$O" remote set-url origin "$(git -C "$S" remote get-url origin)"
    git -C "$O" remote set-url --push origin DISABLED-push-from-a-person-only
  fi
  [[ -e $O/node_modules ]] || ln -s "$S/node_modules" "$O/node_modules"
  grep -qx node_modules "$O/.git/info/exclude" 2>/dev/null || echo node_modules >> "$O/.git/info/exclude"
  for st in ui ui2; do
    f=/faketime; [[ $st == ui2 ]] && f=/faketime/ui2
    [[ -L $O/docker/stacks/$st/faketime ]] && continue
    mkdir -p "$O/docker/stacks/$st"; rm -rf "$O/docker/stacks/$st/faketime"; ln -s "$f" "$O/docker/stacks/$st/faketime"
  done
done
/opt/pwmig/wire-push.sh >/dev/null
for O in /work/ase-crm-testPlaywright-opt1 /work/ase-crm-testPlaywright-opt2; do
  git -C "$O" rev-parse -q --verify "refs/heads/$B" >/dev/null && continue
  url=$(git -C "$O" remote get-url --push origin)
  [[ $url == DISABLED* ]] && { log "$O: no deploy key, so $B cannot be fetched yet (pw deploy-key)"; continue; }
  GIT_TERMINAL_PROMPT=0 git -C "$O" fetch -q "$url" "$B" || { log "$O: $B is not on GitHub yet"; continue; }
  git -C "$O" switch -q -c "$B" FETCH_HEAD
  log "$O on $B ($(git -C "$O" log -1 --format=%h))"
done
