/**
 * The full-lifecycle template must be a well-formed graph whose gates survive
 * materialization, and whose agent ids are unambiguous.
 *
 * Three specific regressions this guards, all of them silent failures rather
 * than errors:
 *
 *  - A repeated `agentTemplateId`. The materializer resolves `next` by
 *    template id and the LAST step wins as the translation target, so a
 *    template naming one agent twice routes some predecessor at the wrong
 *    step, and nothing complains.
 *  - A gate losing its `gateKind` on the way through the whitelist, which
 *    reverts a story, spec or security gate to blast-radius tiering — and on a
 *    `docs`-class change that means it never fires.
 *  - A `next` naming a step that does not exist, which is dropped in silence
 *    and truncates the graph.
 *
 *   node scripts/test-sdlc-template.mjs
 */
import assert from 'node:assert/strict'
import { workflowTemplates, materializeTemplateSteps } from '../app/utils/workflowTemplates.ts'
import { oversightForGate } from '../shared/utils/oversight.ts'

const t = workflowTemplates.find(x => x.id === 'oma-sdlc-jira-to-pr')
assert.ok(t, 'the full-lifecycle template must be registered')

// Every agent appears exactly once, or `next` resolution is ambiguous.
const ids = t.steps.map(s => s.agentTemplateId)
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
assert.deepEqual(dupes, [], `repeated agentTemplateId makes next routing ambiguous: ${dupes.join(', ')}`)

// Every `next` target exists in the template.
for (const step of t.steps) {
  for (const target of step.next ?? []) {
    assert.ok(ids.includes(target), `${step.agentTemplateId} points next at "${target}", which is not a step in this template`)
  }
}

// The front of the pipeline exists: a story and a spec decision before any
// implementation step. This is the whole reason the template was added — the
// two shipped before it start at intake and go straight to a fix.
const labels = t.steps.map(s => s.label)
const implAt = t.steps.findIndex(s => /^Implement /.test(s.label))
const storyAt = t.steps.findIndex(s => s.gateKind === 'story')
const specAt = t.steps.findIndex(s => s.gateKind === 'spec')
assert.ok(storyAt >= 0, 'template must carry a story gate')
assert.ok(specAt >= 0, 'template must carry a spec gate')
assert.ok(implAt >= 0, 'template must implement something')
assert.ok(storyAt < implAt, 'the story gate must precede implementation')
assert.ok(specAt < implAt, 'the spec gate must precede implementation')

// Materialize the way teamSync does — an identity slug map — and assert the
// gates survive the whitelist.
const slugs = {}
for (const s of t.steps) {
  slugs[s.agentTemplateId] = s.agentTemplateId
  if (s.monitorSlug) slugs[s.monitorSlug] = s.monitorSlug
}
const steps = materializeTemplateSteps(t, slugs)
assert.equal(steps.length, t.steps.length, 'no step may be dropped during materialization')

const gates = steps.filter(s => s.approval)
assert.ok(gates.length >= 6, `expected the full gate set, got ${gates.length}`)
for (const g of gates) {
  assert.ok(g.gateRole, `gate "${g.label}" must name whose decision it is`)
}

// The floored gates keep their kind, and therefore still fire on a cheap tier.
const byKind = Object.fromEntries(steps.filter(s => s.gateKind).map(s => [s.gateKind, s]))
for (const kind of ['story', 'spec', 'security']) {
  assert.ok(byKind[kind], `the ${kind} gate lost its gateKind during materialization`)
  assert.notEqual(oversightForGate('ui_parsing', kind), 'auto',
    `the ${kind} gate must still fire on a ui_parsing-class change`)
}

// The CTO gate is deliberately NOT floored: it must stay rare, or it becomes
// the fire-on-everything gate this estate already rejected once in writing.
const cto = steps.find(s => s.gateRole === 'cto')
assert.ok(cto, 'template must carry a CTO escalation step')
assert.equal(cto.gateKind, undefined, 'the CTO gate must tier, not floor — it is an escalation, not a checkpoint')
assert.equal(oversightForGate('docs', undefined), 'auto', 'a docs change must not stop at the CTO gate')

// Release, deploy and rollback are deliberately absent: a run must stay
// terminal at PR-open. See the template's own comment.
assert.ok(!t.steps.some(s => s.deploy), 'release must not be wired into the run graph')

// Exactly one step owns the tests, and it is not an implementation step.
const unlocked = t.steps.filter(s => s.testsUnlocked).map(s => s.label)
assert.ok(unlocked.length >= 1, 'some step must own the oracle')
for (const l of unlocked) {
  assert.ok(!/^Implement /.test(l), `an implementation step must never hold the test unlock: ${l}`)
}

console.log(`sdlc template: ${steps.length} steps, ${gates.length} gates, story+spec before implementation, floored gates survive materialization, release stays out of the run`)
