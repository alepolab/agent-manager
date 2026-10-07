/**
 * A run whose workflow gains a step while it is in flight takes it up: it
 * runs the step if it has not got that far, and records it as passed if it
 * has. Code Review was added after Implement Fix in Runbook A with 139 runs in
 * flight; rebuilt from the new definition, every one was refused as "a
 * different workflow" at its next approval or restart.
 *
 *   node scripts/test-workflow-gains-step.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'gains-step-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
// Runbook A's shape around the change: the fix, then Jira at a gate.
const before = { slug: 'gains', name: 'Gains', steps: [
  { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['done'] },
  { id: 'done', agentSlug: 'agent-done', label: 'Jira: Dev Done', next: ['qa'], approval: true },
  { id: 'qa', agentSlug: 'agent-qa', label: 'Verify', next: [] },
] }
const after = { ...before, steps: [
  { ...before.steps[0], next: ['review'] },
  { id: 'review', agentSlug: 'agent-review', label: 'Code Review', next: ['done'] },
  ...before.steps.slice(1),
] }
const define = wf => writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'gains.json'),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
const calls = []
runner.setAgentCaller(async (slug) => { calls.push(slug); return `out ${slug}` })
let dev = 0
const start = async () => (await runner.startOrQueue({ workflow: before, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${++dev}` })).run

// ── 1. waiting at the gate, past the point: recorded as passed, not run ──
{
  define(before)
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  assert.equal(r.status, 'paused', 'at the Dev Done gate')
  define(after)
  runner._dropLive(r.id) // the deploy's restart
  calls.length = 0
  await runner.continueRun(r.id)
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'completed',
    `THE REGRESSION: approving a run whose workflow gained a step was refused: ${r.error ?? ''}`)
  const review = r.steps.find(s => s.label === 'Code Review')
  assert.equal(review?.status, 'skipped', 'the gained step is on the record')
  assert.match(review.skipReason ?? '', /after this run had passed this point/, 'with the reason it did not run')
  assert.ok(!calls.includes('agent-review'), 'and it was not run behind the run\'s back')
  assert.deepEqual(r.steps.map(s => s.label), ['Implement Fix', 'Code Review', 'Jira: Dev Done', 'Verify'], 'in the run\'s own order')
  assert.deepEqual(calls, ['agent-done', 'agent-qa'], 'the approval went on as before')
}

// ── 2. cut off during Implement Fix: not yet past it, so it is reviewed ──
{
  define(before)
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  // As a server that died mid-step leaves it.
  r = await store.getRun(r.id)
  Object.assign(r.steps.find(s => s.stepId === 'fix'), { status: 'running' })
  Object.assign(r.steps.find(s => s.stepId === 'done'), { status: 'pending' })
  Object.assign(r, { status: 'interrupted', currentStepIds: ['fix'], question: undefined })
  await store.saveRun(r)
  runner._dropLive(r.id)
  define(after)
  calls.length = 0
  await runner.resumeInterruptedRuns()
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.deepEqual(calls, ['agent-fix', 'agent-review'], 'the fix finished, then the gained review ran')
  assert.equal(r.status, 'paused', 'and the run waits at Dev Done as before')
  assert.equal(r.steps.find(s => s.label === 'Code Review').status, 'completed')
}

// ── 3. a run started on the new definition has it from the start ──
{
  define(after)
  calls.length = 0
  const r = await runner.waitForSettled((await runner.startOrQueue({ workflow: after, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${++dev}` })).run.id, TIMEOUT)
  assert.deepEqual(calls, ['agent-fix', 'agent-review'])
  assert.equal(r.status, 'paused')
}

// ── 4. a skipped gained step still runs when the fix is redone ──
{
  define(before)
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  define(after)
  runner._dropLive(r.id)
  calls.length = 0
  // Sent back from the Dev Done gate to Implement Fix after the change, as the
  // Send back button does: the reworked fix is reviewed.
  await runner.restartRun(r.id, 'fix', 'Sent back from "Jira: Dev Done": narrow the change', r.startedBy, { fromRunner: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.deepEqual(calls, ['agent-fix', 'agent-review'], 'a fix redone after the change is reviewed')
}

// ── 5. a new FIRST step: nothing feeds it, so "passed" means the run has begun ──
{
  define(before)
  let r = await runner.waitForSettled((await start()).id, TIMEOUT)
  assert.equal(r.status, 'paused')
  define({ ...before, steps: [{ id: 'pre', agentSlug: 'agent-pre', label: 'Triage', next: ['fix'] }, ...before.steps] })
  runner._dropLive(r.id)
  calls.length = 0
  await runner.continueRun(r.id)
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'completed', r.error)
  const pre = r.steps.find(s => s.label === 'Triage')
  assert.equal(pre?.status, 'skipped', 'a gained first step on a run already under way is recorded as passed')
  assert.match(pre.skipReason ?? '', /after this run had passed this point/)
  assert.ok(!calls.includes('agent-pre'), 'and not run')
  assert.equal(r.steps[0].label, 'Triage', 'first in the run, as in the workflow')
}

// ── 6. a test run of a step whose workflow gained an ancestor ──────────────
// Built from the source run's steps, the test run lacks the gained Code Review.
// It used to be refused as a different workflow; it now takes it up as passed,
// so the tested step runs on the source's outputs as it did before.
{
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const projectDir = mkdtempSync(join(tmpdir(), 'gains-repo-'))
  git(projectDir, 'init', '-q', '-b', 'develop')
  git(projectDir, 'config', 'user.email', 't@example.com'); git(projectDir, 'config', 'user.name', 't')
  writeFileSync(join(projectDir, 'README.md'), 'one\n'); git(projectDir, 'add', '.'); git(projectDir, 'commit', '-q', '-m', 'one')
  define(before)
  let src = (await runner.startOrQueue({ workflow: before, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev${++dev}`, projectDir })).run
  src = await runner.waitForSettled(src.id, TIMEOUT)
  await runner.continueRun(src.id)
  src = await runner.waitForSettled(src.id, TIMEOUT)
  assert.equal(src.status, 'completed', src.error)
  define(after)
  calls.length = 0
  const t = await runner.waitForSettled((await runner.startTestRun(src.id, 'qa')).id, TIMEOUT)
  assert.equal(t.status, 'completed', `the test run took up the gained step: ${t.error}`)
  assert.deepEqual(calls, ['agent-qa'], 'only the tested step ran')
  assert.equal(t.steps.find(s => s.label === 'Code Review')?.status, 'skipped', 'the gained ancestor is on the record as passed')
}

console.log('ok - a run whose workflow gains a step takes it up, or records it as passed')
process.exit(0)
