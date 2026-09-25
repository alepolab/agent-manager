/**
 * A person's decision respects the group cap: the run waits in the queue, with
 * the decision recorded, and the queue carries it out when a slot frees.
 *
 * Answering a question, approving a gate and restarting a run all used to put
 * the run straight back to running. A paused run gives its slot back and the
 * queue fills it, so each answer took the group one over its cap - with seven
 * Runbook A runs at gates, answering them all would have run nine at once.
 *
 *   node scripts/test-decision-waits-for-slot.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'park-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'park-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'park-ws-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '1'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const TIMEOUT = 15000

const save = (wf) => writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
const asking = { slug: 'asking', name: 'Asking', steps: [{ id: 'q', agentSlug: 'agent-q', label: 'Ask', next: [] }] }
const gated = { slug: 'gated', name: 'Gated', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'Work', next: ['s'] },
  { id: 's', agentSlug: 'agent-s', label: 'Ship', next: [], approval: true },
] }
const failing = { slug: 'failing', name: 'Failing', steps: [{ id: 'f', agentSlug: 'agent-f', label: 'Flaky', next: [] }] }
const busy = { slug: 'busy', name: 'Busy', steps: [{ id: 'b', agentSlug: 'agent-b', label: 'Busy', next: [] }] }
for (const wf of [asking, gated, failing, busy]) save(wf)

let release
let held
const replies = []
let flaky = true
runner.setAgentCaller(async (slug, input) => {
  if (slug === 'agent-q') {
    if (/User response/.test(input)) { replies.push(input); return 'answered' }
    const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
    writeFileSync(join(dir, 'decision.json'), JSON.stringify({ question: 'Which?', situation: 's',
      options: [{ key: 'a', label: 'x', next: 'n', delivers: 'd', leaves: 'l' }, { key: 'b', label: 'y', next: 'n', delivers: 'd', leaves: 'l' }] }))
    return 'PIPELINE-ASK: Which?'
  }
  if (slug === 'agent-b') { await held; return 'done' }
  if (slug === 'agent-f' && flaky) throw new Error('agent-f exploded')
  return `out ${slug}`
})

const occupy = async (who) => {
  held = new Promise(r => { release = r })
  const { run, queued } = await runner.startOrQueue({ workflow: busy, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: who })
  assert.ok(!queued, 'the busy run takes the one slot')
  return run
}

// ── An answer ────────────────────────────────────────────────────────────────
{
  let q = (await runner.startOrQueue({ workflow: asking, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'paused', 'paused on its question, and so holding no slot')
  const b = await occupy('dev2')

  const answered = await runner.respondToRun(q.id, 'option a')
  assert.equal(answered.status, 'queued', 'the group is full: the answer waits')
  assert.equal(answered.parked.action, 'respond')
  assert.equal(answered.parked.reply, 'option a', 'the answer itself is on the record')
  assert.equal(answered.question, undefined, 'and the inbox no longer asks for it')
  assert.equal(replies.length, 0, 'nothing ran')

  release()
  await runner.waitForSettled(b.id, TIMEOUT)
  const done = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(done.status, 'completed', done.error)
  assert.match(replies[0], /option a/, 'the recorded answer reached the step')
  assert.equal(done.parked, undefined)
}

// ── An approval ──────────────────────────────────────────────────────────────
{
  let g = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev3' })).run
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused'); assert.equal(g.question.kind, 'approval')
  const b = await occupy('dev4')

  const approved = await runner.continueRun(g.id, 'looks right')
  assert.equal(approved.status, 'queued')
  assert.equal(approved.parked.action, 'continue')
  release()
  await runner.waitForSettled(b.id, TIMEOUT)
  const done = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(done.status, 'completed', 'the approval was carried out, not asked again')
  assert.equal(done.steps.find(s => s.stepId === 's').status, 'completed')
}

// ── A restart ────────────────────────────────────────────────────────────────
{
  let f = (await runner.startOrQueue({ workflow: failing, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev5' })).run
  f = await runner.waitForSettled(f.id, TIMEOUT)
  assert.equal(f.status, 'failed')
  const b = await occupy('dev6')
  flaky = false
  const restarted = await runner.restartRun(f.id, 'f', 'try again')
  assert.equal(restarted.status, 'queued')
  assert.equal(restarted.parked.action, 'restart')
  release()
  await runner.waitForSettled(b.id, TIMEOUT)
  assert.equal((await runner.waitForSettled(f.id, TIMEOUT)).status, 'completed')
}

// ── With a slot free, a decision goes ahead at once ─────────────────────────
{
  let q = (await runner.startOrQueue({ workflow: asking, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev7' })).run
  q = await runner.waitForSettled(q.id, TIMEOUT)
  const answered = await runner.respondToRun(q.id, 'option b')
  assert.notEqual(answered.status, 'queued', 'nothing to wait for')
  assert.equal((await runner.waitForSettled(q.id, TIMEOUT)).status, 'completed')
}

console.log('ok - a decision waits for a slot in its group, and is carried out when one frees')
