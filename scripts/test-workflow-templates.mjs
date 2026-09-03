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

console.log('workflowTemplates: all assertions passed')
