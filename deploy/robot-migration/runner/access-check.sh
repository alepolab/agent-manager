#!/bin/bash
# Run inside pwmig-am (pwmig.sh check). Everything a porting run needs, one line each; exit 1 on any FAIL.
S=/work/ase-crm-testPlaywright-workflow; fail=0
ok() { printf '  ok    %s\n' "$1"; }
no() { printf '  FAIL  %s\n' "$1"; fail=1; }
t() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else no "$what"; fi; }
echo "tools"
t "node $(node -v 2>/dev/null)" node -v
t "git" git --version
t "flock" flock -V
t "python robotframework" python3 -c "import robot.api, robot.libdoc"
t "bun (Agent Manager)" bun --version
echo "repos"
t "suite on workflow/main" bash -c "[ \"\$(git -C $S branch --show-current)\" = workflow/main ] || git -C $S rev-parse --verify -q workflow/main"
t "suite rulebook (docs/porting/rules.md, channels, sessions)" test -f $S/docs/porting/rules.md -a -d $S/docs/porting/channels -a -d $S/docs/porting/sessions
t "scripts/robot-remaining.mjs" test -f $S/scripts/robot-remaining.mjs
t "suite node_modules + playwright" test -x $S/node_modules/.bin/playwright
t "Robot suite (atddtestsuite_bss)" test -d /work/atddtestsuite_bss/Sanity_Testcases
t "CRM source (ase-crm frontend + backend)" test -d /work/ase-crm/frontend -a -d /work/ase-crm/backend
t "robot_inventory.py on Sanity_Testcases" python3 $S/.claude/skills/robot-scenario-analyst/scripts/robot_inventory.py /work/atddtestsuite_bss/Sanity_Testcases
t "robot-remaining.mjs" node $S/scripts/robot-remaining.mjs /work/atddtestsuite_bss Sanity_Testcases
echo "stack (through the ports sidecar, as stack.sh test-env ui prints)"
eval "$(cd $S && docker/stacks/stack.sh test-env ui)"
t "app $CRM_BASE_URL/actuator/health" curl -fsS -m 10 "$CRM_BASE_URL/actuator/health"
t "Keycloak token for crmadmin" bash -c "curl -fsS -m 10 -d client_id=crm-client -d username=crmadmin -d password=crmadmin -d grant_type=password $KEYCLOAK_URL/realms/alepo/protocol/openid-connect/token | grep -q access_token"
t "DB crm14_db (dbq.mjs)" bash -c "cd $S && node .claude/skills/robot-scenario-analyst/scripts/dbq.mjs 'SELECT COUNT(*) FROM billingpolicies'"
t "faketime file writable" bash -c "touch $S/docker/stacks/ui/faketime/.w && rm $S/docker/stacks/ui/faketime/.w"
t "stackctl status" curl -fsS -m 30 "$STACKCTL_URL/status"
t "no docker socket in this container" bash -c "! test -S /var/run/docker.sock"
echo "Agent Manager"
t "UI on :3030" curl -fsS -m 10 http://localhost:3030/api/health
t "Claude login present" bash -c "test -f \$HOME/.claude/.credentials.json -o -n \"\$CLAUDE_CODE_OAUTH_TOKEN\" -o -n \"\$ANTHROPIC_API_KEY\""
t "queue loaded" bash -c "curl -fsS -m 10 http://localhost:3030/api/workflows/robot-to-playwright-migration/queue | grep -q items"
t "disk >= 15 GB free" bash -c "[ \$(df --output=avail -BG /data | tail -1 | tr -dc 0-9) -ge 15 ]"
echo "browser login (crmadmin, headless)"
t "Playwright auth setup" bash -c "cd $S && flock \$CRM_LOCK npx playwright test --project=setup --output=/tmp/pw-check --reporter=line"
[ $fail = 0 ] && echo "ALL OK" || { echo "SOME CHECKS FAILED"; exit 1; }
