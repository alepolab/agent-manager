/**
 * A person who approved a change is not asked to approve it again further down
 * the same run: an approval at "Jira: Dev Done" carries to the PR step, and one
 * at either carries to "Jira: QA Done". The carried approval is a decision of
 * its own, marked auto, naming whose it was.
 *
 * The decision has to reach the runner's own copy of the run. Recorded by the
 * continue route after continueRun returned, it went to a copy on disk that the
 * runner's next publish wrote over - so this drives continueRun the way the
 * route now does, with the decision passed in.
 *
 *   node scripts/test-gate-carries-earlier-approval.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'carry-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'carry-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'carry-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const { recordDecision } = await import('../shared/utils/runDecisions.ts')
const carry = await import('../shared/utils/gateCarryOver.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const TIMEOUT = 15000

// Runbook-shaped: work, Dev Done (gate), a middle step, the PR step (gate), QA Done (gate).
const gate = { approval: true, gateRole: 'developer' }
const wf = { slug: 'runbook', name: 'Runbook', steps: [
  { id: 'work', agentSlug: 'agent-work', label: 'Implement Fix', next: ['dev'] },
  { id: 'dev', agentSlug: 'agent-dev', label: 'Jira: Dev Done', next: ['mid'], ...gate },
  { id: 'mid', agentSlug: 'agent-mid', label: 'Verify + Regression', next: ['pr'] },
  { id: 'pr', agentSlug: 'agent-pr', label: 'Evidence Bundle + PR', next: ['qa'], ...gate },
  { id: 'qa', agentSlug: 'agent-qa', label: 'Jira: QA Done', next: [], ...gate },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const calls = []
let sendBackOnce = false
runner.setAgentCaller(async (slug) => {
  calls.push(slug)
  if (slug === 'agent-mid' && sendBackOnce) { sendBackOnce = false; return 'VERDICT: FAIL\nPIPELINE-REWORK: Implement Fix — one case still fails' }
  return `out ${slug}`
})

const start = async () => (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
/** Approves the open gate as the continue route does: the decision handed to continueRun. */
const approve = async (id, by) => {
  const before = await store.getRun(id)
  const decision = recordDecision(structuredClone(before), 'approved', by)
  await runner.continueRun(id, undefined, { decision })
  return runner.waitForSettled(id, TIMEOUT)
}
const at = r => r.question?.stepId
const byStep = (r, id) => (r.decisions ?? []).filter(d => d.stepId === id)

// ── 1. approved at Dev Done: the PR step and QA Done are not asked ─────────────
{
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  assert.equal(at(r), 'dev', 'the run stops at Dev Done')
  r = await approve(r.id, 'dev1')
  assert.equal(r.status, 'completed', `THE RULE: an approval at Dev Done is not asked for again at the PR step or QA Done (stopped at ${at(r)})`)
  assert.equal(byStep(r, 'dev')[0]?.by, 'dev1', 'the person\'s approval is on the record the runner kept writing')
  const pr = byStep(r, 'pr')[0], qa = byStep(r, 'qa')[0]
  assert.ok(pr?.auto && qa?.auto, 'both later gates record a carried approval')
  assert.equal(pr.by, 'auto: earlier approval by dev1 at Jira: Dev Done', 'naming whose approval it was and where')
  assert.equal(qa.verdict, 'approved')
  assert.equal(qa.waitedMs, 0, 'nobody was waited for')
}

// ── 2. no approval on record at Dev Done: the PR step still asks ───────────────
{
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  await runner.continueRun(r.id) // an approval with no decision recorded (an older caller)
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(at(r), 'pr', 'with nobody\'s approval to carry, the PR step asks')
  r = await approve(r.id, 'dev2')
  assert.equal(r.status, 'completed', 'approved at the PR step: QA Done is not asked')
  assert.equal(byStep(r, 'qa')[0]?.by, 'auto: earlier approval by dev2 at Evidence Bundle + PR')
}

// ── 3. a send-back after the approval: the approval no longer carries ─────────
// Dev Done is approved, then the middle step sends the work back. The code it
// signed off has changed, so the next gate asks again rather than carrying it.
{
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  sendBackOnce = true
  r = await approve(r.id, 'dev3')
  assert.ok(r.sendBacks?.length, 'the middle step sent the work back')
  assert.equal(r.status, 'paused', 'and the run stopped for a person again')
  const asked = at(r)
  console.log(`  after the send-back the run asks at: ${asked}`)
  if (asked === 'dev') {
    // Re-asked at Dev Done: approving it again carries the new approval on.
    r = await approve(r.id, 'dev3-again')
    assert.equal(r.status, 'completed')
    assert.equal(byStep(r, 'pr').at(-1)?.by, 'auto: earlier approval by dev3-again at Jira: Dev Done', 'the newer approval is the one carried')
  } else {
    assert.equal(asked, 'pr', 'the approval from before the send-back is not carried to the PR step')
    assert.ok(!byStep(r, 'pr').some(d => d.auto), 'and nothing was carried')
  }
}

// ── 4. the rule itself ───────────────────────────────────────────────────────
{
  const steps = wf.steps
  const run = (decisions, extra = {}) => ({ decisions, sendBacks: [], steps: steps.map(s => ({ stepId: s.id, status: 'completed' })), ...extra })
  const ok = { stepId: 'dev', label: 'Jira: Dev Done', at: 10, by: 'p', verdict: 'approved', waitedMs: 1 }
  assert.ok(carry.earlierApprovalFor(run([ok]), steps, 'qa'), 'Dev Done carries to QA Done')
  assert.ok(carry.earlierApprovalFor(run([ok]), steps, 'pr'), 'Dev Done carries to the PR step')
  assert.equal(carry.earlierApprovalFor(run([{ ...ok, stepId: 'pr', label: 'Evidence Bundle + PR' }]), steps, 'pr'), null, 'a gate does not carry to itself')
  assert.equal(carry.earlierApprovalFor(run([{ ...ok, auto: true }]), steps, 'qa'), null, 'a carried approval is not carried again')
  assert.equal(carry.earlierApprovalFor(run([ok], { sendBacks: [{ at: 20 }] }), steps, 'qa'), null, 'a send-back after it voids it')
  assert.equal(carry.earlierApprovalFor(run([ok, { ...ok, verdict: 'sent-back', at: 30 }]), steps, 'qa'), null, 'so does a person\'s send-back')
  assert.equal(carry.earlierApprovalFor(run([ok]), steps.map(s => s.id === 'qa' ? { ...s, gateRole: 'qa' } : s), 'qa'), null, 'a gate owned by another role still asks')
  assert.equal(carry.earlierApprovalFor(run([ok]), steps.map(s => s.id === 'qa' ? { ...s, runWhen: { artifact: 'x' } } : s), 'qa'), null, 'a conditional gate still asks')
  assert.equal(carry.earlierApprovalFor(run([ok]), steps, 'mid'), null, 'a step that is not one of these gates never carries')
  // Recognised by what the shipped runbooks declare, not only by label.
  assert.ok(carry.isQaDoneStep({ id: 'x', label: 'Move ticket', jira: { transition: 'QA Done' } }))
  assert.ok(carry.isPrStep({ id: 'x', label: 'Ship it', agentSlug: 'sdlc-ce-ship' }))
  assert.ok(carry.isDevDoneStep({ id: 'x', label: 'Move ticket', jira: { transition: 'Dev Done' } }))
}

console.log('ok - a gate takes a person\'s earlier approval instead of asking again: Dev Done → PR step → QA Done')
process.exit(0)
