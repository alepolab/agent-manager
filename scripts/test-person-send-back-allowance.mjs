/**
 * A reviewer's two send-backs are theirs: the steps sending the run back to
 * each other spend allowances of their own.
 *
 * ASECRM-350 reached Jira: Dev Done with `reworks: 3` - one red check sent back
 * by PR Checks, one verifier finding, one reviewer send-back - and the gate
 * offered no Send back at all, because both the gate (2 - reworks) and the
 * route (reworks + 1 > 2) read the run total. The agents' send-backs had spent
 * the person's.
 *
 *   node scripts/test-person-send-back-allowance.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { PERSON_SEND_BACK_LIMIT, personSendBacks } = await import('../shared/utils/runDecisions.ts')

const sentBack = by => ({ stepId: 'g', label: 'Jira: Dev Done', at: 1, by, verdict: 'sent-back', waitedMs: 0 })
const approved = { stepId: 'g', label: 'Jira: Dev Done', at: 2, by: 'arisht', verdict: 'approved', waitedMs: 0 }

assert.equal(PERSON_SEND_BACK_LIMIT, 2)
// ASECRM-350 as it is on disk: recorded before reworksBy.person was kept.
const asecrm350 = { reworks: 3, reworksBy: { ci: 1, verification: 1 }, decisions: [sentBack('arisht'), approved] }
assert.equal(personSendBacks(asecrm350), 1, 'THE REGRESSION: the steps\' two send-backs were counted against the reviewer')
assert.equal(PERSON_SEND_BACK_LIMIT - personSendBacks(asecrm350), 1, 'so one send-back is left at its gate')
// Kept from now on, and preferred: a send-back the restart refused is rolled back there, its decision is not.
assert.equal(personSendBacks({ reworks: 4, reworksBy: { ci: 2, person: 0 }, decisions: [sentBack('a')] }), 0)
assert.equal(personSendBacks({ reworks: 2, reworksBy: { person: 2 } }), 2)
assert.equal(personSendBacks({}), 0)
// Carried approvals and everything that is not a send-back do not count.
assert.equal(personSendBacks({ decisions: [approved, { ...approved, auto: true }] }), 0)

// The route and the gate apply the limit to the person's count, and nothing reads the run total for it.
const route = readFileSync(new URL('../server/api/runs/[id]/rework.post.ts', import.meta.url), 'utf8')
assert.doesNotMatch(route, /reworks \?\? 0\) \+ 1\s*\n\s*if \(reworks > 2\)/, 'rework.post.ts caps the run total again')
assert.match(route, /personSendBacks\(before\) \+ 1/)
assert.match(route, /\(before\.reworksBy \?\?= \{\}\)\.person = sentBack/, 'the person\'s count is recorded before the restart')
assert.match(route, /\(current\.reworksBy \?\?= \{\}\)\.person = sentBack - 1/, 'and rolled back when the restart refuses')
const gate = readFileSync(new URL('../app/composables/useGateAnswer.ts', import.meta.url), 'utf8')
assert.match(gate, /reworksLeft = computed\(\(\) => PERSON_SEND_BACK_LIMIT - personSendBacks\(run\.value\)\)/)
const runner = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
assert.match(runner, /p\.handOver && back\.reworksBy\?\.person\) back\.reworksBy\.person -= 1/, 'a parked send-back that never ran gives the person\'s back')

console.log('person send-back allowance: a reviewer\'s send-backs are counted apart from the steps\'')
