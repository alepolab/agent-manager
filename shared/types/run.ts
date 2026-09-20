import type { Role } from './role'

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
  /**
   * Whose work this step is, copied from the workflow at run creation \u2014 the way
   * `gateRole` is copied onto `run.question.role` when a gate fires.
   *
   * Copied rather than looked up so the run page renders a chip without
   * loading the workflow, and so a later template edit cannot rewrite a
   * finished run's history. Absent on every run recorded before the field
   * existed; those render no owner rather than a guessed one.
   */
  ownerRole?: Role
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
  /**
   * The directory this step's agent worked in, when it was not the run's own
   * worktree: its lane, cut because the step ran concurrently with others.
   * Absent for every step of a single-step wave, which works in run.projectDir.
   */
  worktree?: string
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
  /** Why this step declared itself not applicable, when `status` is
   *  'skipped' because the agent emitted `PIPELINE-SKIP:`. Absent for a step
   *  the scheduler skipped after an upstream failure - those two are very
   *  different events and the bundle must not conflate them. */
  skipReason?: string
  assistantMessages?: number
  lastTool?: string
  lastActivityAt?: number
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

/**
 * One human decision at one gate, kept on the run.
 *
 * Nothing survived a decision before this. An approval note went into the
 * runner's in-memory `l.notes` and died with the process; a rejection was
 * concatenated into `run.error`. So by the time a reviewer reached the fourth
 * gate of a runbook, the record could not say who had said yes to the first
 * three, or why — and no screen could show how long any gate had waited,
 * because `run.question` is cleared the moment it is answered.
 *
 * `waitedMs` is that lost number: how long the pipeline sat waiting for a
 * person. It is computed once, here, from the question's own `askedAt`, because
 * after this it is unrecoverable.
 */
export interface RunDecision {
  stepId: string
  /** The step's label at the time, so the record reads without the workflow beside it. */
  label: string
  at: number
  /** GitHub login of whoever decided. */
  by: string
  verdict: 'approved' | 'rejected' | 'sent-back'
  /** The reviewer's reason. Required for every verdict except a plain approval. */
  note?: string
  /** Milliseconds this gate waited for a person, from `question.askedAt` to `at`. */
  waitedMs: number
  /** For `sent-back`: the step the work was returned to. */
  target?: string
  /** The run's blast radius at the time, so a later reader can see what the tier demanded. */
  blastRadius?: string
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
  /**
   * How far a mistake here reaches, from intake's own classification: one of
   * `docs`, `ui_parsing`, `schema`, `deployment`, `protocol`, `money`.
   *
   * Read from the same meta.json as the two above, which has always carried it
   * — the reader simply dropped it, so the run record had no risk tier and
   * every gate fired identically whether the change was a typo or the tax
   * base. shared/utils/oversight.ts turns this into whether a gate stops.
   */
  blastRadius?: string
  /**
   * Where `blastRadius` came from: `proposal` when a step's own
   * `PIPELINE-CLASS:` line stood, `floor` when the files the change touched
   * implied something stronger and overrode it, `floor-only` when no step
   * proposed anything. A class without its provenance is an assertion, and the
   * `floor` case is the one a reviewer most needs to see: it means a step
   * understated its own change. See shared/utils/classification.ts.
   */
  classSource?: string
  /**
   * The product whose stack THIS run started, so teardown can find it even
   * after a restart - the fact has to outlive the in-memory run state, or a
   * server that died mid-run leaves containers nobody owns.
   */
  stackStarted?: string
  /** What happened when the stack was taken down, recorded so a reader can see it did. */
  stackStopped?: string
  /** The branch the run branch was cut from and the pull request targets (see server/utils/branchPolicy.ts). */
  baseBranch?: string
  /** How many times a step sent the run back to an earlier step; bounded, so two steps cannot ping-pong forever. */
  reworks?: number
  /** Every human decision taken at a gate on this run, oldest first. Append-only. */
  decisions?: RunDecision[]
  /** Set when a developer cleared this run from the home page's attention queue. History keeps it. */
  dismissed?: boolean
  /** A Jira step already posted the outcome comment; settling must not post a second one. */
  ticketCommented?: boolean

  /**
   * True while the outcome comment is owed but not yet on the ticket.
   *
   * Written WITH the terminal status, cleared only once the comment really
   * posted. A process that dies in between leaves this true, and the boot
   * sweep finishes it - the alternative is a ticket that never learns its run
   * finished, which nothing else in the system would ever notice.
   */
  ticketNotifyPending?: boolean

  /**
   * Paths of the `.agent/test-unlock.json` files this run wrote.
   *
   * On the record rather than in memory so the capability is withdrawn even
   * when another process finishes the run. Cleared when they are removed.
   */
  testUnlocks?: string[]
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
  /**
   * Why the run is paused, and — for an approval — whose decision it is.
   *
   * `role` is copied from the gated step's `gateRole` when the gate fires. Without
   * it every holder of `answerGate` could answer every gate, so "QA answers the
   * verification gate" was a sentence in a code comment rather than something the
   * system did. Absent means nobody in particular: any `answerGate` holder may
   * answer, which is the old behaviour and the right default for a workflow that
   * never said.
   */
  question?: { stepId: string, text: string, kind: 'question' | 'approval', askedAt: number, role?: Role, /** An approval raised by the runner itself: the budget is spent and continuing grants another allowance. */ reason?: 'budget' }
  projectDir?: string
  product?: ProductMatch
  /** GitHub login of the developer who started or last resumed this run; their identity is used for pushes, PRs and Jira. */
  startedBy?: string
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
  product?: ProductMatch
  startedBy?: string
  /** See WorkflowRun.baseCommit — startRun captures it via
   *  gitFacts.ts's captureBaseline and passes it straight through; createRun
   *  carries it onto the persisted run, unmodified. */
  baseCommit?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}
