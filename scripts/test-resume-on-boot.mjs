/**
 * Runs the previous process left mid-step are picked up at boot.
 *
 * Five container rebuilds in one afternoon froze two runs mid-step; each froze
 * as `interrupted` and waited for a person to notice, and every restart re-ran
 * that step from turn one. This is the automatic half; the resume itself is
 * scripts/test-resume.mjs.
 *
 *   node scripts/test-resume-on-boot.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'boot-resume-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
const workflow = { slug: 'boot-demo', name: 'Boot demo', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'B', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'boot-demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps, createdAt: new Date().toISOString() }, null, 2))

/** The shape a process that died leaves behind: a step frozen at 'running'.
 *  Each case gets its own developer, and so its own workspace: the run lock is
 *  per workspace, and an interrupted run still holds the one it was working in. */
let dev = 0
async function interrupted(over = {}) {
  runner.setAgentCaller(async slug => `out ${slug}`)
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${++dev}` })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  const rec = r.steps.find(s => s.stepId === 'a')
  Object.assign(rec, { status: 'running', visits: 1 })
  Object.assign(r, { status: 'interrupted', currentStepIds: ['a'], ...over })
  await store.saveRun(r)
  runner._dropLive(r.id)
  return r
}

// ── 1. a run frozen mid-step is picked up and finishes ──
{
  const r = await interrupted()
  const calls = []
  runner.setAgentCaller(async (slug) => { calls.push(slug); return `out ${slug}` })
  const out = await runner.resumeInterruptedRuns()
  assert.deepEqual(out.resumed, [r.id], `the frozen run was resumed: ${JSON.stringify(out)}`)
  const after = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(after.status, 'completed', 'and it finished on its own')
  assert.ok(calls.includes('agent-a'), 'the frozen step ran again')
  assert.equal(after.steps.find(s => s.stepId === 'a').visits, 1,
    'and the interruption cost it no visit: it is on its first real attempt still')
}

// ── 2. a run waiting on a person is left alone: that is a question, not an interruption ──
{
  const r = await interrupted({ question: { stepId: 'a', text: 'Which customer?', kind: 'question', askedAt: Date.now() } })
  let called = 0
  runner.setAgentCaller(async (slug) => { called++; return `out ${slug}` })
  const out = await runner.resumeInterruptedRuns()
  assert.deepEqual(out.resumed, [], 'a run with an unanswered question is never resumed automatically')
  assert.deepEqual(out.skipped, [r.id])
  assert.equal(called, 0, 'and nothing ran')
}

// ── 3. a run interrupted over and over pauses and asks, instead of looping every boot ──
{
  const r = await interrupted({ interruptions: 3 })
  let called = 0
  runner.setAgentCaller(async (slug) => { called++; return `out ${slug}` })
  const out = await runner.resumeInterruptedRuns()
  assert.deepEqual(out.paused, [r.id], `the fourth interruption asks rather than resuming: ${JSON.stringify(out)}`)
  assert.equal(called, 0, 'spending nothing')
  const stored = await store.getRun(r.id)
  assert.equal(stored.status, 'paused')
  assert.equal(stored.question.kind, 'approval')
  assert.match(stored.question.text, /interrupted 4 times in a row at "A"/, stored.question.text)
  assert.equal(stored.interruptions, 0, 'and the count resets, so continuing gives it a clean run of tries')
  assert.equal(stored.steps.find(s => s.stepId === 'a').status, 'pending',
    'the frozen step is settled as pending so continuing can schedule it')
}

// ── 3b. "try once more" runs every step the interruptions froze, in its last visit ──
// A wave runs steps in parallel, and one restart freezes all of them. Only the
// first used to be unfrozen: the rest stayed 'running' for good, nothing
// scheduled them, and the join after them never ran. Each was also frozen in
// its third visit, the default cap - ASECRM-296's Browser Trace sat at 3 of 3,
// and approving "try once more" ended the run as stuck.
{
  const fanout = { slug: 'boot-fanout', name: 'Boot fan-out', steps: [
    { id: 'e', agentSlug: 'agent-e', label: 'E', next: ['x', 'y'] },
    { id: 'x', agentSlug: 'agent-x', label: 'X', next: ['j'] },
    { id: 'y', agentSlug: 'agent-y', label: 'Y', next: ['j'] },
    { id: 'j', agentSlug: 'agent-j', label: 'J', next: [] },
  ] }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'boot-fanout.json'),
    JSON.stringify({ name: fanout.name, description: '', steps: fanout.steps, createdAt: new Date().toISOString() }, null, 2))
  runner.setAgentCaller(async slug => `out ${slug}`)
  let r = await runner.startRun({ workflow: fanout, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${++dev}` })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  // As a server that died mid-wave leaves it: both branches running, the join not reached.
  for (const id of ['x', 'y']) Object.assign(r.steps.find(s => s.stepId === id), { status: 'running', visits: 3 })
  Object.assign(r.steps.find(s => s.stepId === 'j'), { status: 'pending', visits: 0 })
  Object.assign(r, { status: 'interrupted', currentStepIds: ['x', 'y'], interruptions: 3 })
  await store.saveRun(r)
  runner._dropLive(r.id)

  const calls = []
  runner.setAgentCaller(async (slug) => { calls.push(slug); return `out ${slug}` })
  const out = await runner.resumeInterruptedRuns()
  assert.deepEqual(out.paused, [r.id], 'it asks first, as above')
  const asked = await store.getRun(r.id)
  assert.deepEqual(asked.steps.filter(s => s.status === 'running').map(s => s.stepId), [],
    'THE REGRESSION: a step frozen beside another stayed running after the pause')
  assert.match(asked.question.text, /at "X", "Y"/, `the question names every frozen step: ${asked.question.text}`)

  await runner.continueRun(r.id)
  const after = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(after.status, 'completed',
    `THE REGRESSION: approving "try once more" left a frozen step with nothing to schedule: ${after.error}`)
  assert.ok(calls.includes('agent-x') && calls.includes('agent-y'), `both frozen branches ran once more: ${calls}`)
  assert.ok(calls.includes('agent-j'), 'and the join after them ran, rather than the run finishing without it')
  assert.ok(after.steps.every(s => s.status === 'completed'), `no step was left behind: ${after.steps.map(s => `${s.stepId}:${s.status}`)}`)
  // The interrupted attempts were not counted: each branch ran its real third visit.
  for (const id of ['x', 'y']) assert.equal(after.steps.find(s => s.stepId === id).visits, 3, `${id} spent its refunded visit and no more`)
  // Each frozen attempt is kept on the record before it is reset, as a restart keeps it.
  const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
  const { readdirSync } = await import('node:fs')
  const snaps = readdirSync(join(runArtifactsDir(r.id), 'steps')).filter(f => /-interrupted-3\.json$/.test(f))
  assert.deepEqual(snaps.map(f => f.replace(/^step-\d+-/, '')).sort(), ['agent-x-interrupted-3.json', 'agent-y-interrupted-3.json'],
    `an interrupted-N snapshot per frozen step: ${snaps}`)
}

// ── 4. progress clears the count: only consecutive interruptions with nothing achieved matter ──
{
  const r = await interrupted({ interruptions: 2 })
  runner.setAgentCaller(async slug => `out ${slug}`)
  await runner.resumeInterruptedRuns()
  const after = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(after.status, 'completed')
  assert.equal(after.interruptions, 0, 'a step that completed cleared the run\'s interruption count')
}

rmSync(root, { recursive: true, force: true })
console.log('boot resume: interrupted runs pick up where they were, questions are left alone, and a rebuild loop asks')
