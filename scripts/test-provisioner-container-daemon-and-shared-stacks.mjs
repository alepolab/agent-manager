#!/usr/bin/env node
/**
 * Run d6a07ffd spent 14.9 minutes on the stack step and started nothing. Its
 * log is the specification for this test:
 *
 *   06:14:08  making volume mountpoint for volume /srv/.../database/mariadb/scripts:
 *             mkdir /srv/agent-manager: permission denied
 *   06:15:17  rootlessport listen tcp 0.0.0.0:3306: bind: address already in use
 *
 * Three distinct causes, each of which will recur on every run until the
 * instructions carry them:
 *
 *  1. The agent is in a container; the daemon is on the host. Bind-mount paths
 *     are resolved by the daemon, so the agent's own paths do not exist for it.
 *     The agent rediscovered this from a failed mount, costing minutes.
 *  2. `docker compose up` on a shared file RECREATES a container that is
 *     already there. This run recreated `infra-mariadb` — the database other
 *     teams share — and left it in `Created` state when the start failed.
 *  3. Publishing host ports puts a run-scoped stack in a global namespace it
 *     cannot control. 3306 was held by something the run must not stop.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templates = readFileSync(join(root, 'app/utils/templates.ts'), 'utf8')
const prov = templates.slice(
  templates.indexOf("id: 'sdlc-stack-provisioner'"),
  templates.indexOf("id: 'sdlc-test-author'"))
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

// ── 1. container vs daemon ────────────────────────────────────────────────
check('the container/daemon path split is stated',
  /You are in a container; the daemon is not/.test(prov),
  'the agent resolved this from a failed mount at run time; it is a property of the deployment, not of the ticket')

check('it gives a way to READ the host path, not a hardcoded one',
  /proc\/self\/mountinfo/.test(prov) && /--project-directory/.test(prov),
  'a baked-in volume path breaks the moment the instance is deployed differently; the mount table is the source of truth')

check('the misleading error is quoted',
  /mkdir \/srv\/agent-manager: permission denied/.test(prov),
  'it reads as a permissions problem and is not — quoting it is what stops the next agent chasing chmod')

// ── 2. shared stacks ──────────────────────────────────────────────────────
check('bringing up a stack you do not own is forbidden',
  /Never bring up a stack you do not own/.test(prov),
  'database and sso are shared with FFM, CRM, PCRF and VMS')

check('it says up RECREATES rather than starts-if-absent',
  /\*\*recreates\*\*/.test(prov) && /already there/.test(prov),
  'the whole hazard is that `up` looks idempotent and is not')

check('the three states are each given an action',
  /Running → \*\*use it\*\*/.test(prov) && /Present but stopped/.test(prov) && /Absent → you may bring it up/.test(prov),
  'without the stopped case an agent will "helpfully" start someone else\'s stopped container')

check('re-creating to be sure is named as the trap',
  /destructive act wearing the shape of diligence/.test(prov),
  'an agent told only "use it" still recreates it to verify health unless that specific move is named')

check('the real incident is recorded',
  /infra-mariadb/.test(prov) && /Created/.test(prov),
  'the reasoning outlives the rule only if the run that caused it is named')

// ── 3. ports ──────────────────────────────────────────────────────────────
check('run-scoped stacks publish no host ports',
  /Publish no host ports/.test(prov),
  'a host port is a global namespace shared with every other stack and the host itself')

check('the collision error is quoted and called unfixable from the run',
  /rootlessport listen tcp 0\.0\.0\.0:3306/.test(prov) && /must not stop it/.test(prov),
  'an agent that thinks it can free the port will try to kill whatever holds it')

check('it says why publishing buys nothing here',
  /container-internal name and port/.test(prov) && /docker exec/.test(prov),
  'the estate addresses services internally; publishing is cost with no benefit')

// Measured, not assumed: `ports: []` in an override does NOT remove a
// published port. Compose merges sequences, so the original mapping survives
// and the collision happens anyway. The first version of this instruction told
// the agent to do exactly that — an instruction it could not follow.
const flat = prov.replace(/\s+/g, ' ')
check('it does not tell the agent to un-publish via an override',
  /cannot un-publish a port with an override file/.test(flat)
  && /Compose merges sequences/.test(flat),
  'a ports: [] override leaves the mapping in place; an agent following that instruction still collides')

check('it names the mechanism that does work',
  /MARIADB_PORT:-3306/.test(flat) && /set that variable to a free port/.test(flat),
  'every mapping in the deployment repo is variable-driven, which is the only lever that actually changes the published port')

check('the free port is found by checking, not guessing',
  /dev\/tcp\/127\.0\.0\.1/.test(flat),
  'picking a port by hope reproduces the collision it exists to avoid')

console.log(failures === 0 ? '\nprovisioner container/daemon rules: all checks passed' : `\nprovisioner container/daemon rules: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
