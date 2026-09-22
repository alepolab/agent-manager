/**
 * A story, spec or security gate must not be skipped by a cheap blast radius.
 *
 * The defect this closes: the runner's gate predicate was
 * `oversightFor(run.blastRadius) !== 'auto'`, a pure function of the run's
 * classification. `docs` and `ui_parsing` map to `auto`, so on a watch capped
 * at `ui_parsing` — which is every ticket `bss-change-requests` can dispatch —
 * a SPEC gate would never have fired at all. The one decision the spec-first
 * pipeline is built around would have been silently skipped on the only queue
 * that needs it.
 *
 * A floor may only ever RAISE oversight, never lower it: a `money` change
 * still demands a written reason at every gate, floored or not. That direction
 * is asserted below, because a floor that could lower a tier would be a way to
 * route around the very controls it sits beside.
 *
 *   node scripts/test-gate-kinds.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { oversightFor, oversightForGate, needsJustification, oversightReason } from '../shared/utils/oversight.ts'
import { materializeTemplateSteps } from '../app/utils/workflowTemplates.ts'

// A cheap tier still stops at the gates whose question it cannot answer.
for (const cheap of ['docs', 'ui_parsing']) {
  assert.equal(oversightFor(cheap), 'auto', `${cheap} is meant to be an auto tier`)
  assert.equal(oversightForGate(cheap, 'story'), 'stop', `${cheap} must still stop at STORY`)
  assert.equal(oversightForGate(cheap, 'spec'), 'stop', `${cheap} must still stop at SPEC`)
  assert.equal(oversightForGate(cheap, 'security'), 'justify', `${cheap} must still justify at SECURITY`)
  // Unfloored gates are untouched: this is not a per-step "always stop".
  assert.equal(oversightForGate(cheap, 'impl'), 'auto', `${cheap} must still flow through IMPL`)
  assert.equal(oversightForGate(cheap, 'verify'), 'auto', `${cheap} must still flow through VERIFY`)
  assert.equal(oversightForGate(cheap, undefined), 'auto', 'a step with no gateKind tiers as before')
}

// A floor raises and never lowers.
assert.equal(oversightForGate('money', 'story'), 'justify', 'money must not be softened to stop by a story floor')
assert.equal(oversightForGate('protocol', 'spec'), 'justify', 'protocol must not be softened by a spec floor')
assert.equal(oversightForGate('schema', 'security'), 'justify', 'security floor raises schema from stop to justify')
assert.equal(oversightForGate('schema', 'impl'), 'stop', 'an unfloored gate keeps the tier exactly')

// Unclassified is still the safe direction, floored or not.
assert.equal(oversightForGate(undefined, 'impl'), 'stop', 'unclassified still stops')
assert.equal(oversightForGate(undefined, 'security'), 'justify', 'unclassified at security still justifies')

// Justification follows the floored value, not the bare tier — otherwise a
// security gate on a docs change would accept a bare click.
assert.equal(needsJustification('docs'), false, 'docs alone needs no written reason')
assert.equal(needsJustification('docs', 'security'), true, 'docs at SECURITY needs a written reason')

// The reason shown to the reviewer explains the floor rather than reciting a
// tier that plainly says the opposite.
const storyReason = oversightReason('docs', 'story')
assert.ok(!/flows through without a gate/.test(storyReason), 'a floored gate must not tell the reviewer it flows through')
assert.ok(/right thing to build/.test(storyReason), `story floor should say why it is asking: ${storyReason}`)
assert.ok(/security-relevant/.test(oversightReason('docs', 'security')), 'security floor should name the reason')

// The materializer's whitelist drops unknown fields in silence, which is how a
// gate would lose its kind between the template and the runner. Assert the
// field survives the trip.
const [step] = materializeTemplateSteps({
  name: 'gate-kind probe',
  description: 'one gated step, to prove the field survives the whitelist',
  steps: [{
    agentTemplateId: 'qa-reviewer',
    label: 'Spec',
    approval: true,
    gateRole: 'product-owner',
    gateKind: 'spec',
  }],
}, { 'qa-reviewer': 'qa-reviewer' })
assert.equal(step.gateKind, 'spec', 'materializeTemplateSteps must carry gateKind through to the runner')
assert.equal(step.gateRole, 'product-owner', 'the new role survives materialization too')

// The runner must actually consult the floored function. A grep, because the
// alternative is standing up a whole run: the specific regression is someone
// reverting to the bare `oversightFor(run.blastRadius)` predicate.
const runner = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
assert.ok(runner.includes('oversightForGate(run.blastRadius'),
  'the runner gate predicate must use oversightForGate, not oversightFor')
assert.ok(/needsJustification\(run\.blastRadius, run\.question\.gateKind\)/.test(runner),
  'continueRun must weigh justification against the gate kind, not the bare tier')

console.log('gate kinds: story, spec and security stop on a cheap tier; floors raise and never lower; the field survives materialization')
