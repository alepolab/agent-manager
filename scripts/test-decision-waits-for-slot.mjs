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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'park-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'park-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'park-ws-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '1'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
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
// Its review sends the fix back for as long as `rejecting` says, so a run can
// spend its automatic send-backs and stop to ask for another.
const reviewed = { slug: 'reviewed', name: 'Reviewed', steps: [
  { id: 'fix', agentSlug: 'agent-fix', label: 'Fix', next: ['rev'] },
  { id: 'rev', agentSlug: 'agent-rev', label: 'Review', next: [] },
] }
for (const wf of [asking, gated, failing, busy, reviewed]) save(wf)

let release
let held
const replies = []
let flaky = true
let rejecting = 0
const fixes = []
let preflightFails = false
runner.setPreflight(async () => ({ at: Date.now(), checks: preflightFails ? [{ name: 'checkout', level: 'fail', detail: 'taken by another run' }] : [] }))
runner.setAgentCaller(async (slug, input) => {
  if (slug === 'agent-fix') { fixes.push(input); return 'fixed' }
  if (slug === 'agent-rev') {
    if (rejecting > 0) { rejecting -= 1; return 'VERDICT: FAIL\nPIPELINE-REWORK: Fix — still wrong' }
    return 'VERDICT: PASS'
  }
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

/**
 * Waits for a parked run to finish while reading its record from disk as fast
 * as it can, and fails if it ever reads `from` again: carrying the decision out
 * once wrote the old status back first, so a reader in that window saw the run
 * paused - settled, asking - and CI's waitForSettled resolved on it.
 */
async function finishesWithoutReverting(id, from) {
  const seen = new Set()
  const deadline = Date.now() + TIMEOUT
  for (;;) {
    const r = await store.getRun(id)
    seen.add(r.status)
    if (['completed', 'failed', 'stopped'].includes(r.status)) break
    if (Date.now() > deadline) throw new Error(`${id} did not finish; saw ${[...seen]}`)
    await new Promise(res => setImmediate(res))
  }
  assert.ok(!seen.has(from), `never read as ${from} again while its decision was carried out: saw ${[...seen].join(', ')}`)
  return runner.waitForSettled(id, TIMEOUT)
}

/** Fails, instead of hanging the suite, when the queue stops answering. */
const within = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`THE REGRESSION: ${what} did not happen within ${TIMEOUT}ms - the run queue is stuck`)), TIMEOUT).unref())])

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
  assert.ok(!['paused', 'awaiting_review'].includes(answered.status), 'and the inbox no longer asks for it')
  assert.equal(replies.length, 0, 'nothing ran')

  release()
  const done = await finishesWithoutReverting(q.id, 'paused')
  assert.equal(done.status, 'completed', done.error)
  assert.match(replies[0], /option a/, 'the recorded answer reached the step')
  assert.equal(done.parked, undefined)
}

// ── Continue on a question, with the group full ─────────────────────────────
// Continue answers an open question for the person ("proceed on your best
// judgement"). Carried out from the queue, that answer was handed on without
// saying it had a slot, refused because the run read `queued`, and dropped:
// the run sat queued with nothing parked on it, for good.
{
  let q = (await runner.startOrQueue({ workflow: asking, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev18' })).run
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.question.kind, 'question')
  const b = await occupy('dev19')
  replies.length = 0
  const continued = await runner.continueRun(q.id)
  assert.equal(continued.status, 'queued')
  assert.equal(continued.parked.action, 'continue')
  release()
  const done = await finishesWithoutReverting(q.id, 'paused')
  assert.equal(done.status, 'completed', `THE REGRESSION: the answer was dropped and the run left ${done.status}`)
  assert.match(replies[0], /best judgement/, 'the step got the continue as its answer')
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
  const done = await finishesWithoutReverting(g.id, 'paused')
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
  assert.equal((await finishesWithoutReverting(f.id, 'failed')).status, 'completed')
}

// ── A send-back from a gate ──────────────────────────────────────────────────
// Sent as rework.post.ts sends it: the runner's own hand-over (fromRunner). It
// used to start at once, because a hand-over keeps the slot a working run
// holds - and a run at a gate holds none. ASECRM-268 ran as a fifth of four.
{
  let g = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev9' })).run
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused'); assert.equal(g.question.kind, 'approval')
  const workVisits = g.steps.find(s => s.stepId === 'a').visits
  const b = await occupy('dev10')

  const sent = await runner.restartRun(g.id, 'a', 'Sent back from "Ship" by dev9 (rework 1 of 2): narrow it', g.startedBy, { fromRunner: true })
  assert.equal(sent.status, 'queued', 'THE REGRESSION: a send-back with the group full started without a slot')
  assert.equal(sent.parked.action, 'restart')
  assert.equal(sent.parked.handOver, true, 'recorded as a hand-over, to be carried out as one')
  assert.match(sent.parked.note, /narrow it/, 'with the reviewer\'s note')
  assert.equal((await store.getRun(g.id)).steps.find(s => s.stepId === 'a').visits, workVisits, 'nothing ran')

  release()
  const back = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(back.status, 'paused', 'the step was redone and the run is back at its gate')
  assert.equal(back.steps.find(s => s.stepId === 'a').visits, workVisits + 1, 'the sent-back step ran once more')
  assert.equal(back.parked, undefined)
}

// ── The runner's own hand-over keeps its slot ───────────────────────────────
// A working run sent back by its own review already holds a slot, and must not
// queue behind its own group: here the group is full with it alone, and
// another run waits behind it the whole time.
{
  rejecting = 1
  fixes.length = 0
  const r = (await runner.startOrQueue({ workflow: reviewed, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev11' })).run
  held = new Promise(res => { release = res })
  const { run: waiter, queued } = await runner.startOrQueue({ workflow: busy, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev12' })
  assert.ok(queued, 'the group is full: the other run waits')
  const done = await finishesWithoutReverting(r.id, 'queued')
  assert.equal(done.status, 'completed', done.error)
  assert.equal(fixes.length, 2, 'the fix ran again once, for the one send-back, and only once')
  assert.match(fixes[1], /still wrong/, 'with the review\'s instruction')
  release()
  assert.equal((await runner.waitForSettled(waiter.id, TIMEOUT)).status, 'completed', 'and the waiting run went after it')
}

// ── One more send-back, granted with the group full ──────────────────────────
// The run spent its automatic send-backs and asked; the operator grants one
// more while every slot is taken. Carried out by the queue, the grant used to
// ask the queue for a slot again from inside the drain carrying it out, and
// waited on itself: this run never left `queued`, and nothing else was ever
// admitted again.
{
  rejecting = 3
  fixes.length = 0
  let r = (await runner.startOrQueue({ workflow: reviewed, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev13' })).run
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'paused')
  assert.equal(r.question.reason, 'rework', 'asking for a send-back beyond the two')
  assert.equal(fixes.length, 3)
  const b = await occupy('dev14')

  const granted = await runner.continueRun(r.id, 'one more')
  assert.equal(granted.status, 'queued', 'the group is full: the grant waits')
  assert.equal(granted.parked.action, 'continue')

  release()
  const done = await within(finishesWithoutReverting(r.id, 'paused'), 'the granted send-back')
  assert.equal(done.status, 'completed', done.error)
  assert.equal(fixes.length, 4, 'the fix ran once more')
  assert.match(fixes[3], /one more/, 'with the operator\'s note')
  const after = await within(runner.startOrQueue({ workflow: failing, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev15' }), 'a later start')
  await runner.waitForSettled(after.run.id, TIMEOUT)
}

// ── A queued send-back that cannot be carried out is not spent ───────────────
// rework.post.ts counts a send-back before the restart, and gives it back if
// the restart refuses. A parked one refuses later, from the queue.
{
  let g = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev16' })).run
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused')
  const b = await occupy('dev17')
  // As rework.post.ts records it.
  const file = join(process.env.CLAUDE_DIR, 'workflow-runs', `${g.id}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), reworks: 1 }))
  const sent = await runner.restartRun(g.id, 'a', 'Sent back from "Ship" by dev16 (rework 1 of 2): narrow it', g.startedBy, { fromRunner: true })
  assert.equal(sent.status, 'queued')
  preflightFails = true
  release()
  let back
  for (const deadline = Date.now() + TIMEOUT; ;) {
    back = await store.getRun(g.id)
    if (back.status !== 'queued') break
    if (Date.now() > deadline) throw new Error('the parked send-back was never carried out')
    await new Promise(res => setTimeout(res, 20))
  }
  preflightFails = false
  assert.equal(back.status, 'paused', 'back at its gate')
  assert.match(back.error, /could not restart: Preflight/)
  assert.equal(back.reworks ?? 0, 0, 'THE REGRESSION: a send-back that never ran spent one of the two')
  await runner.stopRun?.(g.id).catch(() => {})
}

// ── A question paused by an earlier server ──────────────────────────────────
{
  let q = (await runner.startOrQueue({ workflow: asking, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev8' })).run
  q = await runner.waitForSettled(q.id, TIMEOUT)
  // As a restart leaves it: the record names a process that is gone.
  const file = join(process.env.CLAUDE_DIR, 'workflow-runs', `${q.id}.json`)
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), pid: 999999, bootId: 'an-earlier-server' }))
  held = new Promise(r => { release = r })
  const answered = await runner.respondToRun(q.id, 'option a')
  assert.equal(answered.status, 'running')
  assert.equal((await store.getRun(q.id)).status, 'running', 'working here, so not read as interrupted')
  await runner.waitForSettled(q.id, TIMEOUT)
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
