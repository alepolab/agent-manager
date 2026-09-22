/**
 * A risk read that did not happen must not read as a clean one.
 *
 * `agentFloorFrom` is the only control that can look at ordinary Java and
 * notice the money arithmetic no path rule can see. It returned a bare
 * `string | null`, which collapsed three different facts into one value:
 *
 *   - there were no paths to read
 *   - the model read the diff and found nothing dangerous
 *   - the model was disabled, timed out, or answered with junk
 *
 * The caller treated all three the same, so an outage of the light agent was
 * indistinguishable from a clean bill of health. And because `floorFrom`
 * deliberately never asserts a LOW class — path evidence cannot rule danger
 * out — `docs` and `ui_parsing` rest entirely on the proposal of the party the
 * classification governs. Those are exactly the two classes that map to
 * `auto`, which fires no gate at all.
 *
 * Net effect of the old shape: a model outage silently switched human
 * oversight off for any run whose step claimed a low class. This asserts the
 * three facts stay apart, and that an uncorroborated low claim leaves the run
 * unclassified — which oversight.ts already stops.
 *
 *   node scripts/test-risk-read-failure.mjs
 */
import assert from 'node:assert/strict'
import { agentFloorFrom, setAsker } from '../server/utils/lightAgent.ts'
import { oversightFor } from '../shared/utils/oversight.ts'
import { floorFrom, adopt } from '../shared/utils/classification.ts'

// ---- the three facts are distinguishable --------------------------------

// Nothing to read is a complete read of nothing, not a failure.
{
  const r = await agentFloorFrom([])
  assert.deepEqual(r, { read: true, class: null }, 'an empty diff is read, not unread')
}

// The model answered and found nothing dangerous.
setAsker(async () => JSON.stringify({ class: null }))
{
  const r = await agentFloorFrom(['src/Foo.java'])
  assert.equal(r.read, true, 'a real answer counts as read')
  assert.equal(r.class, null, 'and it named no class')
}

// The model answered with a class.
setAsker(async () => JSON.stringify({ class: 'money' }))
{
  const r = await agentFloorFrom(['src/Rating.java'])
  assert.deepEqual(r, { read: true, class: 'money' })
}

// The model was unavailable — this is the case that used to look clean.
setAsker(async () => null)
{
  const r = await agentFloorFrom(['src/Rating.java'])
  assert.equal(r.read, false, 'an unavailable model must report that it did not read')
  assert.equal(r.class, null)
}

// The model answered with junk. Same thing: the control did not produce a
// verdict, so it did not run.
setAsker(async () => 'I am not JSON and never will be')
{
  const r = await agentFloorFrom(['src/Rating.java'])
  assert.equal(r.read, false, 'an unparseable answer is not a read')
}
setAsker(undefined)

// ---- why it matters: a low class has no other corroboration -------------

// floorFrom never asserts a low class, by design. So `docs` and `ui_parsing`
// can only ever arrive from a proposal.
for (const paths of [['src/Foo.java'], ['README.md'], ['app/pages/index.vue']]) {
  assert.equal(floorFrom(paths), null,
    `path rules must never assert a low class (${paths[0]}) — they cannot rule danger out`)
}

// And those two classes are exactly the ones that fire no gate.
assert.equal(oversightFor('docs'), 'auto')
assert.equal(oversightFor('ui_parsing'), 'auto')

// So adopting an uncorroborated low proposal hands every gate away on the
// word of the step being judged.
assert.deepEqual(
  adopt({ proposed: 'ui_parsing', floor: null }),
  { adopted: 'ui_parsing', source: 'proposal' },
  'adopt itself still reports the claim; the runner is what must refuse it',
)

// Unclassified is the safe resting place, and it already exists.
assert.equal(oversightFor(undefined), 'stop',
  'leaving the run unclassified must stop it — this is the behaviour the fix reuses')

// ---- the runner refuses the uncorroborated low claim --------------------
// Asserted against the source: standing up a whole run to observe one branch
// costs more than it proves, and the specific regression is someone deleting
// the guard or reverting agentFloorFrom to a bare string.
const runner = (await import('node:fs')).readFileSync(
  new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
assert.ok(/riskRead = read\.read/.test(runner),
  'the runner must record WHETHER the risk read happened, not only what it said')
assert.ok(/if \(!riskRead && floor === null && proposed !== null && LOW\.includes\(proposed\)\)/.test(runner),
  'the runner must refuse an uncorroborated low class when the risk read did not run')

console.log('risk read: unavailable is not clean, a low class has no corroboration but the read, and an unread low claim leaves the run stopping')
