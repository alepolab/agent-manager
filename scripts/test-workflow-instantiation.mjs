/**
 * Self-check for planTemplateResolution in app/utils/workflowInstantiation.ts -
 * the decision logic app/pages/workflows/index.vue calls before
 * materializeTemplateSteps() to work out which agentTemplateIds (a step's own,
 * AND every step's monitorSlug) need turning into a real agent slug, and which
 * of those already have an existing agent to reuse.
 *
 * This is the regression test for the bug fixed on this branch: the map used
 * to be built from step agentTemplateIds only, so a template's
 * `monitorSlug: 'sdlc-step-monitor'` resolved to nothing and
 * materializeTemplateSteps() silently dropped it - every monitor review
 * became a no-op CONTINUE with no error anywhere.
 *
 *   node scripts/test-workflow-instantiation.mjs
 */
import assert from 'node:assert/strict'
import { planTemplateResolution } from '../app/utils/workflowInstantiation.ts'

const AGENT_TEMPLATES = [
  { id: 'alpha', icon: '', frontmatter: { name: 'agent-alpha', description: '', model: 'sonnet' }, body: 'alpha body' },
  { id: 'beta', icon: '', frontmatter: { name: 'agent-beta', description: '', model: 'sonnet' }, body: 'beta body' },
  { id: 'monitor', icon: '', frontmatter: { name: 'agent-monitor', description: '', model: 'sonnet' }, body: 'monitor body' },
]

// ── 1. A monitorSlug resolves into the map - the regression ───────────────
// Without the monitor-resolution pass, `resolved`/`toCreate` never mention
// 'monitor' at all, and materializeTemplateSteps() would silently drop the
// monitorSlug downstream.
{
  const template = {
    steps: [
      { agentTemplateId: 'alpha', label: 'A', monitorSlug: 'monitor' },
    ],
  }
  const plan = planTemplateResolution(template, AGENT_TEMPLATES, [])
  const allIds = new Set([...Object.keys(plan.resolved), ...plan.toCreate])
  assert.ok(allIds.has('monitor'),
    'a template step with monitorSlug: "monitor" must resolve the monitor id - this is the regression that must not silently return')
  assert.ok(plan.toCreate.includes('monitor'), 'the monitor has no existing agent, so it must be queued for creation')
}

// ── 2. The monitor is resolved but never added as a pipeline step ─────────
{
  const template = {
    steps: [
      { agentTemplateId: 'alpha', label: 'A', monitorSlug: 'monitor' },
    ],
  }
  const plan = planTemplateResolution(template, AGENT_TEMPLATES, [])
  assert.equal(plan.steps.length, 1, 'the monitor must not become its own pipeline step')
  assert.deepEqual(plan.steps.map(s => s.agentTemplateId), ['alpha'])
}

// ── 3. An existing agent is reused rather than duplicated ─────────────────
{
  const template = {
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
    ],
  }
  const existingAgents = [
    { slug: 'agent-alpha', frontmatter: { name: 'agent-alpha', description: '' } },
  ]
  const plan = planTemplateResolution(template, AGENT_TEMPLATES, existingAgents)
  assert.equal(plan.resolved.alpha, 'agent-alpha', 'an existing agent whose slug matches the template name must be reused')
  assert.equal(plan.toCreate.length, 0, 'nothing should be queued for creation when the agent already exists')
}

// ── 4. A template with no monitors still works exactly as before ──────────
{
  const template = {
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const plan = planTemplateResolution(template, AGENT_TEMPLATES, [])
  assert.equal(plan.steps.length, 2)
  assert.deepEqual(plan.steps.map(s => s.agentTemplateId), ['alpha', 'beta'])
  assert.deepEqual(plan.toCreate.sort(), ['alpha', 'beta'])
  assert.deepEqual(plan.resolved, {})
}

// ── 5. A step naming an agent template that no longer exists is dropped ───
// (same behaviour materializeTemplateSteps() already has for a dangling
// `next`/`monitorSlug` - this extraction must not change it)
{
  const template = {
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'ghost', label: 'Gone' },
    ],
  }
  const plan = planTemplateResolution(template, AGENT_TEMPLATES, [])
  assert.deepEqual(plan.steps.map(s => s.agentTemplateId), ['alpha'])
  assert.ok(!('ghost' in plan.resolved) && !plan.toCreate.includes('ghost'))
}

console.log('workflowInstantiation: all assertions passed')
