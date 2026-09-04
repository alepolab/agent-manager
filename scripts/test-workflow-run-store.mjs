/**
 * Self-check for server/utils/workflowRunStore.ts. Plain asserts, no framework.
 * Uses a temp CLAUDE_DIR so it never touches the real ~/.claude.
 *
 *   node scripts/test-workflow-run-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
assert.equal(all.length, 2)
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
console.log('workflowRunStore: all assertions passed')
