/**
 * A gate may only act on facts, and not knowing must never read as knowing.
 *
 * This is BR-01 to BR-04 as executable rules. Each assertion below is a real
 * failure this estate has already had, generalised:
 *
 *  - Three runs finished `completed` claiming more than their repositories
 *    could show, because prose was accepted as a verdict.
 *  - A review of thirteen runs found the evidence contract honoured by under
 *    half, with no way to tell a complete run from one that never checked.
 *  - A test lock enforced nothing for weeks while looking armed.
 *  - A risk read that could not run was indistinguishable from one that ran
 *    clean, which silently switched human oversight off.
 *
 * The shared shape of all four: `checked and true`, `checked and false`, and
 * `not checked` collapsed into two values instead of three.
 *
 *   node scripts/test-facts.mjs
 */
import assert from 'node:assert/strict'
import {
  derived, indeterminate, freshness, meetsBar, scoreGate, describeCriterion, DEFAULT_MIN_RUNS,
} from '../shared/utils/facts.ts'
import { worldStateOf } from '../server/utils/worldState.ts'

const at = (over = {}) => ({ source: 'oracle-after.xml', capturedAt: 1, head: 'aaa', tree: 't1', runs: 3, ...over })
const now = { head: 'aaa', tree: 't1' }

// ---- BR-01: underivable is a third answer, and it fails closed ----------
{
  const f = indeterminate('no provider for this criterion')
  assert.equal(f.confidence, 'indeterminate')
  assert.equal(f.value, null, 'an underivable fact has no value, not a falsy one')
  assert.equal(freshness(f, now), 'indeterminate')
  const bar = meetsBar(f, now)
  assert.equal(bar.ok, false)
  assert.match(bar.reasons[0], /no provider/, 'the reason must survive to the gate screen')
}

// A derived fact with no provenance is not evidence either. Provenance is the
// whole difference between a fact and an assertion.
{
  const f = { value: true, provenance: null, confidence: 'derived' }
  assert.equal(meetsBar(f, now).ok, false, 'a value with no source cannot be checked against anything')
}

// ---- BR-02: staleness is over the WORKTREE, not the commit --------------
{
  // The exact hole this closes: capture green, edit source WITHOUT committing.
  // HEAD is unchanged, so a commit-only check would call this fresh.
  const f = derived(true, at())
  assert.equal(freshness(f, { head: 'aaa', tree: 't2' }), 'stale',
    'an uncommitted edit must invalidate a capture even though HEAD did not move')
  assert.equal(freshness(f, { head: 'bbb', tree: 't1' }), 'stale', 'a moved commit is decisive too')
  assert.equal(freshness(f, now), 'fresh')
}

// Not knowing the tree is not the same as the tree being unchanged.
{
  const noTreeAtCapture = derived(true, at({ tree: undefined }))
  assert.equal(freshness(noTreeAtCapture, now), 'indeterminate',
    'a capture that recorded no tree cannot be shown to be current')
  const noTreeNow = derived(true, at())
  assert.equal(freshness(noTreeNow, { head: 'aaa' }), 'indeterminate',
    'and neither can one we cannot compare against')
  assert.equal(meetsBar(noTreeNow, { head: 'aaa' }).ok, false, 'so it is not evidence')
  assert.equal(meetsBar(noTreeNow, { head: 'aaa' }, { allowUnknownFreshness: true }).ok, true,
    'unless the caller says this fact has no worktree to be fresh against')
}

// ---- BR-03: a single run is not evidence --------------------------------
{
  assert.equal(DEFAULT_MIN_RUNS, 3, 'the schema floor is three and this must not drift from it')
  const once = derived(true, at({ runs: 1 }))
  const bar = meetsBar(once, now)
  assert.equal(bar.ok, false)
  assert.match(bar.reasons.join(' '), /ran 1 time/, 'and it must say so plainly')
  assert.equal(meetsBar(derived(true, at({ runs: undefined })), now).ok, false,
    'a capture that does not record its run count has not proven three')
  assert.equal(meetsBar(derived(true, at({ runs: 3 })), now).ok, true)
  assert.equal(meetsBar(once, now, { minRuns: 1 }).ok, true, 'a caller may lower the bar deliberately')
}

// ---- BR-01 at the gate: blocked is not pass, and not fail ---------------
{
  const criteria = [
    { id: 'oracle_after', question: 'every row passes', fact: derived(true, at()) },
    { id: 'tests_unmodified', question: 'the oracle is untouched', fact: derived(false, at()) },
    { id: 'trace', question: 'a trace was captured', fact: indeterminate('no provider') },
  ]
  const out = scoreGate(criteria, now)
  assert.equal(out.ok, false)
  assert.deepEqual(out.results.map(r => r.status), ['pass', 'fail', 'blocked'])
  assert.equal(out.blocked.length, 1, 'the underivable criterion blocks')
  assert.equal(out.failed.length, 1, 'and is counted apart from the one that genuinely failed')

  // The distinction is the point: a reviewer told "failed" re-runs the fix, a
  // reviewer told "blocked" goes and writes the provider. Reporting one as the
  // other sends them to do the wrong work.
  assert.notEqual(out.blocked[0].id, out.failed[0].id)
}

// A gate passes only when everything is derived, fresh and repeated.
{
  const out = scoreGate([{ id: 'a', question: 'q', fact: derived(true, at()) }], now)
  assert.equal(out.ok, true)
}

// A stale PASS does not pass. This is the "green about an older tree" case.
{
  const out = scoreGate([{ id: 'a', question: 'q', fact: derived(true, at()) }], { head: 'aaa', tree: 'moved' })
  assert.equal(out.ok, false)
  assert.equal(out.results[0].status, 'blocked', 'stale evidence blocks rather than silently passing')
}

// ---- The gate screen shows facts before judgement -----------------------
{
  const [line] = scoreGate([{ id: 'oracle', question: 'every row passes', fact: derived(true, at()) }], now).results
  const text = describeCriterion(line)
  assert.match(text, /oracle-after\.xml/, 'the source must be on screen')
  assert.match(text, /HEAD aaa/, 'and the commit it was taken at')
  assert.match(text, /3 runs/, 'and how many times it ran')
}

// ---- worldStateOf: unreadable git blocks rather than licenses -----------
{
  const failing = async () => { throw new Error('not a git repository') }
  const state = await worldStateOf('/nowhere', failing)
  assert.deepEqual(state, {}, 'an unreadable repository yields no state rather than a guess')
  assert.equal(freshness(derived(true, at()), state), 'indeterminate',
    'and an empty state makes every fact indeterminate, which blocks — never passes')

  assert.deepEqual(await worldStateOf(undefined), {}, 'no directory is no state')
}

// A clean tree still digests to something: "clean" is a state facts can pin
// to, and returning nothing for it would block every gate on a clean checkout.
{
  const exec = async (_cmd, args) => (args[0] === 'rev-parse' ? 'abc123\n' : '')
  const clean = await worldStateOf('/repo', exec)
  assert.equal(clean.head, 'abc123')
  assert.ok(clean.tree && clean.tree.length === 64, 'a clean tree has a real digest')

  const dirty = await worldStateOf('/repo', async (_c, args) =>
    (args[0] === 'rev-parse' ? 'abc123\n' : ' M src/Foo.java\n'))
  assert.notEqual(dirty.tree, clean.tree, 'and a dirty one differs from it')

  // Order must not change the digest, or a fact would look stale because git
  // happened to list two paths the other way round.
  const a = await worldStateOf('/repo', async (_c, args) =>
    (args[0] === 'rev-parse' ? 'abc123\n' : ' M b.java\n M a.java\n'))
  const b = await worldStateOf('/repo', async (_c, args) =>
    (args[0] === 'rev-parse' ? 'abc123\n' : ' M a.java\n M b.java\n'))
  assert.equal(a.tree, b.tree, 'the digest is over the SET of dirty paths, not their order')
}

console.log('facts: underivable blocks and is counted apart from failed, staleness reads the worktree not the commit, one run is not evidence')
