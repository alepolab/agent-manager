/**
 * Whether anyone is asked at all.
 *
 * Runbook C used to stop four times on every run, each gate showing a step
 * label and nothing else. CSUP-7516 — a money-path change to tax arithmetic —
 * went through one of those gates in a single click, which is what a gate
 * becomes when it fires on work that does not need it.
 *
 * So the step flags stay as "a gate MAY fire here" and this decides whether it
 * does, from the blast radius intake already classifies. The rules worth
 * protecting are the two at the ends: cheap work must not stop, and anything
 * unclassified must.
 *
 *   node scripts/test-oversight.mjs
 */
import assert from 'node:assert/strict'

const { oversightFor, needsJustification, oversightReason, BLAST_RADIUS_ORDER } =
  await import('../shared/utils/oversight.ts')

// ── 1. cheap, reversible work flows through ──────────────────────────────────
for (const r of ['docs', 'ui_parsing']) {
  assert.equal(oversightFor(r), 'auto', `${r} must not stop a run: a gate that fires on everything trains reviewers to ignore it`)
  assert.equal(needsJustification(r), false)
}

// ── 2. work that can break a deployment stops for a person ───────────────────
for (const r of ['schema', 'deployment']) {
  assert.equal(oversightFor(r), 'stop', `${r} stops`)
  assert.equal(needsJustification(r), false, `${r} stops, but does not demand prose`)
}

// ── 3. the owner-gated tiers demand a written reason ─────────────────────────
// The cheapest known defence against a gate decaying into a reflex: one
// sentence cannot be written without having read something.
for (const r of ['protocol', 'money']) {
  assert.equal(oversightFor(r), 'justify', `${r} is owner-gated`)
  assert.equal(needsJustification(r), true, `${r} must not be approvable in silence`)
}

// ── 4. unclassified is NOT low risk ──────────────────────────────────────────
// The rule most likely to be written backwards, and the most expensive if it
// is: a run whose intake never classified it is not thereby safe. Absence of
// evidence would otherwise let exactly the runs that went wrong early sail
// through every gate.
for (const missing of [undefined, '', null, 'something-intake-invented']) {
  assert.equal(oversightFor(missing), 'stop', `${String(missing)} must stop, never auto`)
  assert.equal(needsJustification(missing), false, 'it stops, but nobody can justify a tier we do not understand')
}

// ── 5. every tier in the enum has a policy ───────────────────────────────────
// A radius added to the schema without a row here would silently inherit the
// unclassified default, which is safe but silent; this makes it loud.
for (const r of BLAST_RADIUS_ORDER) {
  assert.ok(['auto', 'stop', 'justify'].includes(oversightFor(r)), `${r} has no policy`)
}
assert.deepEqual(BLAST_RADIUS_ORDER, ['docs', 'ui_parsing', 'schema', 'deployment', 'protocol', 'money'],
  'ordered least to most dangerous, matching the evidence-bundle schema')

// ── 6. the reviewer is told why they are being asked ─────────────────────────
// A gate that says only "Approve X to run it" is the one CSUP-7516 walked
// through; the reason is what makes the ask answerable.
assert.match(oversightReason('money'), /money/)
assert.match(oversightReason('money'), /why/i, 'an owner-gated ask says a reason is required')
assert.match(oversightReason(undefined), /no blast radius recorded/i, 'and an unclassified run says so plainly')

console.log('oversight: cheap work flows, owner-gated work is justified, unclassified stops')
