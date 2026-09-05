export type WorkflowRunStatus =
  | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type RunStepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface RunStep {
  stepId: string
  label: string
  /** The agent behind this step. The operator's real question is "which agent, and how is it doing". */
  agentSlug: string
  status: RunStepStatus
  input: string
  output: string
  error?: string
  startedAt?: number
  completedAt?: number
  visits: number
  monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  monitorNote?: string
  /** The model the agent call actually ran, as the SDK's own system/init
   *  message reported it (an observed id, e.g. 'claude-sonnet-4-6') - never
   *  the alias requested. Absent when a stub caller (tests) never returned
   *  one; `null` when the real caller ran but no init message reported a
   *  model. Never guessed either way, since a wrong value here is the kind
   *  of defect that produces no error. */
  model?: string | null
  /** Lightweight, THROTTLED progress telemetry surfaced from callAgent's SDK
   *  message loop while this step is still `running` — see
   *  server/utils/agentCaller.ts's AgentProgress doc comment for exactly
   *  what these mean and why they're capped to number/short-string. This is
   *  diagnostic telemetry, not provenance: never asserted by
   *  runArtifacts.ts's runnerOwned() and never written into a step's
   *  persisted artifact JSON, so it can never be mistaken for a fact the
   *  evidence bundle trusts. Absent — never a fabricated 0 — whenever the
   *  agent caller never reported anything (a test stub, or a real call that
   *  produced no assistant turn before failing). */
  /** Assistant messages observed on the SDK stream so far.
   *
   *  NOT the SDK's own turn count, and deliberately not named as though it
   *  were: it is NOT comparable to the agent's `maxTurns` budget. A real run
   *  measured 87 assistant messages against a `maxTurns: 40` provisioner that
   *  ended in `error_max_turns` — read as "87 of 40", that reads as a broken
   *  budget, and the budget was in fact working correctly. The exact
   *  relationship between the two is an SDK internal this code has not
   *  measured, so it is not asserted here. Use this to see that an agent is
   *  still moving and roughly how much it has done, never to judge how close
   *  it is to its limit. */
  /** Why this step declared itself not applicable, when `status` is
   *  'skipped' because the agent emitted `PIPELINE-SKIP:`. Absent for a step
   *  the scheduler skipped after an upstream failure - those two are very
   *  different events and the bundle must not conflate them. */
  skipReason?: string
  assistantMessages?: number
  lastTool?: string
  lastActivityAt?: number
}

export interface WorkflowRun {
  id: string
  workflowSlug: string
  workflowName: string
  status: WorkflowRunStatus
  autoRun: boolean
  initialPrompt: string
  /** What triggered this run: the id of the watch (registry/watches.yaml)
   *  that dispatched it, or the reserved literal 'direct-invocation' for a
   *  run started manually (the API route, run-ticket.mjs). Set once at
   *  creation by the runner itself — never inferred from, or left to, an
   *  agent's self-report. Non-nullable on purpose: "what triggered this?"
   *  always has an honest answer, and 'direct-invocation' is it when
   *  nothing did. */
  watch: string
  projectDir?: string
  /** `projectDir`'s HEAD sha, captured by the runner (startRun, via
   *  gitFacts.ts's captureBaseline) the instant this run started, before any
   *  step ran. gitFacts.ts's computeFixFacts diffs the CURRENT HEAD against
   *  THIS sha — never against a branch's default base (`main`) — to compute
   *  what this run actually committed. Runner-owned provenance, exactly
   *  like `watch` and `identity`: set once at creation, never inferred from
   *  or trusted from an agent's self-report. Absent when `projectDir` was
   *  missing, not a git repo, or had no commits yet (an unborn HEAD) at
   *  start — computeFixFacts then computes nothing rather than falling back
   *  to a guessed base, since that fallback is exactly the fabrication this
   *  field exists to prevent. */
  baseCommit?: string
  steps: RunStep[]
  currentStepIds: string[]
  nextStepIds: string[]
  startedAt: number
  endedAt?: number
  error?: string
  /** The process that owns this run. A live status from a dead pid is a lie. */
  pid: number
}

/**
 * One step's contribution to a run's cost, as computed by
 * server/utils/costReport.ts — never fabricated. `input_tokens`/`output_tokens`
 * are `null` when the step never reported usage at all (see RunStep.model's
 * doc comment for the same never-guessed rule). `cost_usd` is `null` when it
 * cannot be honestly computed — either no usage was observed, or usage WAS
 * observed but the model it ran on has no entry in
 * server/utils/models.ts's SERVER_MODEL_META — `excludedReason` says which.
 * A step can have real, counted tokens and still have `cost_usd: null` (an
 * unpriced model) — the two are tracked separately on purpose.
 */
export interface StepCost {
  stepId: string
  label: string
  agentSlug: string
  status: RunStepStatus
  /** The model this step actually ran, exactly as RunStep.model records it. */
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  excludedReason?: 'no-usage' | 'unpriced-model'
  visits: number
}

/**
 * A single run's cost, built from its own `steps` — never re-derived from an
 * assumed default. `totals.input_tokens`/`output_tokens` sum every step that
 * reported usage, regardless of whether its model could be priced (a real
 * token spend is real even when its price is unknown). `totals.cost_usd`
 * sums only the steps that were BOTH measured and priced; it is a genuine
 * partial total, not the whole run's spend, whenever `totals.complete` is
 * false. `note` restates the two caveats every reader needs to draw a
 * correct comparison: (1) `input_tokens` folds fresh, cache-creation and
 * cache-read tokens into one figure (agentCaller.ts's usageFrom), so
 * `cost_usd` prices that whole figure at the model's plain input rate — an
 * upper bound, since cache reads actually bill lower and the SDK's usage
 * object does not preserve the split needed to compute the exact number;
 * (2) unmeasured or unpriced steps are excluded from `cost_usd`, not
 * assumed free.
 */
export interface RunCostSummary {
  runId: string
  workflowSlug: string
  workflowName: string
  status: WorkflowRunStatus
  startedAt: number
  endedAt?: number
  wall_clock_min: number
  attempts: number
  steps: StepCost[]
  totals: {
    input_tokens: number
    output_tokens: number
    cost_usd: number
    measured_step_count: number
    /** Steps that never reported usage at all. */
    unmeasured_step_count: number
    /** Steps that reported usage but ran on a model absent from SERVER_MODEL_META. */
    unpriced_step_count: number
    /** True only when every step's tokens made it into cost_usd — false means
     *  cost_usd is a real but PARTIAL total, not the run's whole spend. */
    complete: boolean
  }
  note: string
}

/** Cost summed over several runs — a week's spend, a workflow's spend, etc.
 *  Never a re-estimate: it is exactly the sum of each run's own
 *  RunCostSummary, so the same "never fabricate, exclude what wasn't
 *  measured or priced" rules apply at this level too. */
export interface CostAggregate {
  run_count: number
  totals: RunCostSummary['totals']
  runs: RunCostSummary[]
  note: string
}

export interface NewRunInput {
  workflowSlug: string
  workflowName: string
  autoRun: boolean
  initialPrompt: string
  /** See WorkflowRun.watch — the caller states it, createRun carries it
   *  straight onto the persisted run, unmodified. */
  watch: string
  projectDir?: string
  /** See WorkflowRun.baseCommit — startRun captures it via
   *  gitFacts.ts's captureBaseline and passes it straight through; createRun
   *  carries it onto the persisted run, unmodified. */
  baseCommit?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}
