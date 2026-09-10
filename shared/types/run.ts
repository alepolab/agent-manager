export type WorkflowRunStatus =
  /**
   * Admitted but not started: its concurrency group was full
   * (server/utils/runQueue.ts), so it waits for a slot.
   *
   * A real run from this moment on, not a placeholder — it has the id that
   * `RunStep.childRunIds`, a watch's dispatch record and a schedule's
   * `lastRunId` all persist, and the id in the /runs URL an operator may
   * already have open. It holds no working directory and no process; it takes
   * both when the queue drains it into `running`.
   *
   * `queued` counts as LIVE everywhere the question is "can this still
   * change": it is not settled, not restartable, not deletable, and not an
   * item in the attention queue (it needs nobody). The one place it counts as
   * idle is the workspace lock at launch time — see findRunInWorkspace.
   */
  | 'queued'
  /**
   * Stopped on a person who must decide about the ENTRIES of an artifact, not
   * merely say yes to a step.
   *
   * Raised when the gated step carries both `approval` and a `runWhen`
   * artifact: what that step will do depends on which entries survive the
   * review, so "approve this step" is the wrong question and answering it
   * yes acts on all of them. The decision is recorded by rewriting the
   * artifact (server/api/runs/[id]/decisions.post.ts), which is what makes it
   * bind on every step that reads the same file.
   *
   * Distinct from `paused` on purpose, and not merely for the colour: a paused
   * run resumes with one button, and this one cannot resume at all until the
   * entries have been decided. Live either way - it holds its working
   * directory and its group's slot while it waits.
   */
  | 'awaiting_review'
  /**
   * Waiting for the child runs a `triggerWorkflow` step with `join` started,
   * so it can carry on with what comes after them.
   *
   * The one live status that holds no slot in its concurrency group, and the
   * reason it exists rather than reusing `paused`. Children are admitted
   * through the same per-group count their parent would be in - so a parent
   * waiting in `running` or `paused` holds a slot against the queue its own
   * children sit in. At a cap of 1 that never resolves: the parent waits for
   * children that wait for the parent. See holdsGroupSlot below.
   *
   * It does still OWN things - its working directory and the process watching
   * for its children - so `isWorkingStatus` covers it, and a launch aimed at
   * that directory is refused while it waits. Only the slot count is different.
   *
   * Not `isWaitingOnAPerson`: nobody can advance it, and putting it in the
   * attention queue would ask an operator to act on a run that is getting on
   * with its work elsewhere. It runs no model and spends no budget meanwhile.
   */
  | 'joining'
  | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

/**
 * A run that can still change: it is waiting for a slot, working, or stopped
 * on a person. Everything else has reached an outcome.
 *
 * One function rather than the `status === 'running' || status === 'paused'`
 * that used to be spelled out at a dozen call sites, for the reason
 * app/utils/runStatus.ts states about colours: `queued` was added to the union
 * long after those sites were written, and every one of them read it as
 * "finished" — offering Restart on a run that had not started, ending its SSE
 * stream immediately, and letting Delete remove it from under the queue.
 *
 * Deliberately NOT the same set as workflowRunner.ts's `isSettled`, which
 * counts `paused` as settled because a paused run has handed control back.
 * That is a question about the wave loop; this is a question about the run.
 */
export function isLiveStatus(status: WorkflowRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'paused'
    || status === 'awaiting_review' || status === 'joining'
}

/**
 * A run that has stopped ON A PERSON: nothing will advance it until somebody
 * acts, and no amount of waiting changes that.
 *
 * The distinction the attention queue is built on, and the one that decides
 * whether a run can be dismissed from it. Dismissing a failure is a person
 * saying "I have seen this"; there is no equivalent for a run that is still
 * going to do something as soon as it is answered, so these two are the ones
 * that cannot be cleared away.
 */
export function isWaitingOnAPerson(status: WorkflowRunStatus): boolean {
  return status === 'paused' || status === 'awaiting_review'
}

/**
 * A run that OWNS something right now: a working directory and an owning
 * process. Everything `isLiveStatus` covers except `queued`, which is admitted
 * but holds nothing yet.
 *
 * A group's slot is the one thing this no longer answers for - `joining` owns
 * the rest without spending that - so the slot count reads `holdsGroupSlot`
 * below instead.
 *
 * The second predicate exists because three call sites keep needing exactly
 * this one and each had spelled it out as `running || paused`: the workspace
 * lock (findRunInWorkspace), the orphan check (applyInterrupted) and the
 * per-group slot count (inFlightForGroup). All three were written before
 * `awaiting_review` joined the union, and all three would have read it as
 * owning nothing - launching a second run into an occupied checkout, calling a
 * run that is merely waiting on a person `interrupted` at the next restart, and
 * handing its group's slot to something else while it still held the clone.
 */
export function isWorkingStatus(status: WorkflowRunStatus): boolean {
  return status === 'running' || status === 'paused' || status === 'awaiting_review'
    || status === 'joining'
}

/**
 * A run holding one of its concurrency group's slots.
 *
 * Everything `isWorkingStatus` covers except `joining`, and the exception is
 * the whole point: a joining parent is waiting for child runs that are admitted
 * against this very count, so counting it would have it queue behind itself.
 * At a cap of 1 that is a deadlock rather than a slowdown - the children never
 * start, so the parent never stops waiting.
 *
 * Separate from `isWorkingStatus` rather than carved out of it because the two
 * questions only look alike. A joining parent still owns its checkout and its
 * process, which is what every other caller of that predicate is asking about;
 * it is only the machine's budget for concurrent WORK that it is not spending.
 */
export function holdsGroupSlot(status: WorkflowRunStatus): boolean {
  return isWorkingStatus(status) && status !== 'joining'
}

/**
 * Every child of a join has reached an outcome, so the parent can go on.
 *
 * Takes the statuses rather than the runs so the rule stays testable under
 * plain node, and reads `isLiveStatus` rather than listing the terminal ones:
 * a status added to the union later is far more likely to be another way a run
 * can still change than another way it can be over, and the failure modes are
 * not symmetric. Treating a live child as settled resumes a parent while its
 * children are still writing; treating a settled child as live leaves the
 * parent waiting for something that will never publish again.
 */
export function childrenSettled(statuses: WorkflowRunStatus[]): boolean {
  return statuses.every(s => !isLiveStatus(s))
}

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
  /** Why the run is stopped on the operator: a step's question, a step that needs approval before it runs, or an artifact whose entries need deciding (see `artifact`). */
  question?: {
    stepId: string
    text: string
    kind: 'question' | 'approval'
    askedAt: number
    /** An approval raised by the runner itself: the budget is spent and continuing grants another allowance. */
    reason?: 'budget'
    /**
     * The artifact whose entries the operator is deciding about, named by the
     * gated step's own `runWhen` - set only alongside status
     * 'awaiting_review'.
     *
     * A pointer rather than the entries themselves. The drafts are large, they
     * are already durable in the run's artifacts directory, and copying them
     * into the run record would make two sources of truth for what is being
     * decided - one of which the deciding endpoint then has to keep in step.
     */
    artifact?: string
  }
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
  /**
   * The concurrency group this run counts against, snapshotted from the
   * workflow when the run was created.
   *
   * On EVERY run, not only queued ones, and for two reasons. Counting a
   * group's in-flight runs would otherwise mean reading a workflow file per
   * live run; and re-grouping a workflow would silently move runs already
   * under way from one cap to another. Runner-owned like `watch`: stated once
   * at creation, never re-derived.
   *
   * Absent means the default group (shared/types/workflowGroup.ts), never
   * "uncapped".
   */
  group?: string
  /**
   * The named channel this run's transition messages go to, snapshotted from
   * the workflow when the run was created.
   *
   * Snapshotted for the same reason `group` is, plus one of its own: the
   * transition hook runs inside publish(), which holds a run record and never
   * the workflow definition it came from. Without the snapshot there is no path
   * from a run to its workflow's channel at the moment the message is sent.
   *
   * Absent falls back to a channel named `default`, then to SLACK_WEBHOOK_URL
   * (server/utils/notify.ts).
   */
  notifyChannel?: string
  /**
   * When this run joined the queue, for a run that was queued rather than
   * started immediately.
   *
   * Distinct from `startedAt` on purpose, and the distinction is load-bearing:
   * `startedAt` is rewritten when the queue drains the run, because the run
   * budget is measured from it (server/utils/workflowRunner.ts's
   * budgetExceeded) and so are the reported wall clock and cost. A run that
   * waited four hours behind a full group and kept `startedAt` from queue time
   * would pause on a spent budget having done no work. Queue ORDER reads this
   * field; everything about elapsed work reads `startedAt`.
   */
  queuedAt?: number
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
  /** The process that owns this run. A live status from a dead pid is a lie.
   *  On a `queued` run this is the process that QUEUED it, which may well be
   *  gone by the time a slot frees: applyInterrupted deliberately does not
   *  look at a queued run for exactly that reason, and the owner is restated
   *  when the queue launches it. */
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
  /** See WorkflowRun.group — the caller states it from the workflow
   *  definition, createRun carries it straight onto the persisted run. */
  group?: string
  /** See WorkflowRun.notifyChannel — stated from the workflow definition and
   *  carried straight onto the persisted run, exactly like `group`. */
  notifyChannel?: string
  /** 'queued' for a run admitted but waiting for a slot; createRun stamps
   *  `queuedAt` itself when this says so. Absent means the run starts now. */
  status?: Extract<WorkflowRunStatus, 'running' | 'queued'>
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
