/**
 * SME routing: which person a gate goes to, and the SLA clock over it.
 *
 * The rules this pins: nothing configured means no assignee and no change;
 * review gates round-robin over product_sme; QA gates go to qa_lead; a
 * specialist tier goes to the architect first; a person at the WIP cap is
 * passed over; a delegation redirects whoever was picked; the SLA tick says
 * "due" once and escalates to the pod lead once, never twice.
 *
 *   node scripts/test-sme-routing.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'sme-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'sme-runs-'))
process.env.AGENT_REGISTRY_PATH = join(process.env.CLAUDE_DIR, 'products.yaml')
process.env.CI_POLLER_DISABLED = '1'

const registry = (owners) => `products:
  crm:
    match:
      projects: [CRM]
    repos: [alepolab/crm]
    branches: { bug: develop, feature: develop }
    stack: { compose: infra/crm, topology_default: 1node }
    tests: { unit: 'make test' }
    owners:
${owners}
`
writeFileSync(process.env.AGENT_REGISTRY_PATH, registry('      protocol: crm-leads'))
mkdirSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true })

const sme = await import('../server/utils/smeDirectory.ts')
const sla = await import('../server/utils/smeSla.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const { SME_SLA_MS, SME_ESCALATION_MS, DEFAULT_SME_WIP_CAP } = await import('../shared/types/sme.ts')
const { buildNotifications } = await import('../shared/utils/notifications.ts')
const { recordDecision, humanMinutes } = await import('../shared/utils/runDecisions.ts')

const HOUR = 3_600_000
const now = Date.now()
const mkRun = (id, extra = {}) => ({
  id, workflowSlug: 'wf', workflowName: 'Runbook A', status: 'paused', autoRun: true, initialPrompt: 'CRM-1 fix', watch: 'direct-invocation',
  ticketKey: 'CRM-1', steps: [{ stepId: 'review', label: 'Dev Done review', agentSlug: 'x', status: 'pending', input: '', output: '', visits: 0 }],
  currentStepIds: [], nextStepIds: ['review'], startedAt: now - HOUR, budget: { maxMinutes: 1, maxTokens: 1 }, pid: 1,
  product: { name: 'crm', repos: ['alepolab/crm'], branches: {}, stack: { compose: 'x', topology_default: '1node' }, tests: {} },
  question: { stepId: 'review', text: 'Approve?', kind: 'approval', askedAt: now },
  ...extra,
})

// ── 1. nothing configured: no assignee, no change ─────────────────────────
{
  const r = mkRun('r0')
  assert.equal(await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: [], delegations: [] }), null, 'no SMEs, no roles.json: nobody is picked')
  assert.equal(await sme.assignOpenGate(r, { label: 'Dev Done review' }), null)
  assert.equal(r.question.assignee, undefined, 'the gate is untouched')
  assert.equal(r.smeAssignments, undefined)
}

// ── 2. review gates round-robin over product_sme; QA gates go to qa_lead ──
writeFileSync(process.env.AGENT_REGISTRY_PATH, registry(`      protocol: crm-leads
      product_sme: [alice, bob]
      architect: carol
      qa_lead: dave`))
{
  const r = mkRun('r1')
  const a1 = await sme.assignOpenGate(r, { label: 'Dev Done review' })
  assert.equal(a1.assignee, 'alice', 'first review gate goes to the first SME')
  assert.equal(a1.via, 'product_sme')
  assert.equal(a1.dueAt, a1.assignedAt + SME_SLA_MS, 'due four hours after assignment')
  assert.equal(r.question.assignee, 'alice', 'the gate names the person')
  assert.deepEqual(r.smeAssignments.map(a => a.assignee), ['alice'])

  // The same run's next review gate moves on to bob.
  r.question = { stepId: 'review2', text: 'Approve PR?', kind: 'approval', askedAt: now }
  const a2 = await sme.assignOpenGate(r, { label: 'PR review' })
  assert.equal(a2.assignee, 'bob', 'round-robin advances past the last SME this run used')
  r.question = { stepId: 'review3', text: 'Approve?', kind: 'approval', askedAt: now }
  assert.equal((await sme.assignOpenGate(r, { label: 'Approve merge' })).assignee, 'alice', 'and wraps')

  const qa = mkRun('r2', { question: { stepId: 'qa', text: 'Verify?', kind: 'approval', askedAt: now, role: 'qa' } })
  const aq = await sme.assignOpenGate(qa, { label: 'QA Done', gateRole: 'qa' })
  assert.equal(aq.assignee, 'dave', 'a QA gate goes to the qa_lead')
  assert.equal(aq.via, 'qa_lead')

  // The notifications inbox and the queue name the person.
  const [item] = buildNotifications([r], [], 'developer')
  assert.equal(item.assignee, 'alice')
}

// ── 3. a specialist tier goes to the architect first ──────────────────────
{
  const r = mkRun('r3', { blastRadius: 'money' })
  const a = await sme.assignOpenGate(r, { label: 'Dev Done review' })
  assert.equal(a.assignee, 'carol', 'money is owner-gated, so the architect reviews first')
  assert.equal(a.via, 'specialist')
  const d = mkRun('r4', { blastRadius: 'docs' })
  assert.equal((await sme.assignOpenGate(d, { label: 'Dev Done review' })).assignee, 'alice', 'docs is not')
}

// ── 4. the WIP cap passes a loaded person over ────────────────────────────
{
  const busy = Array.from({ length: DEFAULT_SME_WIP_CAP }, (_, i) => mkRun(`busy-${i}`, { question: { stepId: 'review', text: 'x', kind: 'approval', askedAt: now, assignee: 'alice' } }))
  const r = mkRun('r5')
  const a = await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: busy, delegations: [] })
  assert.equal(a.assignee, 'bob', 'alice holds four open gates, so bob is asked')
  // A settled run's gate does not count.
  const settled = busy.map(b => ({ ...b, status: 'completed' }))
  assert.equal((await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: settled, delegations: [] })).assignee, 'alice')
  // Everyone over: the first is still named, since no owner is the real failure.
  const all = [...busy, ...busy.map(b => ({ ...b, id: `${b.id}-b`, question: { ...b.question, assignee: 'bob' } }))]
  assert.equal((await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: all, delegations: [] })).assignee, 'alice')
  // The cap is a setting.
  writeFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager: { sme: { wipCap: 10, podLeads: { crm: 'erin' } } } }))
  assert.equal(sme.wipCap(), 10)
  assert.equal((await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: busy, delegations: [] })).assignee, 'alice', 'under a cap of ten, alice is fine')
}

// ── 5. delegations redirect, within their dates and product ───────────────
{
  const day = (offset) => new Date(now + offset * 24 * HOUR).toISOString().slice(0, 10)
  const ds = [{ from: 'alice', to: 'frank', product: 'crm', fromDate: day(-1), until: day(1) }]
  assert.deepEqual(sme.resolveDelegate('alice', 'crm', ds, now), { assignee: 'frank', delegatedFrom: 'alice' })
  assert.deepEqual(sme.resolveDelegate('alice', 'billing', ds, now), { assignee: 'alice' }, 'another product is not covered')
  assert.deepEqual(sme.resolveDelegate('alice', 'crm', ds, now + 5 * 24 * HOUR), { assignee: 'alice' }, 'nor another week')
  const endOfUntil = Date.parse(ds[0].until) + 24 * HOUR - 1
  assert.deepEqual(sme.resolveDelegate('alice', 'crm', ds, endOfUntil), { assignee: 'frank', delegatedFrom: 'alice' }, 'a bare `until` date covers its whole day')
  assert.deepEqual(sme.resolveDelegate('alice', 'crm', ds, endOfUntil + 1), { assignee: 'alice' }, 'and not a millisecond more')
  // A cycle terminates.
  const loop = [{ from: 'a', to: 'b', fromDate: day(-1), until: day(1) }, { from: 'b', to: 'a', fromDate: day(-1), until: day(1) }]
  assert.equal(sme.resolveDelegate('a', undefined, loop, now).assignee, 'b')

  const r = mkRun('r6')
  const a = await sme.routeGate(r, { stepId: 'review', label: 'Dev Done review' }, { runs: [], delegations: ds })
  assert.equal(a.assignee, 'frank')
  assert.equal(a.delegatedFrom, 'alice')

  // The file store round-trips and refuses nonsense.
  await sme.addDelegation(ds[0])
  assert.deepEqual(await sme.listDelegations(), ds)
  assert.match(sme.delegationProblem({ from: 'a', to: 'a', fromDate: day(0), until: day(1) }), /same person/)
  assert.match(sme.delegationProblem({ from: 'a', to: 'b', fromDate: day(1), until: day(0) }), /before/)
  assert.match(sme.delegationProblem({ from: 'a', to: 'b', fromDate: 'soon', until: day(0) }), /not a date/)
}

// ── 6. gate kinds ─────────────────────────────────────────────────────────
{
  assert.equal(sme.gateKindOf({ label: 'QA Done' }), 'qa')
  assert.equal(sme.gateKindOf({ label: 'Verification', gateRole: 'qa' }), 'verification')
  assert.equal(sme.gateKindOf({ label: 'Plan approval' }), 'plan')
  assert.equal(sme.gateKindOf({ label: 'Dev Done' }), 'review')
  assert.equal(sme.gateKindOf({ label: 'Deploy' }), 'other')
}

// ── 7. the operator fallback from roles.json ──────────────────────────────
{
  writeFileSync(process.env.AGENT_REGISTRY_PATH, registry('      protocol: crm-leads'))
  writeFileSync(join(process.env.CLAUDE_DIR, 'roles.json'), JSON.stringify({ gina: 'developer', hank: 'operator' }))
  const a = await sme.routeGate(mkRun('r7'), { stepId: 'review', label: 'Dev Done review' }, { runs: [], delegations: [] })
  assert.equal(a.assignee, 'hank', 'no SMEs: the first operator in roles.json')
  assert.equal(a.via, 'operator')
}

// ── 8. the SLA tick: due once, escalate once ──────────────────────────────
{
  const sent = []
  sla.setSlaNotifier(async (run, text) => { sent.push(text); return true })
  const assignedAt = now - 5 * HOUR
  const run = await store.createRun({ workflowSlug: 'wf', workflowName: 'Runbook A', autoRun: true, initialPrompt: 'CRM-9 fix', watch: 'direct-invocation', ticketKey: 'CRM-9',
    steps: [{ stepId: 'review', label: 'Dev Done review', agentSlug: 'x' }] })
  run.status = 'paused'
  run.product = { name: 'crm', repos: [], branches: {}, stack: { compose: 'x', topology_default: '1node' }, tests: {} }
  run.question = { stepId: 'review', text: 'Approve?', kind: 'approval', askedAt: assignedAt, assignee: 'alice' }
  run.smeAssignments = [{ gate: 'review', assignee: 'alice', assignedAt, dueAt: assignedAt + SME_SLA_MS, via: 'product_sme' }]
  await store.saveRun(run)

  let r = await sla.smeSlaTick(now)
  assert.deepEqual(r, { due: 1, escalated: 0 }, 'five hours in: due, not yet escalated')
  assert.match(sent[0], /@alice/)
  assert.match(sent[0], /CRM-9/)
  assert.match(sent[0], /due/)
  r = await sla.smeSlaTick(now + HOUR)
  assert.deepEqual(r, { due: 0, escalated: 0 }, 'the due notice goes once')
  r = await sla.smeSlaTick(assignedAt + SME_ESCALATION_MS + 1)
  assert.deepEqual(r, { due: 0, escalated: 1 }, 'a day in: escalated to the pod lead from settings')
  assert.match(sent[1], /@erin/)
  assert.match(sent[1], /pod lead/)
  const saved = await store.getRun(run.id)
  assert.equal(saved.smeAssignments[0].escalatedTo, 'erin')
  assert.ok(saved.smeAssignments[0].notifiedDueAt && saved.smeAssignments[0].escalatedAt)
  r = await sla.smeSlaTick(assignedAt + SME_ESCALATION_MS + HOUR)
  assert.deepEqual(r, { due: 0, escalated: 0 }, 'and once only')

  // An answered gate owes nothing.
  saved.status = 'running'; saved.question = undefined
  saved.smeAssignments[0] = { ...saved.smeAssignments[0], notifiedDueAt: undefined, escalatedAt: undefined }
  await store.saveRun(saved)
  assert.deepEqual(await sla.smeSlaTick(now + 48 * HOUR), { due: 0, escalated: 0 })
  assert.equal(sent.length, 2)
}

// ── 9. minutes on a decision ──────────────────────────────────────────────
{
  const r = mkRun('r9')
  const d = recordDecision(r, 'approved', 'alice', undefined, undefined, 12.5)
  assert.equal(d.minutes, 12.5)
  assert.ok(d.waitedMs >= 0)
  const d2 = recordDecision({ ...r, question: { ...r.question } }, 'approved', 'bob')
  assert.equal(d2.minutes, undefined, 'nothing reported, nothing invented')
  assert.equal(humanMinutes({ decisions: [d, d2] }), 12.5)
  const { minutesOf } = await import('../server/utils/decisionMinutes.ts')
  assert.equal(minutesOf({ minutes: '5' }), undefined, 'a string is not a figure')
  assert.equal(minutesOf({ minutes: -1 }), undefined)
  assert.equal(minutesOf({ minutes: 7 }), 7)
}

console.log('sme routing: all assertions passed')
