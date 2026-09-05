/**
 * Self-check for the live-progress telemetry surfaced from an agent call
 * onto a RunStep (server/utils/agentCaller.ts's AgentProgress, wired through
 * server/utils/workflowRunner.ts's executeNode).
 *
 * The problem this exists to catch: a running step used to report only
 * `status: 'running'` and a start timestamp — nothing else — until it
 * terminated, sometimes minutes later. This proves the runner records
 * `turnCount` / `lastTool` / `lastActivityAt` on the step as they're
 * reported, and leaves them absent (never a fabricated 0) when the caller
 * never reports anything.
 *
 *   node scripts/test-agent-progress.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'agent-progress-claudedir-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'agent-progress-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const { shouldEmitProgress, PROGRESS_MIN_INTERVAL_MS } = await import('../server/utils/agentCaller.ts')

// ── the throttle policy is a pure decision, tested in isolation ───────────
{
  assert.equal(shouldEmitProgress(1000, undefined, false), true,
    'the very first observation always emits')
  assert.equal(shouldEmitProgress(1000, 1000, false), false,
    'same tool, inside the floor: suppressed')
  assert.equal(shouldEmitProgress(1000 + PROGRESS_MIN_INTERVAL_MS, 1000, false), true,
    'same tool, floor elapsed: emits')
  assert.equal(shouldEmitProgress(1000, 1000, true), true,
    'tool changed: emits immediately regardless of the floor')
}

function workflow(slug) {
  return {
    slug, name: slug,
    steps: [{ id: 's1', agentSlug: 'agent-a', label: 'Step A' }],
  }
}

// ── a caller reporting progress produces a rising turn count, a recorded
//    tool name, and an advancing lastActivityAt ─────────────────────────────
{
  runner.setAgentCaller(async (_agentSlug, _input, _projectDir, onProgress) => {
    onProgress?.({ turn: 1, lastTool: 'Read', lastActivityAt: 1000 })
    onProgress?.({ turn: 2, lastTool: 'Bash', lastActivityAt: 2000 })
    return 'final output'
  })

  const run = await runner.startRun({
    workflow: workflow('progress-reports'), initialPrompt: 'go', watch: 'direct-invocation', autoRun: false,
  })
  const settled = await runner.waitForSettled(run.id)
  const step = settled.steps.find(s => s.stepId === 's1')

  assert.equal(step.turnCount, 2, 'the step must record the LATEST reported turn count')
  assert.equal(step.lastTool, 'Bash', 'the step must record the most recently invoked tool')
  assert.equal(step.lastActivityAt, 2000, 'lastActivityAt must advance with each report')
}

// ── a caller reporting nothing intermediate leaves the fields absent ──────
// (never a fabricated 0/undefined-as-zero — genuinely absent, same rule as
// every other "cannot compute" field in this codebase.)
{
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)

  const run = await runner.startRun({
    workflow: workflow('progress-silent'), initialPrompt: 'go', watch: 'direct-invocation', autoRun: false,
  })
  const settled = await runner.waitForSettled(run.id)
  const step = settled.steps.find(s => s.stepId === 's1')

  assert.equal(step.turnCount, undefined, 'no progress reported: turnCount must stay absent')
  assert.equal(step.lastTool, undefined, 'no progress reported: lastTool must stay absent')
  assert.equal(step.lastActivityAt, undefined, 'no progress reported: lastActivityAt must stay absent')
}

console.log('OK: agent progress is throttled correctly, recorded on the run step when reported,')
console.log('    and left absent (never fabricated) when a caller reports nothing.')
