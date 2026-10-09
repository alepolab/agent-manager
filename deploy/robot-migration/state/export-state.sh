#!/bin/bash
# Refresh this kit's Agent Manager state from the laptop instance (~/.agent-manager-new) before a deploy.
# Copies the migration's agents, workflow, queue and skill files (SKILL.md only: each skill's scripts/ and
# references/ come from the suite clone at first boot), rewriting laptop paths to the container's.
set -euo pipefail
SRC=${1:-$HOME/.agent-manager-new/claude}
OUT=$(cd "$(dirname "$0")" && pwd)/claude
rm -rf "$OUT"; mkdir -p "$OUT"/{agents,skills,workflows,workflow-queues}
cp "$SRC"/agents/robot-{scenario-analyst,spec-writer,branch-pusher}.md "$OUT/agents/"
for s in robot-scenario-analyst robot-spec-writer; do mkdir -p "$OUT/skills/$s"; cp "$SRC/skills/$s/SKILL.md" "$OUT/skills/$s/"; done
python3 - "$SRC" "$OUT" <<'PY'
import json, sys
src, out = sys.argv[1], sys.argv[2]
paths = {
    'projectDir': '/work/ase-crm-testPlaywright-workflow', 'localCheckout': '/work/ase-crm-testPlaywright-workflow',
    'robotSuiteDir': '/work/atddtestsuite_bss', 'crmSourceDir': '/work/ase-crm',
    'appUrl': 'http://localhost:8083', 'keycloakUrl': 'http://localhost:8280', 'dbHost': 'localhost:3308',
    'crmStack': 'ui', 'deliver': 'local', 'runCheckout': 'in-place', 'baseBranch': 'workflow/main',
}
wf = json.load(open(f'{src}/workflows/robot-to-playwright-migration.json'))
for p in wf['parameters']:
    if p['name'] in paths: p['default'] = paths[p['name']]
json.dump(wf, open(f'{out}/workflows/robot-to-playwright-migration.json', 'w'), indent=2)
q = json.load(open(f'{src}/workflow-queues/robot-to-playwright-migration.json'))
q['defaults']['parameters'].update({k: v for k, v in paths.items() if k in q['defaults']['parameters'] or k in ('runCheckout', 'baseBranch')})
q['defaults']['startedBy'] = 'local'
# Never pick up where the laptop was: off until a person starts it on the new host; anything that did not
# finish there goes back to pending (the check before each item skips what is already ported).
q['enabled'] = False
q['pausedReason'] = 'new host: start it from the queue panel once the access check is green'
for i in q['items']:
    if i['status'] in ('running', 'stopped'):
        for k in ('runId', 'startedAt', 'endedAt', 'note'): i.pop(k, None)
        i['status'] = 'pending'
# Disk guard first: the queue pauses rather than fill the host's disk (df of /data is the docker disk).
q['defaults']['precheck']['command'] = (
    'avail=$(df --output=avail -BG /data | tail -1 | tr -dc 0-9); '
    '[ "$avail" -ge 15 ] || { echo "only ${avail} GB free on the docker disk (need 15)" >&2; exit 1; }; '
    + q['defaults']['precheck']['command'])
json.dump(q, open(f'{out}/workflow-queues/robot-to-playwright-migration.json', 'w'), indent=2)
PY
grep -rl "/home/jayesh_chavan\|\.agent-manager-new" "$OUT" && { echo "laptop paths left in the export" >&2; exit 1; } || true
echo "exported to $OUT"
