/**
 * Self-check for materializeTemplateSteps in app/utils/workflowTemplates.ts - turning a
 * template's local ids into a real workflow's generated step ids, edges included.
 *
 *   node scripts/test-workflow-templates.mjs
 */
import assert from 'node:assert/strict'
import { materializeTemplateSteps } from '../app/utils/workflowTemplates.ts'

const slugs = { alpha: 'agent-alpha', beta: 'agent-beta', gamma: 'agent-gamma' }

// ── 1. A template with no `next` stays a plain chain ──────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map(s => s.agentSlug), ['agent-alpha', 'agent-beta'])
  assert.deepEqual(steps.map(s => s.label), ['A', 'B'])
  // No explicit edges - the graph builder reads these in array order, as it does today.
  assert.equal(steps[0].next, undefined)
  assert.equal(steps[1].next, undefined)
}

// ── 2. Every step gets its own unique generated id ────────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(new Set(steps.map(s => s.id)).size, 2)
  assert.ok(steps.every(s => typeof s.id === 'string' && s.id.length > 0))
}

// ── 3. `next` is translated from template ids to generated step ids ───────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'beta', label: 'B', next: ['gamma'] },
      { agentTemplateId: 'gamma', label: 'C', next: [] },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))

  assert.deepEqual(byLabel.A.next, [byLabel.B.id, byLabel.C.id], 'A fans out to B and C')
  assert.deepEqual(byLabel.B.next, [byLabel.C.id], 'B joins into C')
  // An explicit empty `next` marks a terminal node and must survive as an empty array,
  // not collapse to "no edges declared".
  assert.deepEqual(byLabel.C.next, [])
  // Nothing may still be pointing at a template-local id.
  const ids = new Set(steps.map(s => s.id))
  for (const step of steps) for (const target of step.next ?? []) assert.ok(ids.has(target))
}

// ── 4. The same agent template used twice gets two distinct step ids ──────
// Before the fix, ids were keyed by `agentTemplateId`, so both steps collapsed
// onto the same generated id and the repeated step became unreachable
// (stepById()/indexOf() only ever resolve the first match).
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'First Alpha', next: ['beta'] },
      { agentTemplateId: 'beta', label: 'Beta', next: ['alpha'] },
      { agentTemplateId: 'alpha', label: 'Second Alpha' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(steps.length, 3)
  assert.equal(new Set(steps.map(s => s.id)).size, 3, 'every step must get its own unique id, even when agentTemplateId repeats')
  assert.deepEqual(steps.map(s => s.agentSlug), ['agent-alpha', 'agent-beta', 'agent-alpha'])
  assert.deepEqual(steps.map(s => s.label), ['First Alpha', 'Beta', 'Second Alpha'])
}

// ── 5. A `next` naming a step that got filtered out drops that target ─────
// The caller filters `template.steps` down to steps whose agent template resolved
// before calling materializeTemplateSteps, so `agentSlugByTemplateId`/the passed-in
// `template.steps` may be missing an id that an earlier step's `next` still names
// (its agent template failed to resolve). That must not survive as `undefined`.
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      // 'beta' is referenced here but never appears in `steps` below - simulates
      // its agent template having failed to resolve, so the caller dropped it.
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'gamma', label: 'C', next: [] },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))
  // The unresolved 'beta' target is dropped; the still-resolvable 'gamma' target survives.
  assert.deepEqual(byLabel.A.next, [byLabel.C.id])
  // No `undefined`/`null` ever leaks into a `next` array.
  for (const step of steps) for (const target of step.next ?? []) assert.notEqual(target, undefined)
}

// ── 6. A `next` whose EVERY target got filtered out falls back to array order ──
// Dropping every target would otherwise leave `next: []`, which buildGraph treats
// as a deliberate terminal step (NOT the same as `next: undefined`, which falls
// back to array order) - silently truncating the workflow at exactly the step
// that was supposed to keep it going. Losing all targets is a gap, not a
// declared stop, so `next` is left unset instead so array order takes over.
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      // Both of A's declared targets are missing from `steps` (filtered out upstream).
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'delta', label: 'D' },
    ],
  }
  const steps = materializeTemplateSteps(template, { ...slugs, delta: 'agent-delta' })
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))
  assert.equal(byLabel.A.next, undefined, 'losing every declared target must fall back to array order, not collapse to an empty terminal next')

  // An explicit empty `next` (a genuine declared terminal step) is a different case
  // and must NOT be reinterpreted as "targets were lost" - it stays `[]`.
  const terminalTemplate = {
    id: 't2', name: 'T2', description: '', icon: '',
    steps: [{ agentTemplateId: 'alpha', label: 'A', next: [] }],
  }
  const terminalSteps = materializeTemplateSteps(terminalTemplate, slugs)
  assert.deepEqual(terminalSteps[0].next, [])
}

console.log('workflowTemplates: all assertions passed')
