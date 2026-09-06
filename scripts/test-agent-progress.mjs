/**
 * Self-check for the live-progress telemetry surfaced from an agent call
 * onto a RunStep (server/utils/agentCaller.ts's AgentProgress, wired through
 * server/utils/workflowRunner.ts's executeNode).
 *
 * The problem this exists to catch: a running step used to report only
 * `status: 'running'` and a start timestamp — nothing else — until it
 * terminated, sometimes minutes later. This proves the runner records
 * `assistantMessages` / `lastTool` / `lastActivityAt` on the step as they're
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
  runner.setAgentCaller(async (_agentSlug, _input, _projectDir, { onProgress } = {}) => {
    onProgress?.({ turn: 1, lastTool: 'Read', lastActivityAt: 1000 })
    onProgress?.({ turn: 2, lastTool: 'Bash', lastActivityAt: 2000 })
    return 'final output'
  })

  const run = await runner.startRun({
    workflow: workflow('progress-reports'), initialPrompt: 'go', watch: 'direct-invocation', autoRun: false,
  })
  const settled = await runner.waitForSettled(run.id)
  const step = settled.steps.find(s => s.stepId === 's1')

  assert.equal(step.assistantMessages, 2, 'the step must record the LATEST reported assistant-message count')
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

  assert.equal(step.assistantMessages, undefined, 'no progress reported: assistantMessages must stay absent')
  assert.equal(step.lastTool, undefined, 'no progress reported: lastTool must stay absent')
  assert.equal(step.lastActivityAt, undefined, 'no progress reported: lastActivityAt must stay absent')
}

console.log('OK: agent progress is throttled correctly, recorded on the run step when reported,')
console.log('    and left absent (never fabricated) when a caller reports nothing.')

// ── A failed agent call must still report what it spent ──────────────────────
//
// interpretResultMessage threw a bare Error on any error result, dropping the
// usage the SDK reports alongside it. A real error_max_turns step burned 519
// seconds and 109 assistant messages and was recorded as costing $0.00 — the
// most expensive failures were the least visible, which is backwards for a
// budget you are trying to hold.
{
  const { interpretResultMessage, AgentResultError } = await import('../server/utils/agentCaller.ts')

  let thrown
  try {
    interpretResultMessage(
      { subtype: 'error_max_turns', usage: { input_tokens: 1930457, output_tokens: 9526 } },
      60,
    )
  }
  catch (e) { thrown = e }

  assert.ok(thrown instanceof AgentResultError,
    'an error result must throw the typed error, so the runner can read its usage')
  assert.equal(thrown.subtype, 'error_max_turns', 'the subtype travels with the error')
  assert.ok(thrown.usage, 'usage reported on the error result must not be discarded')
  assert.equal(thrown.usage.input_tokens, 1930457)
  assert.equal(thrown.usage.output_tokens, 9526)
  assert.match(thrown.message, /turn budget: 60/,
    'the budget that was hit is still named in the message')

  // A result with no usage at all must not invent one.
  let noUsage
  try { interpretResultMessage({ subtype: 'error_during_execution' }) }
  catch (e) { noUsage = e }
  assert.ok(noUsage instanceof AgentResultError)
  assert.equal(noUsage.usage, null, 'no usage reported means null, never a fabricated zero')

  // Success is untouched.
  const ok = interpretResultMessage(
    { subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 2 } })
  assert.equal(ok.output, 'done')
  assert.equal(ok.usage.input_tokens, 10)

  console.log('agent usage: a failed call reports what it spent')
}
