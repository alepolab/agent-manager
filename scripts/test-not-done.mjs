/**
 * A run records what it deliberately did not do.
 *
 *   node scripts/test-not-done.mjs
 *
 * CSUP-7524 ended with "Two blockers remain, both outside this lane's
 * authority" and named neither; its implement step said "The forward fix is
 * implemented, tested and committed. The backfill is not" — of the 10,547
 * orphan records the ticket was about. Eight of thirteen runs stated nothing of
 * the kind anywhere, and two of thirteen metas mention a residual at all.
 *
 * The scope boundary is the first thing a reviewer needs, and it lived in prose
 * where nothing could read it. This pins the marker end to end: the parser, the
 * runner collecting it onto the record, and the header that tells agents it
 * exists — a marker nobody is told about is a marker nothing emits.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'notdone-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'notdone-artifacts-'))
process.env.AGENT_ALLOW_DUPLICATE_TICKET_RUNS = '1'

const { parseNotDone } = await import('../shared/utils/workflowGraph.ts')
const { artifactHeader } = await import('../server/utils/runArtifacts.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

// ── the parser ───────────────────────────────────────────────────────────────
assert.deepEqual(
  parseNotDone('PIPELINE-NOT-DONE: the backfill — 10,547 existing rows, needs a DBA window'),
  [{ what: 'the backfill', why: '10,547 existing rows, needs a DBA window' }])

// Several, because a step can leave several things undone and dropping all but
// one would be a second omission.
assert.equal(parseNotDone(
  'PIPELINE-NOT-DONE: the backfill — needs a window\nPIPELINE-NOT-DONE: HIGH-3 — an R&D decision nobody made').length, 2)

assert.deepEqual(parseNotDone('I will explain what PIPELINE-NOT-DONE: means in a moment'), [],
  'prose about the marker is not the marker — it must start its own line')
assert.deepEqual(parseNotDone('PIPELINE-NOT-DONE: — no reason given'), [],
  'an item with no name is not an item')
assert.deepEqual(parseNotDone(''), [])

// ── the agent is told it exists ──────────────────────────────────────────────
const header = artifactHeader('/tmp/artifacts')
assert.match(header, /PIPELINE-NOT-DONE: <what> — <why>/,
  'every step is handed the format; an undocumented marker is a marker nothing emits')

// ── the runner collects it onto the run ──────────────────────────────────────
const workflow = {
  slug: 'notdone-wf',
  name: 'Not done',
  steps: [
    { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['docs'] },
    { id: 'docs', agentSlug: 'agent-docs', label: 'Docs', next: [] },
  ],
}
runner.setAgentCaller(async slug => (slug === 'agent-fix'
  ? 'Fixed the forward path.\n\nPIPELINE-NOT-DONE: the backfill — 10,547 existing rows, needs a DBA window'
  : `out ${slug}`))
const started = await runner.startRun({
  workflow, initialPrompt: 'CSUP-0: go', watch: 'direct-invocation', autoRun: true,
})
const run = await runner.waitForSettled(started.id, 8000)

assert.equal(run.notDone?.length, 1, `expected the residual on the run record, got ${JSON.stringify(run.notDone)}`)
assert.equal(run.notDone[0].what, 'the backfill')
assert.equal(run.notDone[0].stepId, 'fix', 'and it names the step that said it, so a reader knows who to ask')
assert.equal(run.notDone[0].label, 'Implement Fix')
assert.equal(run.status, 'completed', 'stating a residual is honesty, not failure')

console.log('not done: the scope boundary is stated by the step, recorded on the run, and named to the agent')
