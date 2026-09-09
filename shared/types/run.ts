export type WorkflowRunStatus =
  | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type RunStepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  /** The step stopped to ask the operator something and waits for the answer. */
  | 'waiting'

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
  /** The Claude Code session the latest visit ran in, and the project folder
   *  under `~/.claude/projects` holding its transcript: together the /cli link. */
  sessionId?: string
  sessionProject?: string
  /** When this visit continued an earlier SDK session rather than starting one, that session's id. */
  resumedFrom?: string
  /** Tokens the agent call actually consumed, as the SDK reported them. */
  usage?: { input_tokens: number, output_tokens: number, /** Of input_tokens, served from the prompt cache. */ cache_read_input_tokens?: number, /** The SDK's own cost figure for the call, when it reported one. */ usd?: number } | null
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
  /** Why this step did no work, when `status` is 'skipped'. Two producers set
   *  it: the agent emitted `PIPELINE-SKIP:` (it declared itself not
   *  applicable), or the step's `runWhen` condition was not met (the artifact
   *  it consumes holds nothing, so the runner never called it) - in which case
   *  the reason names the file and what was found in it. Absent for a step the
   *  scheduler skipped after an upstream failure. All three are very different
   *  events and the bundle must not conflate them.
   *
   *  Load-bearing beyond reporting: `rehydrate` treats a step as settled only
   *  when it is 'completed', or 'skipped' WITH a reason. A condition skip that
   *  recorded no reason would read back as unsettled after a restart, its
   *  successors would never be armed, and the run would wedge. */
  skipReason?: string
  assistantMessages?: number
  lastTool?: string
  lastActivityAt?: number
  /** Runs a `triggerWorkflow` step started, in the order it dispatched them.
   *  The step does not wait for them, so this is the only link back: without
   *  it a dispatched child is an orphan run nobody can trace to its cause. */
  childRunIds?: string[]
}

/** CI outcome of the PR a run opened, recorded by the poller after the run completes. */
export interface RunCi {
  pr: string
  status: 'pending' | 'passing' | 'failing' | 'unknown'
  checks: { name: string, bucket: string }[]
  checkedAt: number
  /** True once the checks reached a final state; the poller stops looking. */
  final: boolean
  error?: string
}

export interface RunUsage { input_tokens: number, output_tokens: number, /** Of input_tokens, the ones read back from the prompt cache. */ cached_tokens?: number, usd: number }
export interface RunBudget { maxMinutes: number, maxTokens: number }

/** The registry entry a run resolved to at start, or absent when nothing matched. */
export interface ProductMatch {
  name: string
  suite?: string
  /** Every listed repo gets its own branch and PR; plan.md must give a merge order. */
  multiRepo?: boolean
  repos: string[]
  /** For a container repo whose real content is sibling repos: directory under
   *  the parent checkout -> the repo that fills it. Cloning the parent alone
   *  does not produce these, because it git-ignores them. */
  modules?: Record<string, string>
  branches: Record<string, string>
  stack: { compose: string, topology_default: string, liquibase?: boolean }
  tests: Record<string, string>
  recipe?: string
  /** Products a step widened the run to, with their own stack and tests: the fault turned out to live there. */
  alsoInScope?: { name: string, repos: string[], stack?: { compose: string, topology_default: string }, tests: Record<string, string> }[]
}

export interface WorkflowRun {
  id: string
  workflowSlug: string
  workflowName: string
  status: WorkflowRunStatus
  autoRun: boolean
  initialPrompt: string
  /** What triggered this run: the id of the watch (registry/watches.yaml)
   *  that dispatched it, `schedule:<id>` for a cron fire
   *  (server/utils/scheduleRunStarter.ts),
   *  `workflow-trigger:<parentRunId>` for a child a triggerWorkflow step
   *  dispatched, or the reserved literal 'direct-invocation' for a run started
   *  manually (the API route, run-ticket.mjs). Set once at creation by the
   *  runner itself — never inferred from, or left to, an agent's self-report.
   *  Non-nullable on purpose: "what triggered this?" always has an honest
   *  answer, and 'direct-invocation' is it when nothing did. */
  watch: string
  /** The ticket this run is for (e.g. 'DEVOPS-15'), when the caller knows it.
   *  Runner-owned like `watch`: stated once at creation, never inferred from
   *  anything an agent writes. Its only job is to tell the notifier which
   *  issue to comment on when the run finishes with a pull request. */
  ticketKey?: string
  /** Branch the runner created in projectDir for this run's commits; absent when there was no checkout. */
  branch?: string
  /** Intake's classification, read from meta.json once written: the kind of work and where the defect was found. */
  workType?: string
  origin?: string
  /** The branch the run branch was cut from and the pull request targets (see server/utils/branchPolicy.ts). */
  baseBranch?: string
  /** How many times a step sent the run back to an earlier step; bounded, so two steps cannot ping-pong forever. */
  reworks?: number
  /** Set when a developer cleared this run from the home page's attention queue. History keeps it. */
  dismissed?: boolean
  /** A Jira step already posted the outcome comment; settling must not post a second one. */
  ticketCommented?: boolean
  /** Why the run is paused on the operator: a step's question, or a step that needs approval before it runs. */
  /**
   * What the runner checked before any agent ran: the compose file, the
   * checkout, git as the agents see it, docker, the Jira statuses this
   * workflow will ask for. A `fail` here stops the run in seconds instead of
   * a step discovering it forty minutes in. Diagnostics, not provenance.
   */
  /**
   * Consecutive times a server restart froze this run mid-step. Reset the
   * moment a step completes. Above a small bound the run pauses and asks
   * rather than being resumed into the same wall again.
   */
  interruptions?: number
  preflight?: { at: number, checks: { name: string, level: 'ok' | 'warn' | 'fail' | 'skip', detail: string }[] }
  question?: { stepId: string, text: string, kind: 'question' | 'approval', askedAt: number, /** An approval raised by the runner itself: the budget is spent and continuing grants another allowance. */ reason?: 'budget' }
  projectDir?: string
  /**
   * The workflow's declared inputs, resolved to values once when this run
   * started, and stated to every step by artifactHeader's `## Run parameters`
   * block.
   *
   * Runner-owned, exactly like `watch`, `ticketKey` and `baseCommit`: the
   * starter states them, they are persisted here, and nothing re-derives them
   * later or reads them back out of an agent's output. A step that wants to
   * change one cannot - which is the point, since a run whose stated inputs
   * drift halfway through has no honest answer to "what was this run given?".
   *
   * Only names the workflow declared are here: see
   * shared/utils/workflowParameters.ts.
   */
  parameters?: Record<string, string>
  product?: ProductMatch
  /** GitHub login of the developer who started or last resumed this run; their identity is used for pushes, PRs and Jira. */
  startedBy?: string
  /** The run whose `triggerWorkflow` step started this one; absent on a run
   *  nothing dispatched. Runner-owned, set once at creation. It is what makes
   *  cross-workflow recursion visible: the graph model guards cycles inside
   *  one workflow, and only this chain can see A dispatching B dispatching A. */
  parentRunId?: string
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
  /** Runner-owned totals over every step, recomputed on each publish. */
  usage?: RunUsage
  ci?: RunCi
  /** Caps checked between waves. Defaults come from AGENT_RUN_MAX_MINUTES and AGENT_RUN_MAX_TOKENS. */
  budget: RunBudget
  currentStepIds: string[]
  nextStepIds: string[]
  /** Wall-clock moment this run was first created, and the moment it last
   *  settled. NOT its duration: a restart resumes the same run id after an
   *  arbitrary gap, so `endedAt - startedAt` counts the hours a failed run sat
   *  waiting for a person. Read the duration from shared/utils/runClock.ts's
   *  runElapsedMs, never by subtracting these. */
  startedAt: number
  endedAt?: number
  /** Milliseconds this run has spent executing, summed over the stretches that
   *  have closed; the stretch open right now is `runningSince`. Owned by the
   *  run clock (shared/utils/runClock.ts) and advanced only by publish(), the
   *  one place every status transition passes through. Absent on runs recorded
   *  before the clock existed - the clock falls back to wall clock for those
   *  rather than inventing a figure their record never held. */
  activeMs?: number
  /** When the stretch in flight began, or absent when the run is not running.
   *  A stretch left open by a process that died is closed at the last activity
   *  the record knows of, never at `now`. */
  runningSince?: number
  error?: string
  /** The process that owns this run. A live status from a dead pid is a lie. */
  pid: number
  /** Random id of the server process that owns this run. In a container every
   *  process is pid 1, so pid alone cannot tell a replaced owner from a live one. */
  bootId?: string
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
  /** Minutes the run spent EXECUTING, from the run clock - not
   *  `endedAt - startedAt`. See shared/utils/runClock.ts for why the two differ
   *  for any run that was ever restarted. */
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
  /** See WorkflowRun.ticketKey — the caller states it, createRun carries it
   *  straight onto the persisted run, unmodified. */
  ticketKey?: string
  projectDir?: string
  /** See WorkflowRun.parameters - the caller resolves them, createRun carries
   *  them straight onto the persisted run, unmodified. */
  parameters?: Record<string, string>
  product?: ProductMatch
  startedBy?: string
  /** See WorkflowRun.parentRunId — the caller states it, createRun carries it
   *  straight onto the persisted run, unmodified. */
  parentRunId?: string
  /** See WorkflowRun.baseCommit — startRun captures it via
   *  gitFacts.ts's captureBaseline and passes it straight through; createRun
   *  carries it onto the persisted run, unmodified. */
  baseCommit?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}
