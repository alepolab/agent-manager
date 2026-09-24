/**
 * Self-check for the two histories the run stack draws from.
 *
 * RunStep kept only its LATEST monitor verdict, so a step that was sent back
 * by its monitor once and then passed showed a clean CONTINUE with nothing to
 * say it had ever been retried. And a send-back raised by an agent
 * (PIPELINE-REWORK) was only a log line: human send-backs are in
 * run.decisions, but that list is what people decided (PipelineBoard counts
 * and attributes it), so agent send-backs get their own record.
 *
 *   node scripts/test-run-history.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'run-history-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'run-history-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const { recordCheck, recordSendBack } = await import('../shared/utils/runHistory.ts')

const TIMEOUT = 5000
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
const save = w => writeFileSync(join(CLAUDE_DIR, 'workflows', `${w.slug}.json`), JSON.stringify(w, null, 2))

// ── 1. the recorders append, never replace ─────────────────────────────────
{
  const rec = { stepId: 's', visits: 1 }
  recordCheck(rec, 'RETRY', 'JPY rounding still wrong', 100)
  rec.visits = 2
  recordCheck(rec, 'CONTINUE', 'all six rows pass', 200)
  assert.deepEqual(rec.checks, [
    { visit: 1, verdict: 'RETRY', note: 'JPY rounding still wrong', at: 100 },
    { visit: 2, verdict: 'CONTINUE', note: 'all six rows pass', at: 200 },
  ])

  const run = { id: 'r' }
  recordSendBack(run, { from: 'c', target: 'a', instruction: 'redo', by: 'agent:agent-c' }, 300)
  recordSendBack(run, { from: 'c', target: 'b', instruction: 'again', by: 'agent:agent-c' }, 400)
  assert.equal(run.sendBacks.length, 2)
  assert.deepEqual(run.sendBacks[0], { from: 'c', target: 'a', instruction: 'redo', by: 'agent:agent-c', at: 300 })
}

// ── 2. a monitor RETRY then CONTINUE leaves two checks on the step ─────────
{
  const workflow = {
    slug: 'checks', name: 'Checks',
    steps: [
      { id: 'a', agentSlug: 'agent-a', label: 'Alpha', monitorSlug: 'watcher', next: [] },
    ],
  }
  save(workflow)
  let monitorCalls = 0
  runner.setAgentCaller(async (slug) => {
    if (slug !== 'watcher') return `output of ${slug}`
    monitorCalls++
    return monitorCalls === 1 ? 'Not yet.\nVERDICT: RETRY' : 'Good.\nVERDICT: CONTINUE'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  const checks = run.steps.find(s => s.stepId === 'a').checks
  assert.deepEqual(checks.map(c => [c.visit, c.verdict]), [[1, 'RETRY'], [2, 'CONTINUE']], 'one check per visit, in order')
  assert.ok(checks.every(c => typeof c.at === 'number' && c.note.length > 0))
}

// ── 3. an agent's PIPELINE-REWORK is recorded as a send-back ───────────────
{
  const workflow = {
    slug: 'sendback', name: 'Sendback',
    steps: [
      { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['c'] },
      { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
    ],
  }
  save(workflow)
  let reworked = false
  runner.setAgentCaller(async (slug) => {
    if (slug !== 'agent-c') return `output of ${slug}`
    if (reworked) return 'fine now'
    reworked = true
    return 'found a problem\nPIPELINE-REWORK: Alpha — handle the empty list'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  assert.equal(run.sendBacks?.length, 1, 'one send-back recorded')
  const [s] = run.sendBacks
  assert.equal(s.from, 'c')
  assert.equal(s.target, 'a')
  assert.equal(s.by, 'agent:agent-c')
  assert.match(s.instruction, /handle the empty list/)
  assert.equal((run.decisions ?? []).length, 0, 'an agent send-back is not a person\'s decision')
}

console.log('runHistory: all checks passed')
process.exit(0)
