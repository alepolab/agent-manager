/**
 * Self-check for server/utils/workflowRunStore.ts. Plain asserts, no framework.
 * Uses a temp CLAUDE_DIR so it never touches the real ~/.claude.
 *
 *   node scripts/test-workflow-run-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runstore-'))

const store = await import('../server/utils/workflowRunStore.ts')

const sampleSteps = [
  { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' },
  { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer' },
]

// ── 1. A new run starts pending, owned by this process ────────────────────
const run = await store.createRun({
  workflowSlug: 'demo', workflowName: 'Demo', autoRun: false, watch: 'direct-invocation',
  initialPrompt: 'do the thing', steps: sampleSteps,
})
assert.ok(run.id, 'run gets an id')
assert.equal(run.status, 'running')
assert.equal(run.pid, process.pid)
assert.equal(run.steps.length, 2)
assert.equal(run.steps[0].status, 'pending')
assert.equal(run.steps[0].agentSlug, 'sdlc-ticket-intake', 'the agent is carried on the step')
assert.equal(run.steps[0].visits, 0)
assert.equal(run.baseCommit, undefined, 'no baseCommit was supplied, so none is fabricated')

// ── 1b. baseCommit, like projectDir and watch, is carried straight through
// from the caller (startRun, via gitFacts.ts's captureBaseline) onto the
// persisted run — createRun does not compute or alter it.
const gitRun = await store.createRun({
  workflowSlug: 'demo-baseline', workflowName: 'Demo Baseline', autoRun: false, watch: 'direct-invocation',
  initialPrompt: 'do the thing', steps: sampleSteps,
  projectDir: '/some/project', baseCommit: 'abc123def456',
})
assert.equal(gitRun.baseCommit, 'abc123def456', 'baseCommit is carried through unmodified')
const reloadedGitRun = await store.getRun(gitRun.id)
assert.equal(reloadedGitRun.baseCommit, 'abc123def456', 'baseCommit round-trips through disk')

// ── 2. It round-trips through disk ────────────────────────────────────────
const loaded = await store.getRun(run.id)
assert.deepEqual(loaded.steps.map(s => s.agentSlug), ['sdlc-ticket-intake', 'sdlc-fix-implementer'])
assert.equal(loaded.workflowName, 'Demo')

// ── 3. Updates persist ────────────────────────────────────────────────────
loaded.steps[0].status = 'completed'
loaded.steps[0].output = 'the packet'
loaded.status = 'paused'
await store.saveRun(loaded)
const reloaded = await store.getRun(run.id)
assert.equal(reloaded.status, 'paused')
assert.equal(reloaded.steps[0].output, 'the packet')

// ── 4. A run owned by a dead process reads back as interrupted ────────────
// Not written to disk as 'interrupted' — the process that would write it is
// by definition gone, so it has to be computed on read.
reloaded.pid = 999999            // a pid that is not running
reloaded.status = 'running'
await store.saveRun(reloaded)
const orphaned = await store.getRun(run.id)
assert.equal(orphaned.status, 'interrupted', 'a running run with a dead owner is interrupted')
assert.equal(orphaned.steps[0].output, 'the packet', 'its steps stay frozen at last persisted state')

// ── 5. A finished run is never rewritten as interrupted ───────────────────
orphaned.status = 'completed'
await store.saveRun(orphaned)
const done = await store.getRun(run.id)
assert.equal(done.status, 'completed', 'a completed run stays completed regardless of pid')

// ── 6. Listing is newest first and filters by workflow ────────────────────
const other = await store.createRun({
  workflowSlug: 'other', workflowName: 'Other', autoRun: true, watch: 'direct-invocation',
  initialPrompt: 'x', steps: sampleSteps,
})
const all = await store.listRuns()
assert.equal(all.length, 3)
assert.equal(all[0].id, other.id, 'newest first')
const onlyDemo = await store.listRuns('demo')
assert.equal(onlyDemo.length, 1)
assert.equal(onlyDemo[0].workflowSlug, 'demo')

// ── 7. Active-run lookup ignores finished runs ────────────────────────────
assert.equal(await store.findActiveRun('demo'), null, 'a completed run is not active')
const active = await store.findActiveRun('other')
assert.equal(active.id, other.id)

// ── 8. A missing run is null, not a throw ─────────────────────────────────
assert.equal(await store.getRun('does-not-exist'), null)

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
// ── A finished run whose final status never landed ────────────────────────
//
// Real defect, from run 011edeb8. A run record has two halves written
// separately: the per-step results, and the run-level status/endedAt. That run
// reached all seven steps (six completed, one skipped) and its final publish
// never landed, leaving status 'running', endedAt null, and currentStepIds
// still naming the finished step. Read back with a dead owner pid it reported
// `interrupted` - telling the reader the run died when it had succeeded.
{
  // Earlier blocks may have torn the directory down; these fixtures are written
  // directly rather than through createRun, so ensure it exists.
  mkdirSync(join(process.env.CLAUDE_DIR, 'workflow-runs'), { recursive: true })

  const settledSteps = [
    { stepId: 'a', label: 'A', agentSlug: 'x', status: 'completed', visits: 1, completedAt: 1000 },
    { stepId: 'b', label: 'B', agentSlug: 'y', status: 'skipped', visits: 1, completedAt: 2000 },
  ]
  const stale = {
    id: 'stale-completed', workflowSlug: 'demo', workflowName: 'Demo',
    status: 'running', startedAt: 1, endedAt: null,
    pid: 999999, // certainly dead
    currentStepIds: ['b'], nextStepIds: [], steps: settledSteps, outputs: {},
  }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflow-runs', 'stale-completed.json'),
    JSON.stringify(stale, null, 2))

  const read = await store.getRun('stale-completed')
  assert.equal(read.status, 'completed',
    'every step settled and no failures: the run completed, whatever the unwritten status field says')
  assert.equal(read.endedAt, 2000,
    'endedAt is derived from the last step to finish - the best available answer, not a fabricated now()')
  assert.deepEqual(read.currentStepIds, [], 'a finished run has no current step')

  // A failure among the settled steps must not read as success.
  const failedSteps = [
    { stepId: 'a', label: 'A', agentSlug: 'x', status: 'completed', visits: 1, completedAt: 1000 },
    { stepId: 'b', label: 'B', agentSlug: 'y', status: 'failed', visits: 1, completedAt: 2000 },
  ]
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflow-runs', 'stale-failed.json'),
    JSON.stringify({ ...stale, id: 'stale-failed', steps: failedSteps }, null, 2))
  assert.equal((await store.getRun('stale-failed')).status, 'failed',
    'a settled run containing a failed step is failed, never completed')

  // Genuinely interrupted: work left hanging and nobody alive to advance it.
  const hangingSteps = [
    { stepId: 'a', label: 'A', agentSlug: 'x', status: 'completed', visits: 1, completedAt: 1000 },
    { stepId: 'b', label: 'B', agentSlug: 'y', status: 'running', visits: 1 },
    { stepId: 'c', label: 'C', agentSlug: 'z', status: 'pending', visits: 0 },
  ]
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflow-runs', 'stale-hanging.json'),
    JSON.stringify({ ...stale, id: 'stale-hanging', steps: hangingSteps }, null, 2))
  assert.equal((await store.getRun('stale-hanging')).status, 'interrupted',
    'steps still running or pending with a dead owner is exactly what interrupted means - do not report success')
}

console.log('workflowRunStore: all assertions passed')
