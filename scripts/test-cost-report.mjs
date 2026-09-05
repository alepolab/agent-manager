/**
 * Self-check for server/utils/costReport.ts (action F5: cost reporting).
 * Plain asserts, no framework. Builds runs through the REAL
 * workflowRunStore.ts (temp CLAUDE_DIR) rather than hand-rolled JSON, so this
 * also proves the store round-trip (usage/model attached via Object.assign
 * in workflowRunner.ts, exactly as it happens in a live run) survives into
 * what listRuns() hands back.
 *
 *   node scripts/test-cost-report.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'costreport-'))

const store = await import('../server/utils/workflowRunStore.ts')
const C = await import('../server/utils/costReport.ts')

const PRICED_MODEL = 'claude-sonnet-4-6' // SERVER_MODEL_META: input 3.0, output 15.0 USD/1M
const UNPRICED_MODEL = 'claude-made-up-model-nobody-shipped'

function withUsage(run, idx, patch) {
  Object.assign(run.steps[idx], patch)
  return run
}

// ── 1. A run with full usage on every step, on a priced model ─────────────
{
  const run = await store.createRun({
    workflowSlug: 'demo', workflowName: 'Demo', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [
      { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' },
      { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer' },
    ],
  })
  withUsage(run, 0, { status: 'completed', model: PRICED_MODEL, usage: { input_tokens: 1_000_000, output_tokens: 100_000 } })
  withUsage(run, 1, { status: 'completed', model: PRICED_MODEL, usage: { input_tokens: 500_000, output_tokens: 50_000 } })
  run.endedAt = run.startedAt + 120_000
  await store.saveRun(run)

  const summary = C.summarizeRunCost(run)
  assert.equal(summary.totals.input_tokens, 1_500_000, 'input tokens sum across both measured steps')
  assert.equal(summary.totals.output_tokens, 150_000, 'output tokens sum across both measured steps')
  // step 1: 1.0 * 3.0 + 0.1 * 15.0 = 3.0 + 1.5 = 4.5
  // step 2: 0.5 * 3.0 + 0.05 * 15.0 = 1.5 + 0.75 = 2.25
  assert.ok(Math.abs(summary.totals.cost_usd - 6.75) < 1e-9,
    `cost_usd is the real priced sum (expected 6.75, got ${summary.totals.cost_usd})`)
  assert.equal(summary.totals.measured_step_count, 2)
  assert.equal(summary.totals.unmeasured_step_count, 0)
  assert.equal(summary.totals.unpriced_step_count, 0)
  assert.equal(summary.totals.complete, true, 'every step measured and priced: totals.complete is true')
  assert.equal(summary.wall_clock_min, 2, 'wall clock comes from the run\'s own startedAt/endedAt')
}

// ── 2. A step with no usage at all: excluded from totals, flagged ─────────
{
  const run = await store.createRun({
    workflowSlug: 'demo', workflowName: 'Demo', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [
      { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' },
      { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer' },
    ],
  })
  withUsage(run, 0, { status: 'completed', model: PRICED_MODEL, usage: { input_tokens: 200_000, output_tokens: 20_000 } })
  // step 2 threw before ever returning a result: no model, no usage - never guessed.
  withUsage(run, 1, { status: 'failed', model: undefined, usage: undefined })
  await store.saveRun(run)

  const summary = C.summarizeRunCost(run)
  const [s1, s2] = summary.steps
  assert.equal(s1.input_tokens, 200_000, 'the step that DID report usage keeps its real numbers')
  assert.equal(s2.input_tokens, null, 'the step with no usage reports null, never 0-that-looks-real')
  assert.equal(s2.cost_usd, null)
  assert.equal(s2.excludedReason, 'no-usage')
  // Only the measured step's tokens count toward the total.
  assert.equal(summary.totals.input_tokens, 200_000, 'the unmeasured step contributes nothing to the token total')
  assert.equal(summary.totals.output_tokens, 20_000)
  assert.ok(Math.abs(summary.totals.cost_usd - (0.2 * 3.0 + 0.02 * 15.0)) < 1e-9)
  assert.equal(summary.totals.measured_step_count, 1)
  assert.equal(summary.totals.unmeasured_step_count, 1, 'the unmeasured step is counted, not silently dropped')
  assert.equal(summary.totals.complete, false, 'a run with any unmeasured step is not a complete total')
}

// ── 3. Usage WAS observed, but the model has no SERVER_MODEL_META entry ───
{
  const run = await store.createRun({
    workflowSlug: 'demo', workflowName: 'Demo', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [{ stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' }],
  })
  withUsage(run, 0, { status: 'completed', model: UNPRICED_MODEL, usage: { input_tokens: 963_261, output_tokens: 11_551 } })
  await store.saveRun(run)

  const summary = C.summarizeRunCost(run)
  const [s1] = summary.steps
  assert.equal(s1.input_tokens, 963_261, 'a real, measured token count is kept even when the model can\'t be priced')
  assert.equal(s1.cost_usd, null, 'cost_usd is never a guessed/default rate for an unpriced model')
  assert.equal(s1.excludedReason, 'unpriced-model')
  assert.equal(summary.totals.input_tokens, 963_261, 'the unpriced step\'s real tokens still count toward the token total')
  assert.equal(summary.totals.cost_usd, 0, 'with the only step unpriced, cost_usd is honestly 0 - not a substituted default rate')
  assert.equal(summary.totals.measured_step_count, 1, 'it WAS measured - only pricing is missing')
  assert.equal(summary.totals.unmeasured_step_count, 0)
  assert.equal(summary.totals.unpriced_step_count, 1, 'flagged separately from "never measured"')
  assert.equal(summary.totals.complete, false)
}

// ── 4. Aggregation across several runs ─────────────────────────────────────
{
  const runA = await store.createRun({
    workflowSlug: 'agg', workflowName: 'Agg', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [{ stepId: 's1', label: 'A', agentSlug: 'sdlc-ticket-intake' }],
  })
  withUsage(runA, 0, { status: 'completed', model: PRICED_MODEL, usage: { input_tokens: 1_000_000, output_tokens: 0 } })
  await store.saveRun(runA)

  const runB = await store.createRun({
    workflowSlug: 'agg', workflowName: 'Agg', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [{ stepId: 's1', label: 'B', agentSlug: 'sdlc-fix-implementer' }],
  })
  withUsage(runB, 0, { status: 'completed', model: PRICED_MODEL, usage: { input_tokens: 2_000_000, output_tokens: 0 } })
  await store.saveRun(runB)

  // A third run with an unmeasured step - the aggregate must surface this,
  // not average it away.
  const runC = await store.createRun({
    workflowSlug: 'agg', workflowName: 'Agg', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [{ stepId: 's1', label: 'C', agentSlug: 'sdlc-ticket-intake' }],
  })
  withUsage(runC, 0, { status: 'failed', model: undefined, usage: undefined })
  await store.saveRun(runC)

  const runs = await store.listRuns('agg')
  assert.equal(runs.length, 3, 'sanity: all three runs are visible to listRuns')

  const agg = C.aggregateCost(runs)
  assert.equal(agg.run_count, 3)
  // 1.0*3.0 (run A) + 2.0*3.0 (run B) + 0 (run C, unmeasured) = 9.0
  assert.ok(Math.abs(agg.totals.cost_usd - 9.0) < 1e-9,
    `aggregate cost is the sum of each run's own total (expected 9.0, got ${agg.totals.cost_usd})`)
  assert.equal(agg.totals.input_tokens, 3_000_000, 'token totals sum across every run, run C\'s unmeasured step contributing 0')
  assert.equal(agg.totals.unmeasured_step_count, 1, 'the one unmeasured step anywhere in the set is still visible at the aggregate level')
  assert.equal(agg.totals.complete, false, 'one incomplete run makes the whole aggregate an honest partial, not silently whole')
  assert.equal(agg.runs.length, 3, 'the aggregate carries every run\'s own summary, not just the rolled-up numbers')

  // A clean subset (just A and B) IS a complete total - proves `complete`
  // isn't pinned false by something structural, only by what's actually missing.
  const cleanAgg = C.aggregateCost([runA, runB])
  assert.equal(cleanAgg.totals.complete, true, 'a set with no unmeasured/unpriced step aggregates to a complete total')
}

// ── 5. The note is present and states both caveats a reader needs ─────────
{
  const run = await store.createRun({
    workflowSlug: 'demo', workflowName: 'Demo', autoRun: false, watch: 'direct-invocation',
    initialPrompt: 'x', steps: [{ stepId: 's1', label: 'A', agentSlug: 'sdlc-ticket-intake' }],
  })
  await store.saveRun(run)
  const summary = C.summarizeRunCost(run)
  assert.ok(summary.note.includes('cache'), 'the note states the cache-token-folding caveat')
  assert.ok(summary.note.includes('unmeasured') || summary.note.includes('unpriced'),
    'the note states the exclusion caveat')
  const agg = C.aggregateCost([run])
  assert.equal(agg.note, summary.note, 'the run-level and aggregate-level notes are the identical exported constant')
}

console.log('cost report: all checks passed')
