#!/usr/bin/env node
/**
 * Run cf6abbb5, dispatched by `test-watch` from PCRFV-1855, died like this:
 *
 *   step halted agentSlug=sdlc-stack-provisioner
 *   `git clone https://github.com/alepolab/pcrf-ems-portal.git` failed (exit 128)
 *   — `GITHUB_TOKEN` is not set in the environment
 *   durationMs=200210
 *
 * Root cause, three hops upstream of the symptom: `server/api/watches/
 * index.post.ts` computed the owner from the signed-in user and then built the
 * Watch object literal WITHOUT `createdBy`. The value was computed and dropped
 * at every save — create and enable alike — so every watch on every instance
 * carried `createdBy: undefined`. `startRun` passes `startedBy: watch.createdBy`,
 * `envForUser` finds no profile, no GH_TOKEN reaches the agent, and the
 * provisioner halts on a private clone. The entire unattended path was dead and
 * the only symptom appeared 3.3 minutes into a run.
 *
 * Both halves are pinned: persist the owner, and refuse to dispatch without one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const post = read('server/api/watches/index.post.ts')
const sched = read('server/utils/watchScheduler.ts')
const starter = read('server/utils/watchRunStarter.ts')

// The literal is the whole bug: computing createdBy is not persisting it.
const literal = post.slice(post.indexOf('const watch: Watch = {'), post.indexOf('return await saveWatch'))
check('the saved Watch object actually carries createdBy',
  /\bcreatedBy,/.test(literal),
  'computing body.createdBy and omitting it from the object literal is exactly the original defect — the value was set and dropped')

check('an existing owner is preserved on update',
  /const existingOwner = \(await listWatches\(\)\)\.find\(w => w\.id === id\)\?\.createdBy/.test(post)
  && /const createdBy = existingOwner \?\? body\.createdBy/.test(post),
  'a second person enabling or retiming someone else\'s watch must not silently become the account its runs spend')

check('the scheduler refuses an ownerless watch',
  /if \(!watch\.createdBy\?\.trim\(\)\)/.test(sched),
  'without this the watch dispatches a run that is guaranteed to die at the provisioner, having spent budget and marked the ticket attempted')

check('the refusal is loud and names the remedy',
  /cycle refused: watch has no owner/.test(sched) && /remedy:/.test(sched),
  'a silent refusal swaps one invisible failure for another')

// Ordering: refusing must happen before any work, or the cost it exists to
// avoid has already been paid.
const cycle = sched.slice(sched.indexOf('export async function runCycle'))
check('the refusal precedes reconcile and the ticket fetch',
  cycle.indexOf('!watch.createdBy') < cycle.indexOf('await reconcile(watch)')
  && cycle.indexOf('!watch.createdBy') < cycle.indexOf('getTicketSource()'),
  'refusing after the fetch still pays for the Jira round trip this guard exists to avoid')

check('the dispatch still passes the owner through',
  /startedBy: watch\.createdBy/.test(starter),
  'persisting an owner the dispatch never reads would fix nothing')

console.log(failures === 0 ? '\nwatch ownership: all checks passed' : `\nwatch ownership: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
