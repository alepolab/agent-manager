import { resolveModelMeta } from './models.ts'
import type { AgentUsage } from './agentCaller.ts'
import type { RunStep, WorkflowRun, StepCost, RunCostSummary, CostAggregate } from '~~/shared/types/run'

/** RunStep doesn't declare `usage` in shared/types/run.ts — it is attached at
 *  runtime via Object.assign in workflowRunner.ts's executeNode, the same
 *  pattern runArtifacts.ts already reads back (see its StepWithUsage). Kept
 *  local here for the same reason: it is a fact about how the runner writes
 *  the object, not a shape this module should widen the shared type for. */
type StepWithUsage = RunStep & { usage?: AgentUsage | null }

/**
 * The two caveats every reader of a cost figure needs before comparing two
 * numbers - see RunCostSummary's doc comment in shared/types/run.ts for the
 * full reasoning. Kept as one exported constant so the API routes, the CLI,
 * and any future UI surface all show the identical sentence rather than each
 * writing (and inevitably drifting from) their own paraphrase.
 */
export const COST_NOTE =
  'input_tokens folds fresh input, cache-creation, and cache-read tokens into one figure ' +
  '(see agentCaller.ts\'s usageFrom); cost_usd prices that whole figure at the model\'s plain ' +
  'input rate, which is an upper bound - cache-read tokens actually bill lower, but the SDK\'s ' +
  'usage object does not preserve the split needed to compute the exact figure. Steps with no ' +
  'observed usage, or run on a model with no SERVER_MODEL_META pricing entry, are excluded from ' +
  'cost_usd and counted separately in unmeasured_step_count / unpriced_step_count - never assumed ' +
  'to cost zero. cost_usd is a genuine total only when totals.complete is true; otherwise it is a ' +
  'real but partial sum.'

/**
 * Prices one step's observed usage. Returns `cost_usd: null` - never a
 * guessed or default-rate figure - when usage was never observed, or when it
 * was observed but the model it ran on has no entry in SERVER_MODEL_META.
 * `resolveModelMeta` is called directly rather than through
 * `getModelPricing` (models.ts) on purpose: that helper falls back to
 * DEFAULT_PRICING for an unknown model, which is exactly the fabrication
 * this function exists to refuse.
 */
export function stepCost(step: StepWithUsage): StepCost {
  const base = {
    stepId: step.stepId,
    label: step.label,
    agentSlug: step.agentSlug,
    status: step.status,
    model: step.model ?? null,
    visits: step.visits ?? 1,
  }

  const usage = step.usage
  if (!usage) {
    return { ...base, input_tokens: null, output_tokens: null, cost_usd: null, excludedReason: 'no-usage' }
  }

  const meta = resolveModelMeta(step.model ?? undefined)
  if (!meta) {
    return {
      ...base,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: null,
      excludedReason: 'unpriced-model',
    }
  }

  const cost_usd =
    (usage.input_tokens / 1_000_000) * meta.pricing.input +
    (usage.output_tokens / 1_000_000) * meta.pricing.output

  return { ...base, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd }
}

/**
 * One run's full cost picture: every step priced individually via
 * `stepCost`, then summed. `totals.input_tokens`/`output_tokens` include
 * every step that reported usage, priced or not - a real token spend stays
 * real even when its price is unknown, so it is never dropped from the
 * token count, only from `cost_usd`.
 */
export function summarizeRunCost(run: WorkflowRun): RunCostSummary {
  const steps = run.steps.map(s => stepCost(s as StepWithUsage))

  let input_tokens = 0
  let output_tokens = 0
  let cost_usd = 0
  let measured_step_count = 0
  let unmeasured_step_count = 0
  let unpriced_step_count = 0

  for (const s of steps) {
    if (s.excludedReason === 'no-usage') { unmeasured_step_count += 1; continue }
    measured_step_count += 1
    input_tokens += s.input_tokens ?? 0
    output_tokens += s.output_tokens ?? 0
    if (s.excludedReason === 'unpriced-model') { unpriced_step_count += 1; continue }
    cost_usd += s.cost_usd ?? 0
  }

  const ended = run.endedAt ?? Date.now()

  return {
    runId: run.id,
    workflowSlug: run.workflowSlug,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    wall_clock_min: Math.round((ended - run.startedAt) / 60000),
    attempts: Math.max(1, ...run.steps.map(s => s.visits ?? 1)),
    steps,
    totals: {
      input_tokens,
      output_tokens,
      cost_usd,
      measured_step_count,
      unmeasured_step_count,
      unpriced_step_count,
      complete: unmeasured_step_count === 0 && unpriced_step_count === 0,
    },
    note: COST_NOTE,
  }
}

/**
 * Sums several runs' own RunCostSummary totals - never a fresh estimate
 * computed some other way, so a week's total and the sum of that week's
 * per-run totals can never quietly disagree.
 */
export function aggregateCost(runs: WorkflowRun[]): CostAggregate {
  const summaries = runs.map(summarizeRunCost)

  const totals = summaries.reduce(
    (acc, s) => ({
      input_tokens: acc.input_tokens + s.totals.input_tokens,
      output_tokens: acc.output_tokens + s.totals.output_tokens,
      cost_usd: acc.cost_usd + s.totals.cost_usd,
      measured_step_count: acc.measured_step_count + s.totals.measured_step_count,
      unmeasured_step_count: acc.unmeasured_step_count + s.totals.unmeasured_step_count,
      unpriced_step_count: acc.unpriced_step_count + s.totals.unpriced_step_count,
      complete: acc.complete && s.totals.complete,
    }),
    {
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      measured_step_count: 0, unmeasured_step_count: 0, unpriced_step_count: 0,
      complete: true,
    },
  )

  return { run_count: runs.length, totals, runs: summaries, note: COST_NOTE }
}
