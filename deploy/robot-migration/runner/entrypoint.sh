#!/bin/bash
# pwmig-am: first boot seeds the Agent Manager state and the work repos, every boot starts Agent Manager.
# Everything lives in volumes: /data (state, browsers), /work (repos the agents work in), /src (fresh clones, read-only).
set -euo pipefail
log() { echo "[pwmig] $*"; }

# 1. Agent Manager state: agents, skills, the migration workflow and its queue, from the image's kit.
if [[ ! -d /data/am/claude/workflows ]]; then
  log "seeding Agent Manager state into /data/am"
  mkdir -p /data/am/workflow-runs /data/am/workspace /data/am/users
  cp -a /opt/pwmig/state/claude /data/am/claude
  [[ -f /data/am/channels.json ]] || echo '{"channels":[]}' > /data/am/channels.json
fi

# 2. The repos the agents work in, cloned once from the fresh clones in /src. The suite is the workflow's
#    single in-place checkout (runCheckout=in-place) on workflow/main; the other two are read-only sources.
clone() {  # $1 source in /src, $2 target in /work, $3 branch
  [[ -d $2/.git ]] && return
  log "cloning $1 ($3) into $2"
  git clone --quiet --branch "$3" "/src/$1" "$2"
  git -C "$2" remote set-url origin "$(git -C "/src/$1" remote get-url origin)"
  git -C "$2" remote set-url --push origin DISABLED-push-from-a-person-only
}
git config --global user.name "${GIT_BOT_NAME:-robot-migration}"
git config --global user.email "${GIT_BOT_EMAIL:-robot-migration@localhost}"
git config --global --add safe.directory '*'
clone ase-crm-testPlaywright /work/ase-crm-testPlaywright-workflow workflow/main
clone atddtestsuite_bss /work/atddtestsuite_bss "$(git -C /src/atddtestsuite_bss branch --show-current)"
clone ase-crm /work/ase-crm "$(git -C /src/ase-crm branch --show-current)"

S=/work/ase-crm-testPlaywright-workflow
# The skills' scripts and references are the suite's own copies (its .claude/skills/, kept current by git),
# refreshed every boot; the kit only ships each SKILL.md.
for s in robot-scenario-analyst robot-spec-writer; do
  for d in scripts references; do
    [[ -d $S/.claude/skills/$s/$d ]] || continue
    rm -rf "/data/am/claude/skills/$s/$d"; cp -a "$S/.claude/skills/$s/$d" "/data/am/claude/skills/$s/$d"
    find "/data/am/claude/skills/$s/$d" -name __pycache__ -prune -exec rm -rf {} +
  done
done
# The suite's FAKETIME_FILE (docker/stacks/ui/faketime/ts, gitignored) is the stack's own offset file.
if [[ ! -L $S/docker/stacks/ui/faketime ]]; then
  rm -rf "$S/docker/stacks/ui/faketime"; mkdir -p "$S/docker/stacks/ui"; ln -s /faketime "$S/docker/stacks/ui/faketime"
fi
if [[ ! -d $S/node_modules ]]; then
  log "npm ci in the suite"; (cd "$S" && npm ci --no-audit --no-fund >/dev/null)
fi
if [[ ! -d $PLAYWRIGHT_BROWSERS_PATH ]] || ! ls "$PLAYWRIGHT_BROWSERS_PATH" | grep -q '^chromium'; then
  log "installing the suite's chromium"; (cd "$S" && npx playwright install chromium >/dev/null)
fi

# 3. Claude: a person logs in once (docker exec -it pwmig-am claude), the credentials stay in the
#    pwmig_claude-home volume. Without them every agent call fails, so say so loudly.
[[ -f $HOME/.claude/.credentials.json || -n ${CLAUDE_CODE_OAUTH_TOKEN:-} || -n ${ANTHROPIC_API_KEY:-} ]] \
  || log "WARNING: no Claude login yet. Run: docker exec -it pwmig-am claude   (then /login), and restart pwmig-am"

cd /app
exec bun .output/server/index.mjs
