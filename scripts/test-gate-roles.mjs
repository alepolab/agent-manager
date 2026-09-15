/**
 * Whose decision a gate is.
 *
 * `answerGate` says a person may answer *a* gate. It does not say which. Both
 * developer and QA hold it, so without an owner on the step a developer could
 * accept QA's verification of their own change — the one review the runbook
 * deliberately puts in someone else's hands. The runbooks already asserted the
 * mapping in their own comments ("Gate 3 of 4: verification. QA answers this
 * one"); this makes them assert it in data, and keeps them asserting it.
 *
 * The invariant worth protecting is the first one below: a gate added later
 * without an owner is a gate everyone and no one is responsible for, and it
 * would pass every other test in this suite.
 *
 *   node scripts/test-gate-roles.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { workflowTemplates, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')
const { ROLES } = await import('../shared/types/role.ts')

// ── 1. every shipped gate declares an owner ──────────────────────────────────
{
  const gates = workflowTemplates.flatMap(t =>
    t.steps.filter(s => s.approval).map(s => ({ template: t.id, label: s.label, gateRole: s.gateRole })))

  assert.ok(gates.length >= 6, `expected the shipped runbooks to carry gates, found ${gates.length}`)
  for (const g of gates) {
    assert.ok(g.gateRole,
      `"${g.label}" in ${g.template} stops a run for a person and does not say which person`)
    assert.ok(ROLES.includes(g.gateRole),
      `"${g.label}" names a role that does not exist: ${g.gateRole}`)
  }
}

// ── 2. verification belongs to QA, the diff to the developer ─────────────────
// The two the runbook comments are explicit about. Asserted by label so that
// renaming a step cannot silently move who owns it.
{
  const c = workflowTemplates.find(t => t.id.startsWith('runbook-c'))
  assert.ok(c, 'Runbook C is shipped')
  const ship = c.steps.find(s => s.label === 'Push + PR')
  assert.equal(ship?.gateRole, 'qa',
    'the verification gate is QA\'s: the automated and manual QA reports and the security review are all in before anything is pushed')

  const work = c.steps.find(s => s.label === 'Implement Fix')
  assert.equal(work?.gateRole, 'developer', 'approving the plan before an agent builds from it is the developer\'s call')

  // A manager holds no answerGate at all, so a gate owned by one could never be
  // answered by anybody but an operator. Nothing should ever be assigned there.
  const owners = new Set(workflowTemplates.flatMap(t => t.steps.filter(s => s.approval).map(s => s.gateRole)))
  assert.ok(!owners.has('manager'), 'a manager cannot answer a gate, so no gate may be addressed to one')
}

// ── 3. the owner survives materialization ────────────────────────────────────
// Templates refer to steps by agentTemplateId; the workflow that reaches the
// runner refers to generated ids. A field dropped in that translation is
// exactly how blast_radius came to be silently absent for every run.
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'a', label: 'Plain', next: ['b'] },
      { agentTemplateId: 'b', label: 'Gated', approval: true, gateRole: 'qa' },
    ],
  }
  const steps = materializeTemplateSteps(template, { a: 'agent-a', b: 'agent-b' })

  const gated = steps.find(s => s.label === 'Gated')
  assert.equal(gated.approval, true)
  assert.equal(gated.gateRole, 'qa', 'the owner reaches the workflow the runner executes')

  const plain = steps.find(s => s.label === 'Plain')
  assert.ok(!('gateRole' in plain), 'a step with no owner gets no key, rather than an explicit undefined')
}

// ── 4. the runner stamps the owner onto the question it raises ───────────────
// The half a template test cannot see: the gate is raised by the runner, and a
// reviewer is refused by comparing their role against run.question.role.
{
  process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'gaterole-'))
  process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'gaterole-artifacts-'))

  const runner = await import('../server/utils/workflowRunner.ts')
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
  runner.setAgentCaller(async agentSlug => `out ${agentSlug}`)

  const workflow = {
    slug: 'roles', name: 'Roles',
    steps: [
      { id: 'a', agentSlug: 'agent-a', label: 'Work', next: ['b'] },
      { id: 'b', agentSlug: 'agent-b', label: 'Ship', next: [], approval: true, gateRole: 'qa' },
    ],
  }
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const paused = await runner.waitForSettled(started.id, 8000)

  assert.equal(paused.status, 'paused', 'an unclassified run still stops at its gate')
  assert.equal(paused.question?.kind, 'approval')
  assert.equal(paused.question?.role, 'qa', 'the question carries the owner the step declared')
  assert.match(paused.question.text, /qa's decision/, 'and says so to whoever reads it')

  // A gate with no declared owner stays everyone's: refusing those would strand
  // every run recorded before gateRole existed.
  const open = {
    slug: 'roles-open', name: 'Open',
    steps: [{ id: 'a', agentSlug: 'agent-a', label: 'Ship', next: [], approval: true }],
  }
  const s2 = await runner.startRun({ workflow: open, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const p2 = await runner.waitForSettled(s2.id, 8000)
  assert.equal(p2.status, 'paused')
  assert.equal(p2.question?.role, undefined, 'a gate that names no owner is anyone with answerGate')
}

console.log('gate roles: every shipped gate has an owner, it survives materialization, and the runner stamps it')
