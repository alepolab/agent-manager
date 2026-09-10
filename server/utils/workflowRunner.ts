import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed, maxVisitsOf,
  skipPending, isFinished, armNode, canRevisit, joinInputs, parseVerdict, parseHalt, parseSkip, parseWiden, parseRework,
  monitorPrompt, MAX_CONCURRENCY, ancestorsOf, gateSatisfied, markSkippedByCondition, planDispatch,
  planListDispatch,
  type WorkflowGraph, type RunState, type TriggerWorkflowConfig, type DispatchTarget,
} from '../../shared/utils/workflowGraph.ts'   // relative, not an alias: the node
                                               // test scripts import this file
                                               // directly and cannot resolve ~~/
import { runElapsedMinutes, startRunClock, settleRunClock, reconcileRunClock } from '../../shared/utils/runClock.ts'
import { defaultBudget, createRun, getRun, saveRun, listRuns, loadWorkflowSteps, findActiveRun, findRunInWorkspace, BOOT_ID } from './workflowRunStore.ts'
import { runWorkspace, hasCheckout, browserSurface } from './workspace.ts'
import { resolveProduct, productByKey, registeredProductKeys } from './registry.ts'
import { resolveModelMeta } from './models.ts'
import { onRunTransition } from './notify.ts'
import { envForUser } from './users.ts'
import { callAgent, type AgentUsage, type AgentProgress, type AgentCallOptions } from './agentCaller.ts'
import { AgentResultError, declaredModelOf } from './agentCaller.ts'
import { captureBaseline } from './gitFacts.ts'
import { baseBranchFor, describeBranchChoice } from './branchPolicy.ts'
import { artifactsWritable, checkoutDirFor, ensureRunBranch, findCheckout } from './workspace.ts'
import { runPreflight as realPreflight, preflightFailure, type PreflightReport, type PreflightSteps } from './preflight.ts'

/**
 * Preflight, overridable the way the agent caller is. A runner check is about
 * the runner; whether THIS machine has a checkout, a docker daemon or the
 * plugin installed is what scripts/test-preflight.mjs is for.
 */
let preflight: (run: WorkflowRun, steps: PreflightSteps[]) => Promise<PreflightReport> = realPreflight
export function setPreflight(fn: typeof preflight) { preflight = fn }
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir } from './claudeDir.ts'
import {
  runArtifactsDir, initRunArtifacts, writeStepArtifact, finalizeRunArtifacts, artifactHeader,
  markArtifactsUnusable, resolveRunArtifact, writeArtifactJson, readArtifactEntries,
} from './runArtifacts.ts'
import { createLogger, preview } from './log.ts'
import { notifyTicketOutcome } from './ticketNotifier.ts'
import { runJiraStep, type JiraStepConfig } from './jiraSteps.ts'
import { runNotifyStep, type NotifyStepConfig } from './notifySteps.ts'
import { admit, drainRunQueue, groupOf, mightHaveWaiting, noteQueued, type LaunchOutcome } from './runQueue.ts'
// Relative, not an alias, for the same reason workflowGraph.ts above is: the
// node test scripts import this module directly and resolve no aliases.
import { DEFAULT_GROUP_ID } from '../../shared/types/workflowGroup.ts'
import { childrenSettled } from '../../shared/types/run.ts'
import { resolveParameters, RESERVED_PARAM_PROJECT_DIR, type WorkflowParameter } from '../../shared/utils/workflowParameters.ts'
import { workspaceRootFor } from './workspace.ts'
import type { ProductMatch, WorkflowRun, RunStep, RunUsage } from '~~/shared/types/run'

const log = createLogger('runner')

// Widened to a union rather than requiring every caller to return the
// richer shape: dozens of test stubs across this file's own test suite
// return a plain string via setAgentCaller(), and the real callAgent() (see
// agentCaller.ts) now returns { output, model, usage } so the runner can
// record which model actually ran, and how many tokens it actually used,
// instead of asserting constants. Both are valid AgentCaller results;
// normalizeAgentResult() below is the one place that tells them apart.
export type AgentCallOutput = string | { output: string, model: string | null, usage?: AgentUsage | null }
export type AgentCaller =
  // The options bag is additive: every existing test stub (2- or 3-arg
  // functions registered via setAgentCaller) remains a valid AgentCaller under
  // TS's structural typing, and simply never receives it.
  (agentSlug: string, input: string, projectDir?: string, opts?: AgentCallOptions) => Promise<AgentCallOutput>

/** Resolves the environment a run's starter should run agents with. Test seam. */
export type EnvResolver = (login: string | undefined) => Promise<Record<string, string>>
let envResolver: EnvResolver = (login) => envForUser(login)
export function setEnvResolver(fn: EnvResolver) { envResolver = fn }

// The real caller is imported and wired here directly, at module scope, in
// the same file that reads it. Previously this defaulted to a throwing stub
// and relied on server/utils/agentCaller.ts calling setAgentCaller() as a
// side effect of being imported *somewhere* on the request path — but that
// import (a bare `import './agentCaller'` with no bound names) was silently
// dropped by Nitro's dev bundler, so the throwing stub was all `executeNode`
// ever saw. Importing the function directly removes the import-order
// dependency entirely: there is no window where the module is loaded but
// not yet wired. setAgentCaller() is kept so tests can still substitute a
// stub without touching the real SDK.
let agentCaller: AgentCaller = callAgent
export function setAgentCaller(fn: AgentCaller) { agentCaller = fn }
/** Exposed for tests: the exact function reference executeNode will call next. */
export function getAgentCaller() { return agentCaller }
/** True unless a test has overridden the caller with setAgentCaller(). */
export function isRealAgentCallerActive() { return agentCaller === callAgent }

interface WorkflowLike {
  slug: string
  name: string
  /** See Workflow.group (app/types/index.ts) - the concurrency group this
   *  workflow's runs count against. Absent means the default group. */
  group?: string
  /** See Workflow.notifyChannel - where this workflow's run transitions are announced. */
  notifyChannel?: string
  steps: { id: string, agentSlug: string, label: string, next?: string[], monitorSlug?: string, maxVisits?: number, approval?: boolean, contextMode?: 'predecessors' | 'ancestors', jira?: JiraStepConfig, testsUnlocked?: boolean, runWhen?: { artifact: string }, triggerWorkflow?: TriggerWorkflowConfig, notify?: NotifyStepConfig }[]
}

export interface StartRunOpts {
  /** A registry product key the caller has chosen; skips resolution from the prompt. */
  productKey?: string
  workflow: WorkflowLike
  initialPrompt: string
  /** See WorkflowRun.watch (shared/types/run.ts) — the id of the watch that
   *  dispatched this run, or 'direct-invocation' for a manually-started
   *  one. Threaded straight to createRun; no default here, since a silent
   *  default is exactly the kind of guess this field exists to rule out. */
  watch: string
  /** See WorkflowRun.ticketKey - the issue this run is for, when known. */
  ticketKey?: string
  autoRun: boolean
  projectDir?: string
  startedBy?: string
  /** See WorkflowRun.parentRunId - the run whose triggerWorkflow step started
   *  this one. Threaded straight to createRun, like `watch`. */
  parentRunId?: string
  /** See WorkflowRun.parameters - the workflow's declared inputs, ALREADY
   *  resolved by the caller against its declarations
   *  (shared/utils/workflowParameters.ts). Resolved there rather than here
   *  because the caller is the only one that can answer a missing required
   *  input: the route 400s, the schedule records it and starts nothing, the
   *  dispatch step reports it against its own entry. Threaded straight to
   *  createRun, like `watch`. */
  parameters?: Record<string, string>
}

/** In-memory scheduling state, keyed by run id. Lost on restart — which is
 *  exactly why a run whose owner died reads back as `interrupted`. */
interface Live {
  workflow: WorkflowLike
  graph: WorkflowGraph
  state: RunState
  outputs: Record<string, string>
  lastInputs: Record<string, string>
  retryFeedback: Record<string, string>
  stopped: boolean
  /** One controller per step in flight, so stopRun can cancel the SDK call
   *  itself rather than only marking the record. */
  aborts: Map<string, AbortController>
  /** Live output per step id: what the agent is doing right now, newest last. Capped; the full log is the step's .log artifact. */
  logs: Record<string, string[]>
  /**
   * stepId -> the SDK session its next visit continues. Set by the three
   * places a step runs again for a reason that is not "the work was wrong":
   * it ran out of turns, the operator answered it, or a person restarted it.
   */
  resumeFrom: Record<string, string>
  /** Steps the operator has approved to run (see WorkflowStep.approval). */
  approved: Set<string>
  /** Operator notes addressed to a step, delivered with its next input. */
  notes: Record<string, string>
  /** A note for whichever step starts next. */
  nextNote?: string
  /** Per step in flight: pushes an operator note into the agent's conversation; false once the call is over. */
  steer: Map<string, (text: string) => boolean>
  /** The step that asked the operator a question and waits for the answer. */
  waiting?: string
  /** The dispatch step waiting for the child runs it started (`triggerWorkflow.join`).
   *  Separate from `waiting` because nobody is being asked anything: the run
   *  reaches `joining`, not `paused`, and resumeJoinIfReady advances it. */
  joining?: string
  /** True while this run's wave loop is actually executing in the background - the
   *  re-entrancy guard for continueRun (C6). Set synchronously, before any await, so
   *  two "concurrent" calls can never both observe it false. */
  running: boolean
  /** A step found the fault outside the run's scope; runWave re-provisions and continues from there. */
  widen?: { from: string, target: string, reason: string, added: string[] }
  /** A step sent the run back to an earlier step with an instruction; runWave restarts from there. */
  rework?: { from: string, target: string, instruction: string }
  /** Steps whose `runWhen` condition is waived for one evaluation, because an
   *  operator restarted them by name. Same concession as the extra visit a
   *  restart grants: a predicate guards automatic scheduling, not a person's
   *  explicit decision to run this step. Consumed on first evaluation. */
  conditionOverride?: Set<string>
}
const live = new Map<string, Live>()

/** Workspaces with a start in flight — a run that has been decided on but is
 *  not yet persisted, and so is invisible to findRunInWorkspace. See startRun. */
const starting = new Set<string>()

/** Thrown by startRun when another start already holds the same directory.
 *  A distinct type because each caller answers it differently: the API route
 *  409s like it does for a persisted run, a schedule records a skip, a
 *  dispatched child reports against its own entry. */
export class WorkspaceBusyError extends Error {
  // A plain field, not a constructor parameter property: the node test scripts
  // run this file under type stripping, which cannot generate the assignment a
  // parameter property implies (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  workspace: string
  constructor(workspace: string) {
    super(`a run is already starting in ${workspace}`)
    this.name = 'WorkspaceBusyError'
    this.workspace = workspace
  }
}
const subscribers = new Map<string, Set<(run: WorkflowRun) => void>>()

/** Live-log listeners: one line at a time, per step. */
const logSubscribers = new Map<string, Set<(stepId: string, line: string) => void>>()
export function subscribeLog(runId: string, fn: (stepId: string, line: string) => void): () => void {
  if (!logSubscribers.has(runId)) logSubscribers.set(runId, new Set())
  logSubscribers.get(runId)!.add(fn)
  return () => logSubscribers.get(runId)?.delete(fn)
}
/** The in-memory tail for a run this process ran; otherwise the step .log artifacts, so a finished run reads the same. */
export async function getLiveLog(runId: string): Promise<Record<string, string[]>> {
  const l = live.get(runId)
  if (l) return l.logs
  const run = await getRun(runId)
  if (!run) return {}
  const dir = join(runArtifactsDir(runId), 'steps')
  if (!existsSync(dir)) return {}
  const out: Record<string, string[]> = {}
  for (const name of await readdir(dir)) {
    const m = name.match(/^step-(\d+)-.*\.log$/)
    const step = m ? run.steps[Number(m[1]) - 1] : undefined
    if (!step) continue
    const lines = (await readFile(join(dir, name), 'utf8')).split('\n').filter(Boolean)
    out[step.stepId] = lines.slice(-LOG_TAIL)
  }
  return out
}
const LOG_TAIL = 400
/** One append chain per step log file: see the comment in logLine. */
const logChains = new Map<string, Promise<void>>()

/**
 * Waits for every pending append of this run's step logs, and forgets them.
 *
 * Without this a settled run's log artifact was simply INCOMPLETE: the appends
 * are asynchronous, so a burst reported just before the last step returned was
 * still in flight when the run finished and the artifacts were finalized. A
 * test that reported 40 lines found 21 of them on disk. Nothing errors — the
 * file just ends early, and it is the only copy once the live tail is dropped.
 */
async function flushLogs(runId: string): Promise<void> {
  const prefix = runArtifactsDir(runId)
  const mine = [...logChains.keys()].filter(k => k.startsWith(prefix))
  await Promise.all(mine.map(k => logChains.get(k)?.catch(() => {})))
  for (const k of mine) logChains.delete(k)
}
function logLine(l: Live, run: WorkflowRun, rec: RunStep, line: string) {
  const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`
  const tail = (l.logs[rec.stepId] ??= [])
  tail.push(stamped)
  if (tail.length > LOG_TAIL) tail.splice(0, tail.length - LOG_TAIL)
  const index = String(run.steps.indexOf(rec) + 1).padStart(2, '0')
  const path = join(runArtifactsDir(run.id), 'steps', `step-${index}-${rec.agentSlug}.log`)
  // Chained per file, for the reason publishChains exists below. An unchained
  // `void appendFile` let two lines reported in the same tick land in either
  // order, so the step LOG ARTIFACT — the evidence a reviewer reads after the
  // process is gone — could disagree with the live tail it is supposed to
  // reproduce. Rare by hand, ordinary for an agent emitting a burst of tool
  // lines, and invisible afterwards: the file looks like a normal log.
  logChains.set(path, (logChains.get(path) ?? Promise.resolve())
    .then(() => appendFile(path, stamped + '\n'))
    .catch(() => {}))
  for (const fn of logSubscribers.get(run.id) ?? []) {
    try { fn(rec.stepId, stamped) } catch { /* a broken listener must not stop the run */ }
  }
}

export function subscribe(runId: string, fn: (run: WorkflowRun) => void): () => void {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set())
  subscribers.get(runId)!.add(fn)
  return () => subscribers.get(runId)?.delete(fn)
}

/** Serializes saveRun + subscriber notification per run id. A concurrent wave (C4) can
 *  have several executeNode() calls publish() around the same time; without this a
 *  second writeFile could start before the first has finished, racing on disk. Chaining
 *  them keeps every write for a given run strictly ordered, one at a time. */
const publishChains = new Map<string, Promise<void>>()

function computeUsage(run: WorkflowRun): RunUsage {
  let input = 0, output = 0, cached = 0, usd = 0
  for (const s of run.steps) {
    if (!s.usage) continue
    input += s.usage.input_tokens
    output += s.usage.output_tokens
    cached += s.usage.cache_read_input_tokens ?? 0
    if (typeof s.usage.usd === 'number') { usd += s.usage.usd; continue }
    // No list price known: the tokens still count, the dollars are left out,
    // the same way costReport marks such a step unpriced rather than guessing.
    const p = resolveModelMeta(s.model ?? undefined)?.pricing
    if (p) usd += (s.usage.input_tokens / 1_000_000) * p.input + (s.usage.output_tokens / 1_000_000) * p.output
  }
  return { input_tokens: input, output_tokens: output, cached_tokens: cached, usd: Math.round(usd * 10000) / 10000 }
}

/** A run over its time or token cap, with the reason; null while within budget. */
/** Raises the caps to what is spent plus one default allowance; a person asked for more. */
function extendBudget(run: WorkflowRun): void {
  const spent = computeUsage(run)
  const fresh = defaultBudget()
  const extended = {
    maxMinutes: Math.max(run.budget.maxMinutes, Math.ceil(runElapsedMinutes(run)) + fresh.maxMinutes),
    maxTokens: Math.max(run.budget.maxTokens, spent.input_tokens - (spent.cached_tokens ?? 0) + spent.output_tokens + fresh.maxTokens),
  }
  if (extended.maxTokens !== run.budget.maxTokens || extended.maxMinutes !== run.budget.maxMinutes) {
    log.info('operator extends the run budget', { runId: run.id, from: run.budget, to: extended })
    run.budget = extended
  }
}

/**
 * Adds a product's repositories (by registry key) or one repository (owner/repo)
 * to the run's scope. Returns what was new. Throws when the target is neither,
 * naming the registered keys, so the step's failure says what would have worked.
 */
async function widenProduct(run: WorkflowRun, target: string): Promise<string[]> {
  const entry = await productByKey(target)
  let repos: string[]
  let extra: NonNullable<ProductMatch['alsoInScope']>[number] | undefined
  if (entry) {
    repos = entry.repos
    extra = { name: entry.name, repos: entry.repos, ...(entry.stack ? { stack: entry.stack } : {}), tests: entry.tests }
  } else if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    repos = [target]
  } else {
    throw new Error(`"${target}" is neither a registered product (${(await registeredProductKeys()).join(', ') || 'none registered'}) nor an owner/repo`)
  }
  const current: ProductMatch = run.product ?? { name: target, repos: [], branches: {}, stack: { compose: 'not registered', topology_default: '-' }, tests: {} }
  const added = repos.filter(r => !current.repos.includes(r))
  const alsoInScope = [...(current.alsoInScope ?? [])]
  if (extra && !alsoInScope.some(p => p.name === extra!.name) && extra.name !== current.name) alsoInScope.push(extra)
  run.product = {
    ...current,
    repos: [...current.repos, ...added],
    ...(current.repos.length + added.length > 1 ? { multiRepo: true } : {}),
    ...(alsoInScope.length ? { alsoInScope } : {}),
  }
  return added
}

function budgetExceeded(run: WorkflowRun): string | null {
  const b = run.budget
  // Execution time, not wall clock: a run restarted the morning after it failed
  // has been in existence for hours and working for minutes, and charging it the
  // gap would pause it against its cap the instant it resumed.
  const minutes = runElapsedMinutes(run)
  if (minutes > b.maxMinutes) return `Budget exceeded: ${Math.round(minutes)} min over the ${b.maxMinutes} min cap`
  // Computed here, not read from run.usage: that field is refreshed by publish(),
  // and the wave loop recurses without publishing in between.
  // Cache reads are excluded: they cost a tenth and are what every long-context
  // agent turn is made of, and counting them had an ordinary run hit an 8M cap
  // fifteen minutes in.
  const u = computeUsage(run)
  const tokens = u.input_tokens - (u.cached_tokens ?? 0) + u.output_tokens
  if (tokens > b.maxTokens) return `Budget exceeded: ${tokens.toLocaleString()} uncached tokens over the ${b.maxTokens.toLocaleString()} token cap.`
  return null
}

async function publish(run: WorkflowRun) {
  // The run clock, advanced here for the same reason finalizeRunArtifacts is
  // called here: every status transition in this file passes through publish(),
  // and there are too many terminal branches for per-site bookkeeping to stay
  // correct. Running opens a stretch (idempotently - a wave publishes 'running'
  // many times); anything else closes it, so the time a run spends failed,
  // paused or stopped is never counted as time it worked.
  if (run.status === 'running') startRunClock(run)
  else settleRunClock(run)
  run.usage = computeUsage(run)
  const prior = publishChains.get(run.id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    await saveRun(run)
    // Finalizing here rather than at each terminal branch is deliberate. There
    // are six-plus places a run can reach a terminal status (runWave's three,
    // respondToRun's two, stopRun, failRun) and every one of them must
    // re-assert the runner's own facts over whatever the agents merged into
    // meta.json. A call at each site is a call that gets forgotten when a
    // seventh is added — this file has already produced that defect twice.
    // finalizeRunArtifacts is a read-merge-write, so repeating it is harmless.
    // Placed AFTER saveRun so a failure to write artifacts can never cost us
    // the run record itself.
    //
    // Gated on any step having actually run, not just on the status. A run
    // cancelled while it was QUEUED reaches 'stopped' with every step still
    // pending: finalizeRunArtifacts would succeed and write a meta.json for a
    // run that did nothing, notifyTicketOutcome would comment "run stopped" on
    // the ticket, and notify.ts's webhook would fire - all about work that
    // never started. The same was already true, less visibly, of a real run
    // stopped before its first step completed.
    if (TERMINAL_STATUSES.includes(run.status) && run.steps.some(s => s.status !== 'pending')) {
      try {
        // Before finalizing: the step logs are appended asynchronously, and an
        // artifact that stops mid-burst is the only record left once the live
        // tail is dropped.
        await flushLogs(run.id)
        await finalizeRunArtifacts(run)
        log.debug('run artifacts finalized', { runId: run.id, status: run.status })
        // Evidence stays in the run's artifacts directory, where Agent Manager
        // serves it; nothing is copied into the product tree.
        // Tell the ticket its run finished. Best effort and deliberately last:
        // notifyTicketOutcome is already gated - it posts nothing unless
        // JIRA_POST_ENABLED=1 and credentials resolve - so on an ordinary
        // machine this renders and records the comment without sending it.
        // A notification failure must never change the run's outcome; the work
        // is done either way, and a run reported as failed because Jira was
        // unreachable would be a lie about the code.
        // Unless a Jira step of the workflow already posted it.
        if (run.ticketKey && !run.ticketCommented) {
          try {
            const result = await notifyTicketOutcome(
              { id: run.watch, name: run.workflowName },
              run.ticketKey,
              run,
            )
            log.info('ticket notified', {
              runId: run.id, ticketKey: run.ticketKey,
              posted: result.posted, reason: result.reason ?? '(none)',
            })
          } catch (err) {
            log.error('ticket notification failed; the run itself is unaffected', {
              runId: run.id, ticketKey: run.ticketKey,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } catch (err) {
        // NOT best-effort-and-silent: finalizeRunArtifacts is the only place
        // the runner's own facts (identity/model/cost/fix) are re-asserted
        // over whatever an agent merged into meta.json. A swallowed failure
        // here used to leave the agent's raw, unreconciled self-report in
        // place, looking exactly like trustworthy evidence to the assembler.
        // Logged so the failure is visible, and meta.json is removed so the
        // assembler sees an absent run — required keys missing, loudly
        // rejected — rather than silently assembling from unreconciled data.
        log.error('finalizeRunArtifacts failed', {
          runId: run.id, status: run.status,
          error: err instanceof Error ? err.message : String(err),
        })
        try { await markArtifactsUnusable(run.id) } catch { /* nothing further we can do */ }
      }
    }
    for (const fn of subscribers.get(run.id) ?? []) {
      try { fn(run) } catch { /* a broken subscriber must not stop the run */ }
    }
    onRunTransition(run)
    // A settled run has given its slot back, so whatever is waiting in its
    // group can start. Here rather than in notify.ts, which cannot reach
    // startRun without an import cycle. Not awaited: the drain starts runs of
    // its own, and publish() must not block on them.
    // mightHaveWaiting() first, because a sweep costs a listRuns() - every run
    // record parsed and every owning pid signalled - and the overwhelmingly
    // common case is a run settling with nothing queued behind it anywhere.
    // `joining` is here with the terminal statuses because it gives the slot
    // back just as they do (holdsGroupSlot), and it is the one case where the
    // drain is not merely prompt but REQUIRED: a parent dispatches while it is
    // still `running`, so at a cap of 1 its children are all queued behind it,
    // and the moment it stops holding the slot is this publish. Without the
    // drain here they would wait for a run that is waiting for them.
    if ((TERMINAL_STATUSES.includes(run.status) || run.status === 'joining') && mightHaveWaiting()) {
      void drainRunQueue(launchQueuedRun).catch(err =>
        log.warn('draining the run queue failed', { runId: run.id, error: err instanceof Error ? err.message : String(err) }))
    }
    // A child of a joining parent has reached its outcome, so the parent may
    // now be able to go on. Here rather than in the child's own wave loop
    // because this is the one place every terminal status passes through,
    // including the ones stopRun and failRun publish. Not awaited: the parent's
    // resume runs steps of its own.
    if (TERMINAL_STATUSES.includes(run.status) && run.parentRunId) {
      const parentRunId = run.parentRunId
      void resumeJoinIfReady(parentRunId).catch(err =>
        log.warn('resuming a joining parent failed', { runId: parentRunId, child: run.id, error: err instanceof Error ? err.message : String(err) }))
    }
  })
  publishChains.set(run.id, next)
  await next
}

// `joining` belongs here for the same reason `paused` does: the run has handed
// control away, its wave loop has ended, and a caller waiting on it must not
// block until its children are done - which is a wait measured in whole
// pipelines. It settles again, for real, when resumeJoinIfReady drives it on.
const SETTLED_STATUSES: WorkflowRun['status'][] = ['paused', 'awaiting_review', 'joining', 'completed', 'failed', 'stopped']
const isSettled = (status: WorkflowRun['status']) => SETTLED_STATUSES.includes(status)
/** Statuses stopRun (C5) must never overwrite - the run already reached its real outcome. */
const TERMINAL_STATUSES: WorkflowRun['status'][] = ['completed', 'failed', 'stopped']

/**
 * Resolves once the run reaches a settled status (paused/completed/failed/stopped),
 * built on subscribe() rather than polling the filesystem. Subscribes BEFORE doing
 * anything async, so a run that settles in the gap between "we decided to wait" and
 * "the subscription is registered" can never be missed: publish() calls subscribers
 * synchronously, and the getRun() fallback below only needs to catch the case where
 * the run was ALREADY settled (or settled in that same synchronous tick) before we
 * asked — everything after subscribing arrives through the callback.
 *
 * Exported for tests, and for anything else that needs to await a run's outcome
 * without re-coupling itself to the HTTP request that started it.
 */
export function waitForSettled(runId: string, timeoutMs = 30_000): Promise<WorkflowRun> {
  return new Promise<WorkflowRun>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      fn()
    }
    const unsubscribe = subscribe(runId, (run) => {
      if (isSettled(run.status)) finish(() => resolve(run))
    })
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`waitForSettled: run ${runId} did not settle within ${timeoutMs}ms`)))
    }, timeoutMs)
    // Covers "already settled (or settled in the same tick) before/while we subscribed" —
    // everything settling afterward arrives through the subscription above.
    getRun(runId)
      .then((run) => { if (run && isSettled(run.status)) finish(() => resolve(run)) })
      .catch(() => { /* the subscription is still live; a transient read failure here is not fatal */ })
  })
}

/** Marks a run failed and persists it. Used when the background loop itself throws —
 *  never on a step-level failure, which executeNode/runWave already handle and record. */
async function failRun(run: WorkflowRun, err: unknown): Promise<void> {
  run.status = 'failed'
  run.error = err instanceof Error ? err.message : 'Unknown error'
  run.endedAt = Date.now()
  run.currentStepIds = []
  run.nextStepIds = []
  log.error('run loop threw; marking run failed', { runId: run.id, error: run.error })
  await publish(run)
}

/**
 * Runs the wave loop to settlement without ever rejecting. This is what makes it safe
 * to fire-and-forget: an unhandled rejection here would reach the Nitro process' global
 * handler and can take the whole server down, killing every other in-flight run. Any
 * throw — from the loop itself, or from publish() while recording the failure — is
 * swallowed after a best-effort attempt to mark the run failed on disk.
 */
async function driveToSettlement(l: Live, run: WorkflowRun): Promise<void> {
  try {
    await runWave(l, run)
  } catch (err) {
    // Safety net, not the primary mechanism: runWave clears l.running itself, right
    // before each of its own terminal publishes (see C6 notes there). This only
    // matters for the rare case where runWave threw before ever reaching one of
    // those - e.g. a bug in readyNodes/computeInput - which would otherwise leave
    // the guard stuck true. A failed run's status is no longer 'paused' regardless,
    // so clearing it late here can never wrongly swallow a legitimate call.
    l.running = false
    try {
      await failRun(run, err)
    } catch {
      /* persisting the failure itself failed; there is nothing further we can safely do
       * without risking another unhandled rejection. */
    }
  }
}

const stepOf = (l: Live, id: string) => l.workflow.steps.find(s => s.id === id)
const recOf = (run: WorkflowRun, id: string) => run.steps.find(s => s.stepId === id) as RunStep

/** Total characters of upstream output a single step's input may carry.
 *  Sized so a seven-step Runbook A run stays well inside a 200k-token
 *  context after the agent's own system prompt and skills. */
const MAX_JOINED_CONTEXT = 60000

/**
 * Joins upstream outputs under a fixed total budget, shared EVENLY across
 * parts rather than first-come. Even sharing is the point: with a first-come
 * budget a verbose early step could consume the whole allowance and push the
 * pre-fix FAIL output out entirely — silently reintroducing the exact defect
 * `contextMode: 'ancestors'` exists to fix. Truncation is always marked.
 *
 * Used only by `contextMode: 'ancestors'` — that mode's fan-in is unbounded
 * by the graph (it can pull in the entire upstream chain), so it is the one
 * that needs a cap. The default predecessor-join path has always passed
 * upstream output through whole via bare `joinInputs`, and must keep doing
 * so: capping it would silently change every existing workflow whose step
 * legitimately emits a full diff or log dump.
 */
function joinBudgeted(parts: { label: string, text: string }[]): string {
  if (!parts.length) return ''
  const share = Math.floor(MAX_JOINED_CONTEXT / parts.length)
  const clipped = parts.map((p) => {
    if (p.text.length <= share) return p
    const dropped = p.text.length - share
    return { label: p.label, text: `${p.text.slice(0, share)}\n\n[truncated ${dropped} characters]` }
  })
  return joinInputs(clipped)
}

/**
 * The SDK session a step can continue, or undefined.
 *
 * Requires the recorded session AND its transcript still on disk under the
 * same working directory: a run whose worktree was made (or removed) since
 * has a different project folder, and the CLI would find nothing to resume.
 * Undefined means "start fresh", which is always correct, only more expensive.
 */
function resumableSession(rec: RunStep): string | undefined {
  if (!rec.sessionId || !rec.sessionProject) return undefined
  const transcript = join(getClaudeDir(), 'projects', rec.sessionProject, `${rec.sessionId}.jsonl`)
  return existsSync(transcript) ? rec.sessionId : undefined
}

function computeInput(l: Live, run: WorkflowRun, id: string, initialPrompt: string): string {
  const feedback = l.retryFeedback[id]
  if (feedback) {
    delete l.retryFeedback[id]
    // A resumed visit continues the session that already holds the brief and
    // the attempt, so re-sending both would pay for them twice and invite the
    // model to start over. The instruction alone is the whole input.
    if (l.resumeFrom[id]) return feedback
    return [
      l.lastInputs[id] ?? initialPrompt, '---', 'Your previous attempt:',
      l.outputs[id] ?? '', '---', 'Reviewer feedback:', feedback,
      'Revise your work and produce a corrected result.',
    ].join('\n\n')
  }
  const trigger = l.state.triggeredBy[id]
  if (trigger) return l.outputs[trigger] ?? ''
  const step = stepOf(l, id)
  const useAncestors = step?.contextMode === 'ancestors'
  // ancestorsOf returns nearest-first; reverse so the join reads
  // oldest-to-newest, the order a person reads a pipeline in.
  const preds = useAncestors
    ? ancestorsOf(l.graph, id).reverse()
    : (l.graph.forwardPreds[id] ?? [])
  if (!preds.length) return initialPrompt
  const parts = preds.map(p => ({ label: recOf(run, p).label, text: l.outputs[p] ?? '' }))
  // The budget is 'ancestors'-only: that mode is the one whose fan-in is
  // unbounded by the graph. The default path has always passed upstream
  // output through whole, and a step legitimately emitting a large diff or
  // log dump must keep doing so.
  return useAncestors ? joinBudgeted(parts) : joinInputs(parts)
}

/** The one place that tells apart a plain-string test stub's result from
 *  the real caller's { output, model, usage } shape. A stub that doesn't
 *  report a model or usage yields them `undefined` here — never guessed. */
function normalizeAgentResult(
  r: AgentCallOutput,
): { output: string, model?: string | null, usage?: AgentUsage | null } {
  return typeof r === 'string' ? { output: r } : r
}

/**
 * Runs the monitor agent in its own try/catch, isolated from the main agent call's.
 * A broken monitor must not take the workflow down with it (C1): it defaults to
 * CONTINUE with a note (matching the client engine this was ported from), rather than
 * propagating into executeNode's catch and overwriting an already-successful step.
 */
async function runMonitor(
  step: { monitorSlug?: string, agentSlug: string, label: string },
  rec: RunStep,
  input: string,
  output: string,
  projectDir: string | undefined,
  artifactsDir: string,
): Promise<{ verdict: 'CONTINUE' | 'RETRY' | 'ABORT', review: string }> {
  if (!step.monitorSlug) return { verdict: 'CONTINUE', review: '' }
  try {
    const raw = await agentCaller(
      step.monitorSlug,
      monitorPrompt({ label: step.label, agentSlug: step.agentSlug, input, output, artifactsDir }),
      projectDir,
    )
    const { output: review } = normalizeAgentResult(raw)
    const verdict = parseVerdict(review)
    Object.assign(rec, { monitorVerdict: verdict, monitorNote: review })
    // CONTINUE is the expected, silent-majority outcome; RETRY/ABORT are the
    // noteworthy ones — a monitor sending a step back, or killing the run,
    // is exactly the kind of decision a reviewer reconstructing a run needs
    // to see without re-running anything.
    const log_ = verdict === 'CONTINUE' ? log.debug : log.warn
    log_('monitor verdict', () => ({
      stepId: rec.stepId, monitorSlug: step.monitorSlug, verdict, reviewPreview: preview(review),
    }))
    return { verdict, review }
  } catch (err) {
    const monitorNote = `Monitor failed: ${err instanceof Error ? err.message : 'unknown error'}`
    Object.assign(rec, { monitorVerdict: 'CONTINUE', monitorNote })
    log.warn('monitor call failed; defaulting to CONTINUE', {
      stepId: rec.stepId, monitorSlug: step.monitorSlug,
      error: err instanceof Error ? err.message : String(err),
    })
    return { verdict: 'CONTINUE', review: monitorNote }
  }
}

/**
 * The plugin's test lock denies test edits once source has been edited, unless
 * `.agent/test-unlock.json` exists in the checkout; a person is meant to write
 * it with a reason. A step declared `testsUnlocked` owns both its tests and its
 * code by design, so the runner writes that file for it and the reason rides
 * with the run. Never staged: nothing under .agent/ but plan.md is.
 */
async function unlockTests(run: WorkflowRun, label: string): Promise<void> {
  const dir = join(run.projectDir!, '.agent')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'test-unlock.json'), JSON.stringify({ reason: `The "${label}" step of ${run.workflowName} writes tests and code together by design.`, run: run.id, step: label, at: new Date().toISOString() }, null, 2))
  } catch (err) {
    log.warn('could not write the test unlock; the plugin lock will stop the step at its first test edit', { runId: run.id, dir, error: err instanceof Error ? err.message : String(err) })
  }
}

/** A step that needs the operator: `PIPELINE-ASK: <question>` on its own line. */
export function parseAsk(output: string): string | null {
  const m = output.match(/^PIPELINE-ASK:\s*(.+)$/m)
  return m ? m[1]!.trim() : null
}

async function executeNode(l: Live, run: WorkflowRun, id: string, override?: string): Promise<boolean> {
  const step = stepOf(l, id)
  const rec = recOf(run, id)
  if (!step || !rec) return false

  // The header is prepended exactly once here, never inside computeInput: that
  // function's retry-feedback branch rebuilds its input from l.lastInputs[id],
  // so headering there would compound the header once per retry visit. Storing
  // lastInputs WITHOUT the header keeps that branch's reconstruction clean; rec
  // and the agent call both use `input`, so the run's own record matches
  // exactly what the agent saw.
  let body = override ?? computeInput(l, run, id, run.initialPrompt)
  // A note the operator sent while the run was in flight, or attached to an
  // approval: delivered once, with this step's input, as a correction from a person.
  const note = l.notes[id] ?? l.nextNote
  if (note) {
    body += `\n\n---\nOperator note from ${run.startedBy ?? 'the operator'}, sent while the run was in flight: ${note}`
    delete l.notes[id]
    if (l.nextNote === note) l.nextNote = undefined
  }
  l.lastInputs[id] = body
  // The provisioner may have cloned since the last step: the branch is made
  // the moment a checkout exists, so no step ever commits on main or develop,
  // and the header below names it.
  await ensureRunCheckout(run)
  if (step.testsUnlocked && run.projectDir) await unlockTests(run, step.label)
  // A visit that continues the previous session needs no header: that session
  // already has it, and re-sending it invites the model to start over.
  const resume = l.resumeFrom[id]
  delete l.resumeFrom[id]
  const input = resume ? body : artifactHeader(runArtifactsDir(run.id), run.product, run.startedBy, run.id, run.projectDir ? {
    dir: run.projectDir, branch: run.branch,
    ...(run.branch && run.baseBranch ? { policy: describeBranchChoice(run.branch, baseBranchFor(run.workType, run.origin, run.product?.branches)) } : {}),
  } : undefined, run.parameters) + body

  // Logged, not only handed to the agent: "why was there no browser trace" was
  // a question that could previously only be answered by reading an agent's
  // output, and the answer was missing from it.
  if (step.agentSlug === 'sdlc-trace-capture') {
    const surface = browserSurface(runWorkspace(run))
    log.info('browser surface for the trace step', {
      runId: run.id,
      playwright: surface.playwright,
      uiFilesSeen: surface.uiFiles.length,
      expectation: surface.playwright ? 'a trace is expected' : 'TRACE: n/a is the expected outcome',
    })
  }
  markRunning(l.state, id)
  Object.assign(rec, {
    status: 'running', input, output: '', error: undefined, model: undefined, usage: undefined,
    completedAt: undefined, monitorVerdict: undefined, monitorNote: undefined,
    startedAt: Date.now(), visits: l.state.visits[id],
    // Which session this visit continues, when it continues one: the step
    // artifact then says a visit carried on rather than started over.
    resumedFrom: resume,
    // Progress telemetry is per-visit, not cumulative across retries — a
    // fresh visit's turn count must not start from a previous attempt's.
    assistantMessages: undefined, lastTool: undefined, lastActivityAt: undefined,
  })
  log.debug('step starting', () => ({
    runId: run.id, stepId: id, agentSlug: step.agentSlug, visits: rec.visits,
    inputLength: input.length, inputPreview: preview(body),
  }))
  // currentStepIds is NOT touched here. For a wave, it already holds every node in the
  // wave (set once by runWave before any of them start) - see the C4 note there for why
  // narrowing it to this one node would corrupt that during concurrent execution. For a
  // single-step respondToRun call it already holds [id] from the prior pause.
  await publish(run)

  // A Jira step is the runner's own work: no model, no prompt, a REST call or
  // two, and an honest sentence about each. It settles like any other step so
  // the graph, the artifacts and the run page treat it the same.
  if (step.jira) {
    logLine(l, run, rec, `step started, visit ${rec.visits}`)
    let output: string
    try {
      output = await runJiraStep(run, step.jira)
    } catch (err) {
      output = `Jira step failed: ${err instanceof Error ? err.message : String(err)}. The ticket was not changed; the run goes on.`
    }
    for (const line of output.split('\n')) logLine(l, run, rec, line)
    const skip = parseSkip(output)
    l.outputs[id] = output
    Object.assign(rec, {
      status: skip ? 'skipped' : 'completed', output, model: null, usage: null, completedAt: Date.now(),
      ...(skip ? { skipReason: skip } : {}),
    })
    log.info('jira step done', () => ({ runId: run.id, stepId: id, output: preview(output) }))
    markCompleted(l.graph, l.state, id)
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return true
  }

  // A dispatch step is the runner's own work too: no model, no prompt, one
  // child run started per entry in an artifact. It settles like the Jira step
  // above and for the same reasons - the graph, the artifacts and the run page
  // treat it as an ordinary step.
  if (step.triggerWorkflow) {
    logLine(l, run, rec, `step started, visit ${rec.visits}`)
    const { output, failed, joining } = await runDispatchStep(l, run, rec, step.triggerWorkflow)
    for (const line of output.split('\n')) logLine(l, run, rec, line)
    l.outputs[id] = output
    if (failed) {
      // Unlike a Jira failure, this one fails the step. A Jira step that could
      // not move a ticket has still had the code work done around it; a
      // dispatch that started nothing has produced NOTHING, and completing it
      // would report a scan that quietly dispatched none of its findings.
      markFailed(l.state, id)
      Object.assign(rec, { status: 'failed', error: output, model: null, usage: null, completedAt: Date.now() })
      log.warn('dispatch step failed', { runId: run.id, stepId: id, error: output })
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return false
    }
    if (joining) {
      // Deliberately NOT completed, and no completedAt: this step's job is not
      // over until its children are, and marking it done here would arm the
      // very steps that exist to summarise them. `waiting` is the step status
      // that already means "stopped, and something else has to happen first".
      Object.assign(rec, { status: 'waiting', output, model: null, usage: null })
      l.joining = id
      log.info('dispatch step joining', () => ({ runId: run.id, stepId: id, children: rec.childRunIds?.length ?? 0 }))
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return true
    }
    Object.assign(rec, { status: 'completed', output, model: null, usage: null, completedAt: Date.now() })
    log.info('dispatch step done', () => ({ runId: run.id, stepId: id, children: rec.childRunIds?.length ?? 0 }))
    markCompleted(l.graph, l.state, id)
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return true
  }

  // A notify step is the runner's own work too: no model, no prompt, one POST
  // to a channel this instance configures. It settles like the Jira step above
  // - a delivery failure is a sentence, never a failed step - because the run's
  // own state is what a reviewer acts on and the message is the convenience on
  // top of it. See runNotifyStep for the full argument.
  if (step.notify) {
    logLine(l, run, rec, `step started, visit ${rec.visits}`)
    const output = await runNotifyStep(run, step.notify, step.runWhen?.artifact)
    for (const line of output.split('\n')) logLine(l, run, rec, line)
    l.outputs[id] = output
    Object.assign(rec, { status: 'completed', output, model: null, usage: null, completedAt: Date.now() })
    log.info('notify step done', () => ({ runId: run.id, stepId: id, channel: step.notify?.channel }))
    markCompleted(l.graph, l.state, id)
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return true
  }

  const ac = new AbortController()
  l.aborts.set(id, ac)
  try {
    const userEnv = await envResolver(run.startedBy).catch(() => ({}))
    logLine(l, run, rec, `step started, visit ${rec.visits}`)
    const raw = await agentCaller(step.agentSlug, input, run.projectDir, { signal: ac.signal, env: userEnv, ...(resume ? { resume } : {}), onSteer: (deliver) => { l.steer.set(id, deliver) }, onSession: (sessionId, cwd) => {
      // The transcript is a normal Claude Code session, so it is readable on /cli;
      // named after the run so it is findable there among the developer's own.
      // Claude Code names the transcript folder by replacing every non-alphanumeric
      // character of the working directory with '-' (verified against ~/.claude/projects).
      Object.assign(rec, { sessionId, sessionProject: cwd.replace(/[^A-Za-z0-9]/g, '-') })
      void publish(run)
      // Loaded on demand: that module's extension-less imports do not resolve under the plain-node tests.
      void import('./claudeCodeHistory.ts').then(m => m.setSessionName(sessionId, `${run.ticketKey ?? run.workflowSlug} · ${step.label} · run ${run.id.slice(0, 8)}`)).catch(() => {})
    }, onProgress: (progress: AgentProgress) => {
      if (progress.line) { logLine(l, run, rec, progress.line); return }
      // Diagnostic only (see AgentProgress's doc comment) - mutated directly
      // onto the live rec and republished so the SSE stream carries it, but
      // never written to the step's persisted artifact JSON and never
      // touched by runnerOwned()'s facts.
      Object.assign(rec, {
        assistantMessages: progress.turn, lastTool: progress.lastTool, lastActivityAt: progress.lastActivityAt,
      })
      void publish(run)
    } })
    const { output, model, usage } = normalizeAgentResult(raw)
    const durationMs = Date.now() - (rec.startedAt ?? Date.now())

    // A halt is a failure the agent raised deliberately. Checked before the
    // monitor and before the output is published downstream: a step that says
    // it could not proceed has produced no result worth propagating, and
    // running a monitor over a halt would only invite it to vote CONTINUE.
    // usage is recorded even on a halt: the call actually happened and spent
    // real tokens, unlike the catch(err) branch below where no result — and
    // so no usage — ever came back at all.
    const halt = parseHalt(output)
    if (halt) {
      markFailed(l.state, id)
      Object.assign(rec, {
        status: 'failed', output, model, usage, error: `Step halted: ${halt}`, completedAt: Date.now(),
      })
      log.warn('step halted', () => ({
        runId: run.id, stepId: id, agentSlug: step.agentSlug, reason: preview(halt), durationMs,
      }))
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return false
    }

    // A question stops the step where it is: the run pauses on the operator,
    // and the answer re-runs the step with its own output and the reply.
    // The fault lives in another product's code: bring it in and carry on there,
    // rather than halting (a dead run) or asking (a person told what a registry
    // already knows). A real run halted on a selfcare ticket whose 500 came from
    // the CRM, with the CRM repository one registry lookup away.
    const widen = parseWiden(output)
    if (widen) {
      let added: string[]
      try {
        added = await widenProduct(run, widen.target)
      } catch (err) {
        markFailed(l.state, id)
        Object.assign(rec, { status: 'failed', output, model, usage, error: `Step asked to widen the run and could not: ${err instanceof Error ? err.message : String(err)}`, completedAt: Date.now() })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      }
      l.outputs[id] = output
      Object.assign(rec, { status: 'completed', output, model, usage, completedAt: Date.now() })
      l.widen = { from: id, target: widen.target, reason: widen.reason, added }
      logLine(l, run, rec, `widened the run to ${widen.target}: ${added.length ? added.join(', ') + ' added' : 'already in scope'}`)
      log.info('step widened the run', () => ({ runId: run.id, stepId: id, target: widen.target, added, reason: preview(widen.reason) }))
      markCompleted(l.graph, l.state, id)
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return true
    }

    // An earlier step's output is what stops this one, and it is fixable: send
    // the run back there with the instruction, rather than halting the run. A
    // real security review halted a run over an error body that leaked a
    // message, with the implementer one restart away.
    const rework = parseRework(output)
    if (rework) {
      const want = rework.target.trim().toLowerCase()
      const others = run.steps.filter(s => s.stepId !== id)
      // The documented form is the step's LABEL, and an exact match on label or
      // slug is tried first so a step named exactly is never resolved by the
      // looser rule below.
      const exact = others.filter(s => s.label.toLowerCase() === want || s.agentSlug.toLowerCase() === want)
      // Agents decorate the name. A real fix-implementer wrote "step-04
      // sdlc-test-author" - the right step, carrying its own step number - and
      // the exact match rejected it, killing a run 70.3 minutes and $7.96 in
      // with every earlier step already green. Substring rather than equality,
      // but accepted ONLY when it names exactly one step: an ambiguous target
      // must still fail loudly rather than send the run somewhere arbitrary.
      const named = exact.length ? exact : others.filter(s =>
        want.includes(s.agentSlug.toLowerCase()) || want.includes(s.label.toLowerCase()))
      const target = named.length === 1 ? named[0] : undefined
      if (!target) {
        markFailed(l.state, id)
        // Both label AND slug, because the rejected string is usually a slug
        // while the old message listed only labels - telling the agent nothing
        // it could use to correct itself.
        const known = others.map(s => `${s.label} (${s.agentSlug})`).join(', ')
        const why = named.length > 1
          ? `matches more than one step of this run (${named.map(s => s.label).join(', ')})`
          : `is not a step of this run`
        Object.assign(rec, { status: 'failed', output, model, usage, error: `Step asked to send the run back to "${rework.target}", which ${why}. Name one of: ${known}`, completedAt: Date.now() })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      }
      l.outputs[id] = output
      Object.assign(rec, { status: 'completed', output, model, usage, completedAt: Date.now() })
      l.rework = { from: id, target: target.stepId, instruction: rework.instruction }
      logLine(l, run, rec, `sent the run back to ${target.label}: ${rework.instruction}`)
      log.info('step sent the run back', () => ({ runId: run.id, stepId: id, target: target.stepId, instruction: preview(rework.instruction) }))
      markCompleted(l.graph, l.state, id)
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return true
    }

    const ask = parseAsk(output)
    if (ask) {
      l.outputs[id] = output
      Object.assign(rec, { status: 'waiting', output, model, usage })
      run.question = { stepId: id, text: ask, kind: 'question', askedAt: Date.now() }
      l.waiting = id
      log.info('step asked the operator', () => ({ runId: run.id, stepId: id, agentSlug: step.agentSlug, question: preview(ask) }))
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return true
    }

    // A skip is a SUCCESS, not a failure: the step examined its job, found
    // nothing to do, and said so. It schedules exactly like a completed step
    // - the output is published downstream and markCompleted runs at the end
    // of this path - and the monitor below still reviews it, which is what
    // stops a skip being used to dodge real work. Only the recorded status
    // differs, so the evidence bundle can distinguish "nothing was needed"
    // from "it was fixed". See parseSkip for why this outcome exists.
    const skip = parseSkip(output)
    l.outputs[id] = output
    Object.assign(rec, {
      status: skip ? 'skipped' : 'completed',
      output, model, usage, completedAt: Date.now(),
      ...(skip ? { skipReason: skip } : {}),
    })
    log.info(skip ? 'step skipped itself' : 'step completed', () => ({
      runId: run.id, stepId: id, agentSlug: step.agentSlug, model,
      ...(skip ? { skipReason: preview(skip) } : {}),
      outputLength: output.length, durationMs,
      inputTokens: usage?.input_tokens ?? '(none reported)', outputTokens: usage?.output_tokens ?? '(none reported)',
    }))

    if (step.monitorSlug) {
      const { verdict, review } = await runMonitor(step, rec, input, output, run.projectDir, runArtifactsDir(run.id))
      if (verdict === 'ABORT') {
        markFailed(l.state, id)
        Object.assign(rec, { status: 'failed', model, error: 'Monitor aborted the workflow' })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      }
      if (verdict === 'RETRY' && canRevisit(l.graph, l.state, id)) {
        // Record the attempt before wiping it: this exact output and
        // monitorNote are about to be overwritten in-memory by the retry
        // that's coming (rec is reused across visits, and the eventual
        // final writeStepArtifact call shares this same step's filename).
        // Without a snapshot here, a reviewer sees cost.attempts > 1 and
        // only the LAST attempt's file — the deficient output and the
        // monitor's note that triggered the retry are simply gone.
        try {
          await writeStepArtifact(run, rec, run.steps.indexOf(rec), `retry-${rec.visits}`)
        } catch { /* best effort */ }
        l.retryFeedback[id] = review
        l.state.status[id] = 'completed'
        armNode(l.state, id)
        return true
      }
    }

    markCompleted(l.graph, l.state, id)
    // Progress clears the interruption count: only CONSECUTIVE restarts with
    // nothing achieved in between are the loop worth pausing on.
    run.interruptions = 0
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return true
  } catch (err) {
    // A step that ran out of either budget - turns or wall-clock - has usually
    // done most of its work, and its log tail says how far it got. One retry
    // that starts from there is cheaper than a dead run: the budget becomes a
    // checkpoint, not a wall. A real verifier died one turn after its tests
    // passed, with nothing reported.
    if (err instanceof AgentResultError && (err.subtype === 'error_max_turns' || err.subtype === 'error_max_duration') && !l.stopped && canRevisit(l.graph, l.state, id)) {
      const tail = (l.logs[id] ?? []).slice(-25).join('\n')
      Object.assign(rec, { status: 'failed', error: err.message, completedAt: Date.now(), ...(err.usage ? { usage: err.usage } : {}) })
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec), `retry-${rec.visits}`) } catch { /* best effort */ }
      l.outputs[id] = tail
      // Continue the session where it can be continued: a step that ran out of
      // budget has the whole exploration in its context already, and starting
      // over is how one step spent three visits re-reading the same files and
      // never wrote its plan.
      const session = resumableSession(rec)
      if (session) l.resumeFrom[id] = session
      // Names the budget that actually ran out: a timeout told "you ran out of
      // turns" would send the agent off optimising the wrong thing.
      const spent = err.subtype === 'error_max_duration' ? 'time budget' : 'turn budget'
      l.retryFeedback[id] = session
        ? `You ran out of your ${spent} before reporting. You still have everything you read. Do not re-explore: finish from where you are, in as few commands as possible, and end with the report.`
        : `Your previous attempt ran out of its ${spent} before it reported. Its last actions are above, most recent last; they usually include the command that finally worked. Do not repeat the exploration: start from what they found, finish in as few commands as possible, and end with the report.`
      l.state.status[id] = 'completed'
      armNode(l.state, id)
      log.warn('step ran out of its budget; retrying from its log tail', { runId: run.id, stepId: id, agentSlug: step.agentSlug, subtype: err.subtype, visits: rec.visits })
      return true
    }
    markFailed(l.state, id)
    // A failed step still spent tokens. Recording them is what keeps the run's
    // cost honest and makes an expensive failure visible in the cost report
    // rather than showing as free.
    const failedUsage = err instanceof AgentResultError ? err.usage : null
    // The MODEL as well as the usage. Recording tokens without the model that
    // burned them made the cost report price a failed opus step at sonnet
    // rates: one error_max_turns step showed $10.07 against a true $50.35, a
    // $40 understatement in the direction that never prompts anyone to look.
    // The declared model is the honest fallback when the call died before the
    // SDK reported the one it actually resolved.
    const failedModel = await declaredModelOf(step.agentSlug)
    Object.assign(rec, {
      status: 'failed',
      error: l.stopped ? 'Stopped by operator' : (err instanceof Error ? err.message : 'Unknown error'),
      completedAt: Date.now(),
      ...(failedUsage ? { usage: failedUsage } : {}),
      ...(rec.model ? {} : failedModel ? { model: failedModel } : {}),
    })
    log.error('step call threw', {
      runId: run.id, stepId: id, agentSlug: step.agentSlug,
      error: err instanceof Error ? err.message : String(err),
    })
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return false
  } finally {
    l.aborts.delete(id)
    l.steer.delete(id)
  }
}

/**
 * A step in `wave` failed: nothing pending will run, and the run is over.
 * Shared by the post-wave failure path and by an unevaluable step condition,
 * so both settle the record identically.
 */
async function failRunAfterWave(l: Live, run: WorkflowRun, wave: string[]): Promise<WorkflowRun> {
  skipPending(l.state)
  for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
  run.status = 'failed'
  // The run's OWN reason, carried up from the step that supplied it. Without
  // this the record read `error: (none)` on every step failure: a real
  // provisioner burned 47.4 minutes on error_max_turns, and the step record
  // and the container log both said so while the run itself said nothing.
  // The most expensive failures were the ones that explained themselves
  // least, which is exactly backwards. Joined rather than first-only because
  // a parallel wave can fail in more than one place at once.
  run.error = run.steps
    .filter(s => s.status === 'failed' && s.error)
    .map(s => `${s.label}: ${s.error}`)
    .join(' · ')
    || 'A step failed without recording a reason'
  run.endedAt = Date.now()
  run.currentStepIds = []
  run.nextStepIds = []
  l.running = false
  log.warn('run failed', { runId: run.id, workflowSlug: run.workflowSlug, failedInWave: wave })
  await publish(run)
  return run
}

/**
 * Settle every armed step whose `runWhen` condition is not met, before the wave
 * is chosen.
 *
 * Conditional routing exists because a fan-out here is unconditional: a Decision
 * Gate that writes an empty `escalated-drafts.json` still armed the step that
 * consumes it, which then ran with nothing to do - and, when that step carried
 * `approval`, asked a person to approve doing nothing.
 *
 * Gating on the artifact the step will actually consume, rather than on a routing
 * token the producing agent emits, is deliberate: an agent that announces a branch
 * while writing an empty file reproduces the original bug exactly. The file is the
 * fact; the announcement is a claim.
 *
 * Returns `failed: true` when a condition could not be evaluated - the artifact
 * exists but is not JSON, or names a path outside the run's directory. The step
 * is marked failed and the caller fails the run through its normal path.
 */
async function resolveConditions(l: Live, run: WorkflowRun): Promise<{ failed: boolean, settled: boolean }> {
  let settled = false
  // A pass can arm further conditional steps, so this repeats; bounded by the
  // node count because a resolution loop that cannot converge must not hang.
  for (let pass = 0; pass <= l.graph.nodes.length; pass++) {
    let settledThisPass = false
    // The FULL ready set, not the MAX_CONCURRENCY slice: a step that is about to
    // be skipped must not occupy one of the three slots a real step could use.
    for (const id of readyNodes(l.graph, l.state)) {
      const step = stepOf(l, id)
      const artifact = step?.runWhen?.artifact
      if (!artifact) continue
      // runWhen gates a FORWARD arming only. Each of these arrives by another
      // route, where re-testing the artifact would swallow a decision already made:
      // a back edge feeds the step its trigger's output rather than the artifact
      // (see computeInput); a monitor RETRY is the monitor's feedback, not a new
      // branch; an approval is a person having already said yes; an override is a
      // person having restarted this step by name.
      if (l.state.triggeredBy[id]) continue
      if (l.retryFeedback[id]) continue
      if (l.approved.has(id)) continue
      if (l.conditionOverride?.delete(id)) continue

      const rec = recOf(run, id)
      if (!rec) continue

      const path = resolveRunArtifact(run.id, artifact)
      const result = path === null
        ? { verdict: 'error' as const, detail: 'names a path outside the run\'s artifacts directory' }
        : gateSatisfied(await readFile(path, 'utf8').catch(() => null))

      if (result.verdict === 'run') continue

      settled = true
      settledThisPass = true

      if (result.verdict === 'error') {
        const error = `Step condition could not be evaluated: ${artifact} ${result.detail}.`
        markFailed(l.state, id)
        Object.assign(rec, { status: 'failed', error, completedAt: Date.now() })
        logLine(l, run, rec, error)
        log.warn('step condition unevaluable', { runId: run.id, stepId: id, artifact, detail: result.detail })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        await publish(run)
        return { failed: true, settled }
      }

      // Published downstream as a sentence, not left empty: computeInput reads
      // l.outputs for the join's input, and an unset entry is indistinguishable
      // from a step that ran and produced nothing. The join must be able to
      // report that its branches were empty.
      const output = `Skipped: ${artifact} ${result.detail}. This step consumes that file, so it had nothing to do and was not run.`
      l.outputs[id] = output
      // markRunning is deliberately NOT called: no visit, no totalRuns. Nothing
      // was attempted and no tokens were spent, and the evidence bundle's
      // cost.attempts is the observed max visits - counting a skip there would
      // report an attempt that never happened.
      Object.assign(rec, {
        status: 'skipped', skipReason: `${artifact} ${result.detail}`, output,
        model: null, usage: null, startedAt: Date.now(), completedAt: Date.now(),
      })
      logLine(l, run, rec, output)
      // 'was not written' is the case worth a warning: an empty file is a gate
      // reporting no work, a missing one may be a gate that forgot.
      const missing = result.detail === 'was not written'
      const level = missing ? log.warn : log.info
      level('step skipped by condition', { runId: run.id, stepId: id, artifact, detail: result.detail })
      markSkippedByCondition(l.graph, l.state, id)
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    }
    if (!settledThisPass) break
  }
  if (settled) await publish(run)
  return { failed: false, settled }
}

/** How many workflows may dispatch one another before the chain is refused.
 *  The graph model's own cycle guards (maxVisits, MAX_TOTAL_RUNS) are per-run
 *  and cannot see A dispatching B dispatching A; only the parentRunId chain
 *  can, and only if something checks its length. */
const MAX_DISPATCH_DEPTH = 3

/** The workflows this run descends from, nearest first, starting with its own.
 *  Bounded independently of MAX_DISPATCH_DEPTH so a chain that somehow got
 *  longer than the cap still terminates here rather than walking forever. */
async function dispatchAncestry(run: WorkflowRun): Promise<string[]> {
  const slugs = [run.workflowSlug]
  let cursor = run.parentRunId
  for (let hop = 0; cursor && hop < 32; hop++) {
    const parent = await getRun(cursor)
    if (!parent) break
    slugs.push(parent.workflowSlug)
    cursor = parent.parentRunId
  }
  return slugs
}

/** One path segment, from a key that came out of an artifact a person wrote.
 *  Rejecting is not an option here - every entry must get a workspace - so
 *  this rewrites, and the result is only ever a directory name. */
export const workspaceSegment = (key: string) =>
  key.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'entry'

/**
 * The child's opening prompt: the entry it was dispatched for.
 *
 * Deliberately NOT the parent's joined predecessor context. A single-child
 * trigger could hand that over cheaply, but a fan-out would copy one join -
 * budgeted at 60k characters - into every child, so a ten-ticket scan would
 * open ten runs each carrying the other nine tickets' findings. The entry is
 * what this child is actually for; the parent run id below is how a reader
 * gets back to the rest.
 */
function childPrompt(target: DispatchTarget, parentRunId: string): string {
  const pick = (...names: string[]) =>
    names.map(n => target.entry[n]).find(v => typeof v === 'string' && v.trim()) as string | undefined
  const summary = pick('summary', 'title')
  const description = pick('description', 'body', 'detail')
  const head = summary ? `${target.key}: ${summary}` : target.key
  return [
    head,
    description ?? '',
    '---',
    `Dispatched from run ${parentRunId}. The entry this run was started for:`,
    '```json',
    JSON.stringify(target.entry, null, 2),
    '```',
  ].filter(Boolean).join('\n\n')
}

/** One entry a dispatch step will turn into a child run. */
interface DispatchItem {
  /** The entry this came from - a ticket key, or its position. Names the child's workspace. */
  key: string
  slug: string
  initialPrompt: string
  /** The child's own checkout, distinct per child: see the dispatch branch. */
  projectDir: string
  startedBy?: string
  parentRunId: string
  ticketKey?: string
  /** The child's own declared inputs, already resolved against the parent's values. */
  parameters?: Record<string, string>
}

/** Starts one child run, or records it as waiting for a slot in its group. */
async function startChild(item: DispatchItem): Promise<{ run: WorkflowRun, queued: boolean }> {
  const wf = await loadWorkflowSteps(item.slug)
  if (!wf) throw new Error(`there is no workflow "${item.slug}" on this instance`)
  if (!wf.steps.length) throw new Error(`workflow "${item.slug}" has no steps`)
  return startOrQueue({
    workflow: { slug: wf.slug, name: wf.name, group: wf.group, notifyChannel: wf.notifyChannel, steps: wf.steps },
    initialPrompt: item.initialPrompt,
    // An honest third answer to "what triggered this?", carrying the run that
    // did. `watch` is a free string in the evidence bundle schema - only
    // 'direct-invocation' is reserved - so a new literal validates.
    watch: `workflow-trigger:${item.parentRunId}`,
    ticketKey: item.ticketKey,
    autoRun: true,
    projectDir: item.projectDir,
    // Resolved now and frozen on the run: a workflow re-saved with a new
    // required parameter between queueing and launch must not turn a queued
    // child into a failure the operator cannot see the cause of. Its STEPS are
    // re-read at launch; what it was given is not. See launchQueuedRun.
    parameters: item.parameters,
    startedBy: item.startedBy,
    parentRunId: item.parentRunId,
  })
}

/**
 * Runs one `triggerWorkflow` step: reads the artifact it dispatches over,
 * routes each entry to a workflow, and starts a child run per entry up to the
 * concurrency cap, queueing the rest.
 *
 * Never throws - like the Jira step, every problem becomes a sentence. It does
 * report `failed`, though, where the Jira step does not: a dispatch that
 * started nothing has produced nothing at all, and completing it would record
 * a scan that silently dispatched none of its findings.
 *
 * The children are not waited for. Each is a top-level run with its own
 * budget, its own evidence and its own workspace; this step's job is over once
 * they exist.
 */
async function runDispatchStep(
  l: Live, run: WorkflowRun, rec: RunStep, cfg: TriggerWorkflowConfig,
): Promise<{ output: string, failed: boolean, joining?: boolean }> {
  const fail = (why: string) => ({ output: why, failed: true })

  // Exactly one source, checked before anything is read. Both is a step nobody
  // can act on and guessing which was meant would dispatch over the wrong list;
  // neither is a step that could never have dispatched anything.
  if (!!cfg.source === !!cfg.fromParameter) {
    return fail(cfg.source
      ? 'Dispatch failed: this step names both an artifact and a run parameter to dispatch over, and it can have one.'
      : 'Dispatch failed: this step names nothing to dispatch over: give it an artifact or a run parameter.')
  }
  // Reads as the subject of every sentence below, exactly as the artifact name
  // did when that was the only source there was.
  const label = cfg.fromParameter ? `parameter "${cfg.fromParameter}"` : cfg.source as string

  let plan
  if (cfg.fromParameter) {
    // The run's own frozen parameters, never anything an agent wrote: the list
    // a fan-out spends the machine on is a person's stated input.
    plan = planListDispatch(run.parameters?.[cfg.fromParameter], cfg)
  } else {
    const path = resolveRunArtifact(run.id, cfg.source as string)
    if (path === null) {
      return fail(`Dispatch failed: ${label} names a path outside the run's artifacts directory.`)
    }
    plan = planDispatch(await readFile(path, 'utf8').catch(() => null), cfg)
  }
  if (plan.error) return fail(`Dispatch failed: ${label} ${plan.error}.`)
  if (!plan.targets.length) {
    // Nothing to dispatch is a real outcome, not a failure: the step ran, read
    // the source, and there was no work in it.
    return { output: `Dispatched nothing: ${label} ${plan.detail}.`, failed: false }
  }

  // Recursion, checked before anything starts. A workflow that dispatches one
  // it already descends from would run forever, and each generation would be a
  // fresh run with a fresh budget - nothing else in this file can see it.
  const ancestry = await dispatchAncestry(run)
  if (ancestry.length > MAX_DISPATCH_DEPTH) {
    return fail(`Dispatch failed: this run is already ${ancestry.length} workflows deep`
      + ` (${ancestry.join(' ← ')}), at the limit of ${MAX_DISPATCH_DEPTH}.`)
  }
  const looping = plan.targets.find(t => ancestry.includes(t.slug))
  if (looping) {
    return fail(`Dispatch failed: ${looping.key} routes to "${looping.slug}", which this run already descends from`
      + ` (${ancestry.join(' ← ')}). That would dispatch itself forever.`)
  }

  // Every target workflow is checked before any child starts, so a typo in one
  // route cannot leave half a batch in flight and half of it dropped. The
  // definitions are kept, not discarded: a child's own `parameters` decide
  // which of this run's stated inputs it inherits.
  const targets = new Map<string, { steps: any[], parameters?: WorkflowParameter[] }>()
  for (const slug of [...new Set(plan.targets.map(t => t.slug))]) {
    const wf = await loadWorkflowSteps(slug)
    if (!wf) return fail(`Dispatch failed: there is no workflow "${slug}" on this instance, so nothing was dispatched.`)
    if (!wf.steps.length) return fail(`Dispatch failed: workflow "${slug}" has no steps, so nothing was dispatched.`)
    // Checked here, with the other all-or-nothing target checks, because the
    // failure is silent otherwise: resolveParameters drops a value the child
    // does not declare, so the run would start N children that each scanned
    // whatever their checkout happened to contain.
    if (cfg.itemParameter && !wf.parameters?.some(p => p.name === cfg.itemParameter)) {
      return fail(`Dispatch failed: workflow "${slug}" declares no "${cfg.itemParameter}" input,`
        + ` so a child could not tell which item it was started for. Nothing was dispatched.`)
    }
    targets.set(slug, wf)
  }

  // Each child gets its own checkout. runWorkspace() honours an explicit
  // projectDir, so the run lock - which exists because two runs editing one
  // checkout corrupt each other - becomes correct for these children without
  // being changed at all. Sharing the parent's directory would hand N
  // concurrent pipelines one working tree, which is precisely the hazard.
  const root = workspaceRootFor(run.startedBy)
  const items: DispatchItem[] = []
  // A child that declares a required input this run cannot supply is reported
  // against its OWN entry, exactly as an unstartable one is, rather than
  // failing the batch: nineteen fix pipelines must not be lost because the
  // twentieth routes to a workflow asking for something nobody stated.
  const unsatisfiable: { key: string, slug: string, missing: string[] }[] = []
  // Only what the CHILD declares crosses over; resolveParameters drops the
  // rest, which is what makes handing a whole parent map to a child safe at
  // all. projectDir never crosses: each child works in its own directory,
  // decided below, and inheriting the parent's would put N pipelines in one
  // working tree - the very hazard the line above avoids.
  const { [RESERVED_PARAM_PROJECT_DIR]: _parentDir, ...inheritable } = run.parameters ?? {}
  for (const t of plan.targets) {
    // The item itself, under the name this step gave it. Per child rather than
    // in `inheritable` above because it is the one value that differs between
    // them, and merged BEFORE resolveParameters so it is subject to the same
    // rule as every other value: only what the child declares crosses over.
    const supplied = cfg.itemParameter ? { ...inheritable, [cfg.itemParameter]: t.key } : inheritable
    const child = resolveParameters(targets.get(t.slug)?.parameters, supplied)
    if (child.missing.length) {
      unsatisfiable.push({ key: t.key, slug: t.slug, missing: child.missing })
      continue
    }
    items.push({
      key: t.key,
      slug: t.slug,
      initialPrompt: childPrompt(t, run.id),
      projectDir: join(root, workspaceSegment(t.key)),
      startedBy: run.startedBy,
      parentRunId: run.id,
      ticketKey: /^[A-Z][A-Z0-9]+-\d+$/.test(t.key) ? t.key : undefined,
      ...(Object.keys(child.values).length ? { parameters: child.values } : {}),
    })
  }

  // One at a time, in order: the admission gate is serialised anyway, and
  // sequential calls are what makes the queue's order match the entries'.
  // A child that cannot be started is reported against its OWN entry and does
  // not stop the others - one unstartable ticket must not strand the batch.
  const lines = [`${label} ${plan.detail}.`]
  const childRunIds: string[] = []
  // What a join reports on, and the only durable record of which item each
  // child was started for: the keys live in this loop and nowhere else, so a
  // parent resumed after a restart would otherwise have run ids and no names.
  const children: { id: string, run: string, slug: string }[] = []
  let queuedCount = 0
  const stuck: string[] = []
  for (const item of items) {
    try {
      const { run: child, queued } = await startChild(item)
      // Both started and queued children are recorded. A queued child used to
      // be untraceable from its parent until it started; now the link exists
      // from the moment it is admitted, which is the whole point of a waiting
      // run being a real run.
      childRunIds.push(child.id)
      children.push({ id: item.key, run: child.id, slug: item.slug })
      if (queued) {
        queuedCount++
        // Deliberately no position: it is stale the instant anything else
        // queues, and this line is written once into an artifact. /runs
        // computes the live position instead.
        lines.push(`Queued ${item.key} for ${item.slug} (run ${child.id}, waiting for a slot in ${groupOf(child)}).`)
      } else {
        lines.push(`Dispatched ${item.key} to ${item.slug} (run ${child.id}).`)
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      stuck.push(item.key)
      lines.push(`Could not dispatch ${item.key} to ${item.slug}: ${why}.`)
    }
  }
  rec.childRunIds = childRunIds

  for (const u of unsatisfiable) {
    lines.push(`Could not dispatch ${u.key} to ${u.slug}: it needs ${u.missing.join(', ')}, which this run was not given.`)
  }
  // Produced no child at all - started or queued - so the step produced
  // nothing and must say so as a failure. An entry whose child asked for an
  // input nobody stated counts here too.
  if (!childRunIds.length) {
    return fail(`Dispatch failed: nothing could be started.\n${lines.join('\n')}`)
  }
  log.info('dispatched child runs', {
    runId: run.id, started: childRunIds.length - queuedCount, queued: queuedCount,
    failed: stuck.length, unsatisfiable: unsatisfiable.length,
  })

  if (!cfg.join) return { output: lines.join('\n'), failed: false }

  // Written now rather than on resume, so the item names survive a restart
  // between here and the last child settling. resumeJoinIfReady rewrites it
  // with each child's outcome, which is what a downstream notify or runWhen
  // then reads.
  try {
    await writeArtifactJson(run.id, JOIN_ARTIFACT, children)
  } catch (err) {
    // The children are already running. Refusing to join now would abandon
    // them and lose the rollup as well, so say so and join without the file.
    lines.push(`Could not write ${JOIN_ARTIFACT}: ${err instanceof Error ? err.message : String(err)}.`)
  }
  lines.push(`Waiting for ${childRunIds.length} ${childRunIds.length === 1 ? 'child' : 'children'} to finish.`)
  return { output: lines.join('\n'), failed: false, joining: true }
}

/**
 * The artifact a join writes its children into, and what a downstream notify
 * step or `runWhen` gate reads to say what the fan-out actually did.
 *
 * A fixed name rather than a configured one. The step that writes it and the
 * steps that read it are in the same graph, and every other artifact in this
 * pipeline is named twice - once by its producer, once by its consumer - which
 * is one of the two places a fan-out can be misconfigured into silence.
 */
const JOIN_ARTIFACT = 'children.json'

/**
 * Serialises resume attempts for one parent, so the last two children settling
 * in the same tick cannot both drive its wave loop.
 *
 * publishChains does this for one run's writes; this is the same check-then-act
 * across runs. The status re-read inside the chain is what makes it correct:
 * the second attempt sees the `running` the first one published and stops.
 */
const joinChains = new Map<string, Promise<unknown>>()

/**
 * Advances a `joining` parent when every child it dispatched has settled.
 *
 * Called from publish() for each child reaching a terminal status, so it runs
 * once per child and does nothing for all but the last. A child that merely
 * PAUSED is not settled and the parent goes on waiting - the honest answer,
 * because the work being joined is not finished, and the parent's own page
 * links the child that is asking for something.
 *
 * Every exit is a return, never a throw: this runs detached from the child's
 * publish, and a parent that cannot be resumed must leave the child's own
 * outcome recorded exactly as it was.
 */
async function resumeJoinIfReady(parentRunId: string): Promise<void> {
  const previous = joinChains.get(parentRunId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    const parent = await getRun(parentRunId)
    // Not joining any more: resumed already by the sibling that settled a
    // moment before this one, or stopped by an operator in between.
    if (!parent || parent.status !== 'joining') return
    const rec = parent.steps.find(s => s.status === 'waiting' && s.childRunIds?.length)
    if (!rec?.childRunIds?.length) return

    const children = await Promise.all(rec.childRunIds.map(childId => getRun(childId)))
    // A child whose record was deleted will never publish again. Counting it as
    // unsettled would leave the parent joining for the life of the instance,
    // so a missing child is one that has stopped mattering.
    const present = children.filter((c): c is WorkflowRun => !!c)
    if (!childrenSettled(present.map(c => c.status))) return

    // The item names come from the artifact, not from memory: this may be a
    // different process from the one that dispatched them.
    const named = new Map<string, string>()
    const stored = await readArtifactEntries(parent.id, JOIN_ARTIFACT)
    for (const e of (stored && 'entries' in stored) ? stored.entries : []) {
      if (typeof e.run === 'string' && typeof e.id === 'string') named.set(e.run, e.id)
    }
    const summary = present.map((c) => {
      // A run that failed in a wave records nothing on itself - the reason is on
      // the step that failed, see failRunAfterWave - so read it from wherever it
      // actually is. Without this a rollup can say a repo failed but not why,
      // which is the one thing whoever reads it needs.
      const why = c.error ?? c.steps.find(s => s.status === 'failed')?.error
      return {
        id: named.get(c.id) ?? c.id,
        run: c.id,
        slug: c.workflowSlug,
        status: c.status,
        ...(why ? { error: why } : {}),
      }
    })
    try {
      await writeArtifactJson(parent.id, JOIN_ARTIFACT, summary)
    } catch (err) {
      // The rollup step will read an older file or none at all, which is worth
      // a sentence in the step's output rather than stranding the parent.
      log.warn('could not write the join artifact', { runId: parent.id, error: err instanceof Error ? err.message : String(err) })
    }

    const unfinished = summary.filter(c => c.status !== 'completed')
    const lines = [
      `${summary.length} ${summary.length === 1 ? 'child' : 'children'} finished`
        + `${unfinished.length ? `, ${unfinished.length} not completed` : ''}.`,
      ...summary.map(c => `${c.id}: ${c.status} (run ${c.run}).`),
    ]
    const output = [rec.output, ...lines].filter(Boolean).join('\n')

    // Written onto the record BEFORE rehydrate, so a parent rebuilt from disk
    // marks the step completed itself and arms what follows. When the live
    // record survived, its graph state still has the step running, so the
    // marking is done by hand below - exactly once, either way.
    const hadLive = live.has(parent.id)
    Object.assign(rec, { status: 'completed', output, completedAt: Date.now() })

    let l: Live
    try {
      l = await rehydrate(parent)
    } catch (err) {
      // The workflow file is gone or no longer aligns, so there is nothing to
      // resume into. Failing the parent is the honest outcome: its children
      // ran, and their runs hold their own evidence.
      log.warn('a joining parent could not be rebuilt', { runId: parent.id, error: err instanceof Error ? err.message : String(err) })
      await failRun(parent, err)
      return
    }
    if (l.running) return
    l.running = true
    l.joining = undefined
    l.outputs[rec.stepId] = output
    if (hadLive) markCompleted(l.graph, l.state, rec.stepId)
    try { await writeStepArtifact(parent, rec, parent.steps.indexOf(rec)) } catch { /* best effort */ }

    parent.status = 'running'
    parent.pid = process.pid
    parent.bootId = BOOT_ID
    log.info('joining parent resumed', {
      runId: parent.id, stepId: rec.stepId, children: summary.length, unfinished: unfinished.length,
    })
    await publish(parent)
    void driveToSettlement(l, parent)
  })
  joinChains.set(parentRunId, next)
  await next
}

async function runWave(l: Live, run: WorkflowRun): Promise<WorkflowRun> {
  if (l.stopped) { l.running = false; return run }

  // Checked between waves: a single step is bounded by its own maxTurns, and
  // the cap stops the next wave from starting rather than killing one mid-flight.
  // A run with no step left to start is not over budget, it is finished: a real
  // run delivered its pull request and was then marked failed by this check.
  const anythingLeft = run.steps.some(s => s.status === 'pending' || s.status === 'running')
  const over = anythingLeft ? budgetExceeded(run) : null
  if (over) {
    // The cap is a checkpoint, not a verdict: the run pauses and asks. Continuing
    // grants another allowance (see continueRun); nobody has to find an env var
    // to get a run whose PR is already open through its follow-up step.
    const fresh = defaultBudget()
    const next = run.steps.find(s => s.status === 'pending')
    run.status = 'paused'
    run.question = {
      stepId: next?.stepId ?? '', kind: 'approval', reason: 'budget', askedAt: Date.now(),
      text: `${over} Continue to grant another ${fresh.maxTokens.toLocaleString()} tokens and ${fresh.maxMinutes} minutes, or stop the run here.`,
    }
    run.currentStepIds = []
    run.nextStepIds = next ? [next.stepId] : []
    l.running = false
    log.warn('run paused on budget', { runId: run.id, over })
    await publish(run)
    return run
  }

  // Ordering here is load-bearing, in three directions. AFTER the budget check,
  // so a wave of skips is never mistaken for progress against the cap. BEFORE
  // the stuck detector below, which counts steps whose record still reads
  // 'pending' - resolve after it and a workflow ending in a conditional step
  // reports "No step can run" instead of completing. BEFORE the approval gate,
  // which is the point of the feature: nobody is asked to approve a step whose
  // input is empty.
  const conditions = await resolveConditions(l, run)
  if (conditions.failed) return failRunAfterWave(l, run, run.currentStepIds)

  const wave = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  if (!wave.length && l.waiting) {
    // Nothing can run because a step is waiting on the operator: that is a
    // pause with a question, never a stuck run.
    run.status = 'paused'
    run.currentStepIds = [l.waiting]
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }
  if (!wave.length) {
    // Nothing can run but steps remain: that is a stuck run, never a finished one.
    const stuck = run.steps.filter(s => s.status === 'pending')
    if (stuck.length) {
      for (const s of stuck) s.status = 'skipped'
      run.status = 'failed'
      run.error = `No step can run: ${stuck.map(s => s.label).join(', ')} pending but not schedulable (visit limit reached or a predecessor did not complete). Restart the step you want to run.`
      run.endedAt = Date.now()
      run.currentStepIds = []
      run.nextStepIds = []
      l.running = false
      log.warn('run stuck', { runId: run.id, pending: stuck.map(s => s.stepId) })
      await publish(run)
      return run
    }
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    log.info('run completed', { runId: run.id, workflowSlug: run.workflowSlug })
    await publish(run)
    return run
  }

  // A step marked for approval waits for a person before it starts, run-to-completion or not.
  const gate = wave.find(id => stepOf(l, id)?.approval && !l.approved.has(id))
  if (gate) {
    const step = stepOf(l, gate)
    const label = step?.label ?? gate
    // A gated step that consumes an artifact asks a different question. "Approve
    // this step" acts on every entry in that file, and a step downstream of it
    // may start one child run per entry - so the honest question is which
    // entries to act on, and the run says so with its own status. Read off the
    // step's own runWhen rather than from anything workflow-specific: the shape
    // (approval + a file to consume) is the whole condition, exactly as
    // resolveConditions gates on the file rather than on an announcement.
    const artifact = step?.runWhen?.artifact
    run.question = {
      stepId: gate, kind: 'approval', askedAt: Date.now(),
      text: artifact
        ? `Decide which entries of ${artifact} to act on before "${label}" runs`
        : `Approve "${label}" to run it`,
      ...(artifact ? { artifact } : {}),
    }
    run.status = artifact ? 'awaiting_review' : 'paused'
    run.currentStepIds = []
    run.nextStepIds = wave
    l.running = false
    log.info('run waits for a person', { runId: run.id, stepId: gate, artifact })
    await publish(run)
    return run
  }

  run.status = 'running'
  // currentStepIds is the whole wave, set once before anything in it runs. executeNode
  // deliberately never reassigns it (C4) - if it did, concurrent execution would leave
  // it reflecting only whichever node happened to reach that line last, not the wave.
  run.currentStepIds = wave
  run.nextStepIds = []
  log.debug('wave starting', { runId: run.id, stepIds: wave })
  await publish(run)

  // Genuine concurrency (C4), each executeNode call publish()es independently as it
  // progresses (mirroring the client engine's parallel step execution). publish() (above)
  // serializes those writes per run id so they can never race on disk.
  const results = await Promise.all(wave.map(id => executeNode(l, run, id)))

  // A stop during the wave published 'stopped' from stopRun's own copy of the
  // record. This object is the one the wave mutated and the one executeNode
  // publishes, so it must carry the same facts or its next publish would
  // resurrect 'running' on disk.
  if (l.stopped) {
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
    run.status = 'stopped'
    run.endedAt ??= Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

  if (results.some(ok => !ok)) {
    return failRunAfterWave(l, run, wave)
  }

  // A step is waiting on the operator: nothing else starts until they answer.
  if (l.widen) {
    // Re-provision with the wider scope and continue from there: the same reset
    // an operator's restart performs, with the reason handed to the first
    // re-run step as a note. restartRun rebuilds the live state from disk, so
    // the record is published first and this loop ends here.
    const w = l.widen
    l.widen = undefined
    const provisioner = l.workflow.steps.find(s => s.agentSlug === 'sdlc-stack-provisioner')?.id ?? w.from
    // Status stays 'running': a 'paused' publish would read as settled to anyone waiting.
    run.currentStepIds = []
    run.nextStepIds = [provisioner]
    l.running = false
    await publish(run)
    const note = `The run was widened to ${w.target} by "${stepOf(l, w.from)?.label ?? w.from}": ${w.reason}. Repositories now in scope: ${run.product?.repos.join(', ')}. Check out what is missing, stand up what the fault needs, and continue there.`
    log.info('run widened; re-provisioning', { runId: run.id, target: w.target, from: w.from, restartAt: provisioner })
    return restartRun(run.id, provisioner, note, run.startedBy, { fromRunner: true })
  }

  if (l.rework) {
    // Bounded: two steps disagreeing forever is a failure to report, not a loop to run.
    const w = l.rework
    l.rework = undefined
    run.reworks = (run.reworks ?? 0) + 1
    const from = stepOf(l, w.from)?.label ?? w.from
    if (run.reworks > 2) {
      for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
      run.status = 'failed'
      run.error = `Sent back ${run.reworks} times and still not accepted; the last instruction from "${from}": ${w.instruction}`
      run.endedAt = Date.now()
      run.currentStepIds = []
      run.nextStepIds = []
      l.running = false
      log.warn('run reworked too often', { runId: run.id, reworks: run.reworks, from: w.from, target: w.target })
      await publish(run)
      return run
    }
    run.currentStepIds = []
    run.nextStepIds = [w.target]
    l.running = false
    await publish(run)
    log.info('run sent back; restarting', { runId: run.id, from: w.from, target: w.target, reworks: run.reworks })
    return restartRun(run.id, w.target, `Sent back by "${from}" (rework ${run.reworks} of 2): ${w.instruction}`, run.startedBy, { fromRunner: true })
  }

  if (l.waiting) {
    run.status = 'paused'
    run.currentStepIds = [l.waiting]
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

  // Waiting for child runs rather than for a person: the same shape as the
  // branch above with a different status and nothing in the attention queue.
  // Checked after it, not before, because a question addressed to somebody
  // outranks waiting on machines. resumeJoinIfReady takes the run from here
  // when the last child settles.
  if (l.joining) {
    run.status = 'joining'
    run.currentStepIds = [l.joining]
    run.nextStepIds = []
    l.running = false
    await publish(run)
    // Both ends of the race, because either can win. A child settling looks for
    // a parent that is already `joining`; children quick enough to finish
    // before this publish - a small fan-out is routinely quicker than the
    // parent's own bookkeeping - have all looked and found it still `running`,
    // and nothing would ever wake it. resumeJoinIfReady is serialised per
    // parent and re-reads the status, so whichever side arrives second does
    // nothing.
    void resumeJoinIfReady(run.id).catch(err =>
      log.warn('resuming a joining parent failed', { runId: run.id, error: err instanceof Error ? err.message : String(err) }))
    return run
  }

  if (isFinished(l.graph, l.state)) {
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

  // Deliberately NOT filtered by runWhen: this is display, resolving a condition
  // means reading files, and a step listed here that settles as skipped the
  // moment the run continues is informative rather than wrong.
  run.nextStepIds = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  if (run.autoRun && !l.stopped) return runWave(l, run)

  // C6: cleared BEFORE this publish, not after driveToSettlement's whole promise chain
  // settles. waitForSettled's subscriber fires from inside publish() below, ahead of
  // this function's own return - a caller chained off that (the normal "continue,
  // await settlement, continue again" flow) must see the guard already clear, or a
  // perfectly legitimate next continueRun call gets silently swallowed.
  run.status = 'paused'
  l.running = false
  await publish(run)
  return run
}

/**
 * The run's own branch, off whatever the checkout has at HEAD, created as
 * soon as there is a checkout to make it in. Runner-owned so no agent ever
 * commits to develop directly again; a real run cloned onto main and would
 * have pushed it. Idempotent: a run that already has its branch is left alone.
 */
/** Intake's classification from meta.json, once it has written one. */
async function readClassification(run: WorkflowRun): Promise<{ work_type?: string, origin?: string } | null> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    return meta && typeof meta === 'object' ? { work_type: meta.work_type, origin: meta.origin } : null
  } catch { return null }
}

// Wave siblings start together and each asks for the checkout; git takes one
// index lock at a time, and the second `worktree add` used to fail into the
// silent fallback. One creation per run at a time, the others await it.
const checkoutInFlight = new Map<string, Promise<void>>()
function ensureRunCheckout(run: WorkflowRun): Promise<void> {
  const pending = checkoutInFlight.get(run.id)
  if (pending) return pending
  const p = ensureRunCheckoutOnce(run).finally(() => checkoutInFlight.delete(run.id))
  checkoutInFlight.set(run.id, p)
  return p
}

async function ensureRunCheckoutOnce(run: WorkflowRun): Promise<void> {
  // A run that has its worktree is left alone. One whose worktree is gone (a
  // developer ran `git worktree remove` after the PR merged, then restarted
  // the run) gets it back from the clone: without this, agentCaller fell back
  // to the Claude config directory as cwd and every step ran in the wrong
  // place while the header still named the deleted path.
  if (run.branch && run.projectDir && existsSync(join(run.projectDir, '.git'))) return
  const repoName = run.product?.repos?.[0]?.split('/').pop()
  const recordedClone = run.branch && run.projectDir ? run.projectDir.replace(/@[^/]+$/, '') : undefined
  const checkout = (recordedClone && existsSync(join(recordedClone, '.git'))) ? recordedClone
    : (run.projectDir && existsSync(join(run.projectDir, '.git'))) ? run.projectDir
      : findCheckout(runWorkspace(run), repoName)
  if (!checkout) return
  // The base branch follows the kind of work, which intake classifies into
  // meta.json. Until it has, no step touches the code, so the branch waits:
  // a branch cut before the classification would start from the clone's
  // default branch, which is main for most products and wrong for a task.
  const classified = await readClassification(run)
  const intake = run.steps.find(s => s.agentSlug === 'sdlc-ticket-intake')
  const intakeSettled = !intake || !['pending', 'running', 'waiting'].includes(intake.status)
  if (!run.branch && !classified?.work_type && !intakeSettled) return
  const choice = baseBranchFor(classified?.work_type, classified?.origin, run.product?.branches)
  const branch = run.branch ?? `fix/${run.ticketKey ?? 'run'}-${run.id.slice(0, 8)}`
  const base = run.branch ? run.baseBranch : choice.base
  let worktrees: string[]
  try {
    worktrees = await ensureRunBranch(checkout, branch, base)
  } catch (err) {
    // Loudly, never quietly. The old fallback let the run go on in the clone,
    // on whatever branch the developer had left it, with a header that still
    // promised a worktree; a stale worktree on another branch is the one way
    // to get here, and only a person can decide what to do with it.
    throw new Error(`could not create the run worktree for ${branch} beside ${checkout}: ${err instanceof Error ? err.message : String(err)}. Resolve it (git worktree list / git worktree remove) and restart the run from its first step.`)
  }
  run.branch = branch
  // The run's own worktree, beside the clone: every step from here works
  // there, and the clone stays on whatever branch the developer left it on.
  run.projectDir = worktrees[0] ?? checkout
  run.workType = run.workType ?? classified?.work_type
  run.origin = run.origin ?? classified?.origin
  run.baseBranch = base
  // The branch starts at the base now, so the fix facts diff against it.
  run.baseCommit = (await captureBaseline(run.projectDir)) ?? run.baseCommit
  await saveRun(run)
  log.info('run worktree ready', { runId: run.id, checkout, worktree: run.projectDir, branch, base, reason: choice.reason, repos: worktrees.length })
}

/**
 * Creates and persists the run, then kicks the wave loop off in the background and
 * returns immediately — the run is owned by the server, not by this HTTP request.
 * Awaiting this only awaits the run's creation (a fast filesystem write), never the
 * workflow's execution: for autoRun that could be many agent calls and minutes, and
 * even a single manual wave is a call the caller should not have to hold a connection
 * open for. Callers that need the outcome use waitForSettled(run.id), the way the SSE
 * stream and this module's own tests do.
 */
export async function startRun(opts: StartRunOpts): Promise<WorkflowRun> {
  const resolved = await resolveStart(opts)
  return beginRun(opts.workflow, resolved, baseCommit =>
    createRun({ ...newRunInput(opts, resolved), status: 'running', baseCommit }))
}

/** What a start decides before it is known whether the run begins now or waits
 *  for a slot. Both paths need every field: a queued run without a resolved
 *  `projectDir` has no workspace for the next fire to dedupe against. */
interface ResolvedStart {
  product?: ProductMatch
  projectDir?: string
  ticketKey?: string
  workspace: string
}

async function resolveStart(opts: StartRunOpts): Promise<ResolvedStart> {
  // A run with nowhere to write evidence fails here, in one line, rather than
  // an agent step later after it has spent its budget finding out.
  const artifacts = await artifactsWritable()
  if (!artifacts.ok) throw new Error(`Run artifacts directory ${artifacts.path} is not writable by this process (${artifacts.error}); set AGENT_RUNS_DIR to a writable path`)
  // Resolved once, before any agent runs, and carried on the run: agents are
  // handed registry facts rather than asked to guess which product this is.
  // Named by the caller (a smoke sweep knows which product it is testing), else
  // resolved from the prompt's ticket key, labels and component words.
  const product = opts.productKey
    ? await productByKey(opts.productKey)
    : await resolveProduct(opts.initialPrompt).catch(() => undefined)
  if (opts.productKey && !product) throw new Error(`Unknown product "${opts.productKey}"; registered: ${(await registeredProductKeys()).join(', ')}`)
  // The checkout a product-routed run works in, when it is already on this
  // instance: then the baseline, the dirty-tree facts and the run branch all
  // apply, instead of an agent committing wherever it happens to be.
  const firstRepo = product?.repos?.[0]
  const projectDir = opts.projectDir ?? (firstRepo && existsSync(checkoutDirFor(firstRepo, opts.startedBy)) ? checkoutDirFor(firstRepo, opts.startedBy) : undefined)
  const ticketKey = opts.ticketKey ?? opts.initialPrompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1]
  return { product, projectDir, ticketKey, workspace: runWorkspace({ projectDir, startedBy: opts.startedBy }) }
}

/** The run record's fields, shared by the start-now and queue-it paths so the
 *  two cannot drift in what they state about the same run. */
function newRunInput(opts: StartRunOpts, resolved: ResolvedStart) {
  return {
    product: resolved.product,
    startedBy: opts.startedBy,
    workflowSlug: opts.workflow.slug,
    workflowName: opts.workflow.name,
    // Snapshotted here rather than looked up later: see WorkflowRun.group.
    group: opts.workflow.group,
    // Snapshotted here for the same reason `group` is: see WorkflowRun.notifyChannel.
    notifyChannel: opts.workflow.notifyChannel,
    autoRun: opts.autoRun,
    initialPrompt: opts.initialPrompt,
    watch: opts.watch,
    ticketKey: resolved.ticketKey,
    projectDir: resolved.projectDir,
    parameters: opts.parameters,
    parentRunId: opts.parentRunId,
    steps: opts.workflow.steps.map(s => ({ stepId: s.id, label: s.label, agentSlug: s.agentSlug })),
  }
}

/**
 * Takes the workspace, captures the baseline, brings the run record into
 * existence (or takes over one that was waiting), and drives it.
 *
 * One copy of this, shared by a start and a queue launch, because everything in
 * it is about the moment execution actually begins — which for a queued run is
 * hours after it was admitted. `make` is the only difference between the two:
 * createRun for a fresh run, or flipping a queued record to `running`.
 */
async function beginRun(
  workflow: WorkflowLike,
  resolved: ResolvedStart,
  make: (baseCommit?: string) => Promise<WorkflowRun>,
): Promise<WorkflowRun> {
  // Reserved synchronously, before the first await below, and held until the
  // run record exists.
  //
  // Every caller checks findRunInWorkspace first, but that check reads
  // PERSISTED runs, and this function takes hundreds of milliseconds to
  // persist one: captureBaseline alone spawns two git processes, and
  // artifactsWritable probes the filesystem. Two starts aimed at one
  // directory inside that window both saw an idle workspace and both
  // proceeded - two runs editing one checkout, which is the exact corruption
  // the lock exists to prevent. Now that a schedule can name its own
  // directory, two schedules sharing one on the same cron minute is an
  // ordinary configuration rather than a mistimed accident.
  //
  // Process-local, like the lock it closes the window on: a second server
  // process on the same config directory is the same non-guarantee
  // findRunInWorkspace has always had, and the same one schedules.json and
  // watches.json live with.
  const { workspace } = resolved
  if (starting.has(workspace)) throw new WorkspaceBusyError(workspace)
  starting.add(workspace)

  // The directory a run is TOLD it works in has to exist before any agent is
  // called: callAgent silently falls back to the Claude config directory for
  // one that does not (see canonicalProjectDir), so the run would edit this
  // instance's own configuration while its header named somewhere else. A
  // derived workspace has never existed on a schedule's first fire, which is
  // every schedule exactly once. Best-effort: a run that cannot create its
  // directory still fails honestly further down.
  try { await mkdir(workspace, { recursive: true }) } catch { /* startRun's own error path reports it */ }

  let run: WorkflowRun
  try {
    // Captured HERE, at the moment execution begins — before any step, and so
    // any agent, has had a chance to touch the directory. See gitFacts.ts's
    // captureBaseline and shared/types/run.ts's WorkflowRun.baseCommit for why
    // this can never fall back to a guess: an absent baseline means
    // computeFixFacts later reports nothing, rather than diffing against a
    // branch's shared base and attributing that branch's whole history to this
    // run. For a queued run this is also why it cannot be captured at
    // admission: a baseline from four hours ago names a HEAD that has moved.
    const baseCommit = await captureBaseline(resolved.projectDir)
    run = await make(baseCommit)
  } finally {
    // Released once the run is persisted (or failed to be): from here on
    // findRunInWorkspace can see it, so the reservation has done its job.
    starting.delete(workspace)
  }
  await ensureRunCheckout(run)
  // Before the gate below, not after: a run that fails preflight is precisely
  // the one whose reason has to be readable afterwards, and the artifacts
  // directory is where the run page and the assembler look for it.
  try { await initRunArtifacts(run, workflow.name) } catch { /* absence is the signal */ }

  // Everything an agent should never discover by spending its budget: the
  // compose file, the checkout, git as the agents will see it, docker, the
  // Jira statuses this workflow will ask for. Four real runs died on four
  // such things, each after twenty to sixty minutes of paid model work.
  run.preflight = await preflight(run, workflow.steps)
  const blocked = preflightFailure(run.preflight)
  if (blocked) {
    run.status = 'failed'
    run.error = `Preflight: ${blocked}`
    run.endedAt = Date.now()
    for (const s of run.steps) s.status = 'skipped'
    run.currentStepIds = []
    run.nextStepIds = []
    await saveRun(run)
    log.warn('run failed preflight; no agent ran', { runId: run.id, reason: blocked })
    return run
  }

  const graph = buildGraph(workflow.steps)
  const l: Live = {
    workflow, graph, state: initRunState(graph),
    outputs: {}, lastInputs: {}, retryFeedback: {}, resumeFrom: {}, stopped: false, running: false, aborts: new Map(), logs: {}, approved: new Set(), notes: {}, steer: new Map(),
  }
  live.set(run.id, l)
  void driveToSettlement(l, run)
  return run
}

/**
 * Records a run that will wait for a slot in its group, and returns without
 * starting it.
 *
 * Everything `beginRun` does is deliberately NOT done here: no workspace
 * reservation (it holds no checkout while it waits), no baseline (the HEAD it
 * would name is going to move), no live entry and no wave loop. Only the
 * artifacts directory is created, because that costs a mkdir and one small
 * file and makes a queued run uniform for the artifacts routes and for
 * finalizeRunArtifacts.
 */
export async function enqueueRun(opts: StartRunOpts): Promise<WorkflowRun> {
  const resolved = await resolveStart(opts)
  const run = await createRun({ ...newRunInput(opts, resolved), status: 'queued' })
  noteQueued()
  try { await initRunArtifacts(run, opts.workflow.name) } catch { /* absence is the signal */ }
  log.info('run queued for a slot', { runId: run.id, workflowSlug: run.workflowSlug, group: groupOf(run) })
  return run
}

/**
 * Starts one queued run, if it can start now. The `Launcher` the queue drains
 * with — see runQueue.ts's LaunchOutcome for what each answer commits to.
 *
 * The workflow definition is RE-READ rather than taken from the run record: a
 * record snapshots only each step's id, label and agent, while buildGraph needs
 * `next`, `monitorSlug`, `maxVisits`, `approval`, `runWhen`, `jira`,
 * `triggerWorkflow` and `notify`. Since it is re-read, the steps are also refreshed from it:
 * a queued run has executed nothing, so there is no completed work to preserve
 * and the current definition is simply the right one. (This is why
 * `alignStepIds`, which refuses a changed shape, is not used here — its whole
 * job is protecting completed steps.) `parameters` deliberately stay frozen at
 * admission: what a run was GIVEN must not change under it, even when what it
 * will DO can.
 */
export async function launchQueuedRun(queued: WorkflowRun): Promise<LaunchOutcome> {
  const fail = async (run: WorkflowRun, why: string): Promise<LaunchOutcome> => {
    run.status = 'failed'
    run.error = why
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    log.warn('a queued run can never start; failing it', { runId: run.id, error: why })
    await publish(run)
    return 'failed'
  }

  // Re-read: this run has been sitting on disk, and between the queue listing
  // it and this call it may have been stopped, or launched by another process.
  const run = await getRun(queued.id)
  if (!run) return 'failed'
  if (run.status !== 'queued') return 'deferred'

  const wf = await loadWorkflowSteps(run.workflowSlug)
  if (!wf) return fail(run, `the workflow "${run.workflowSlug}" was deleted while this run waited for a slot`)
  if (!wf.steps.length) return fail(run, `the workflow "${run.workflowSlug}" lost all its steps while this run waited for a slot`)

  // A live run took the directory while this one waited. Not this run's
  // failure and not a race it entered: it keeps its place and the next sweep
  // tries again.
  const workspace = runWorkspace(run)
  if (starting.has(workspace)) return 'deferred'
  if (await findRunInWorkspace(workspace, run.id)) return 'deferred'

  run.steps = wf.steps.map((s: any) => ({
    stepId: s.id, label: s.label, agentSlug: s.agentSlug,
    status: 'pending' as const, input: '', output: '', visits: 0,
  }))

  try {
    await beginRun({ slug: wf.slug, name: wf.name, group: wf.group, notifyChannel: wf.notifyChannel, steps: wf.steps }, {
      product: run.product, projectDir: run.projectDir, ticketKey: run.ticketKey, workspace,
    }, async (baseCommit) => {
      run.baseCommit = baseCommit
      // Ownership moves to this process now. Until this point pid/bootId named
      // whoever queued the run, which may have been a boot ago.
      run.pid = process.pid
      run.bootId = BOOT_ID
      // THE ONE THAT MATTERS: the budget, the wall clock and the cost report
      // are all measured from startedAt. A run that waited four hours and kept
      // its admission time would pause on a spent budget having done no work.
      // `queuedAt` keeps the record of how long it waited.
      run.startedAt = Date.now()
      run.status = 'running'
      await saveRun(run)
      return run
    })
    return 'launched'
  } catch (err) {
    if (err instanceof WorkspaceBusyError) return 'deferred'
    return fail(run, err instanceof Error ? err.message : String(err))
  }
}

/**
 * The entry point every AUTOMATED starter uses: start the run if its group has
 * room, else record it as queued and let the drain start it.
 *
 * The manual paths (the API route, scripts/run-ticket.mjs) deliberately call
 * startRun directly and ignore the cap. A person clicking Start is present,
 * can see what is running, and would read a silently queued run as a broken
 * button. They still OCCUPY a slot — see runQueue.ts's inFlightForGroup — so
 * ignoring the cap means never waiting for it, not never counting against it.
 */
export async function startOrQueue(opts: StartRunOpts): Promise<{ run: WorkflowRun, queued: boolean }> {
  const { workspace } = await resolveStart(opts)
  return admit({
    group: opts.workflow.group?.trim() || DEFAULT_GROUP_ID,
    // Refuses when anything is already AIMED at this directory, queued runs
    // included - a different question from the lock, which asks what is
    // WORKING there (see findRunInWorkspace's includeQueued). Without it, a
    // schedule whose group is full queues at 2am, cannot see itself at 3am,
    // queues again, and by morning eight runs are pointed at one checkout for
    // the drain to launch into each other. Two parents dispatching the same
    // ticket key collide the same way, since a child's directory comes from
    // that key.
    //
    // Inside admit's serialised section, not before it: run outside, two fires
    // a millisecond apart both see an idle directory, and a cap of 2 then lets
    // both start. Thrown rather than returned because every caller already
    // answers WorkspaceBusyError in its own idiom - the schedule records a
    // skip, the dispatch step reports against the entry, the route 409s.
    guard: async () => {
      if (await findRunInWorkspace(workspace, undefined, { includeQueued: true })) {
        throw new WorkspaceBusyError(workspace)
      }
    },
    start: () => startRun(opts),
    enqueue: () => enqueueRun(opts),
  })
}

/**
 * Resumes a paused run in the background and returns promptly, same reasoning as
 * startRun: even a single wave can be several concurrent agent calls running minutes
 * long, and the UI's own flow is "POST continue, then watch SSE" — blocking here would
 * recreate the exact coupling this feature removes, just scoped to one wave instead of
 * the whole run. Callers await waitForSettled(runId) for the outcome.
 */
/** How many consecutive restarts a run is resumed through before it asks for a person. */
const MAX_INTERRUPTIONS = 3

/**
 * Runs the previous process left mid-step, picked up where they were.
 *
 * A rebuild used to cost whatever step was in flight: the run froze as
 * `interrupted` and a person had to notice and restart it, which re-ran the
 * step from turn one. With the session resume above, this costs seconds.
 *
 * Never touches a run that was waiting on a person — that is not an
 * interruption, it is a question nobody answered — and pauses rather than
 * resuming a run that keeps being interrupted, which would otherwise be a loop
 * that spends money on every boot.
 */
export async function resumeInterruptedRuns(): Promise<{ resumed: string[], paused: string[], skipped: string[] }> {
  const out = { resumed: [] as string[], paused: [] as string[], skipped: [] as string[] }
  for (const run of await listRuns()) {
    if (run.status !== 'interrupted') continue
    const frozen = run.steps.find(s => s.status === 'running')
    if (run.question || run.steps.some(s => s.status === 'waiting')) { out.skipped.push(run.id); continue }
    if (!frozen) { out.skipped.push(run.id); continue }
    run.interruptions = (run.interruptions ?? 0) + 1
    if (run.interruptions > MAX_INTERRUPTIONS) {
      frozen.status = 'pending'
      run.status = 'paused'
      run.question = {
        stepId: frozen.stepId, kind: 'approval', askedAt: Date.now(),
        text: `This run has been interrupted ${run.interruptions} times in a row at "${frozen.label}" without finishing it. Continue to try once more, or stop the run.`,
      }
      run.interruptions = 0
      run.pid = process.pid
      run.bootId = BOOT_ID
      await saveRun(run)
      out.paused.push(run.id)
      log.warn('run interrupted repeatedly; asking rather than resuming', { runId: run.id, stepId: frozen.stepId })
      continue
    }
    await saveRun(run)
    try {
      await continueRun(run.id)
      out.resumed.push(run.id)
      log.info('resumed a run the previous process left mid-step', { runId: run.id, stepId: frozen.stepId, interruptions: run.interruptions })
    } catch (err) {
      out.skipped.push(run.id)
      log.warn('could not resume an interrupted run', { runId: run.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/** Continue a paused run. A note travels to the approved step, or to whichever step starts next. */
export async function continueRun(
  runId: string, note?: string, opts: { grantApproval?: boolean } = {},
): Promise<WorkflowRun | null> {
  // Default true: every existing caller means "yes, run it". Only the decision
  // endpoint passes false, and only when the operator approved no entry at all.
  const grantApproval = opts.grantApproval ?? true
  let l = live.get(runId)
  // A run whose owning process died has no live record. Its currentStepIds
  // name what was executing; restarting from those is the honest resume.
  if (!l) {
    const stored = await getRun(runId)
    if (stored?.status === 'interrupted') {
      const from = stored.currentStepIds[0]
        ?? stored.steps.find(s => s.status === 'running' || s.status === 'pending')?.stepId
      if (!from) return stored
      return restartRun(runId, from)
    }
    // Paused with nothing in memory: the process that paused it is gone (a
    // container restart leaves pid 1 in place, so only the record tells).
    // Rebuild the scheduling state from disk and take ownership.
    if (stored?.status !== 'paused' && stored?.status !== 'awaiting_review') return stored
    l = await rehydrate(stored)
    stored.pid = process.pid
    stored.bootId = BOOT_ID
    await saveRun(stored)
  }
  // Re-entrancy guard (C6), matching the client engine's isRunning check pattern. This has
  // to be set synchronously, before the first await below - otherwise two calls that both
  // arrive while a run is paused would each see the guard still clear and both go on to
  // drive the same run's wave loop concurrently.
  if (l.running) return getRun(runId)
  l.running = true
  const run = await getRun(runId)
  if (!run || (run.status !== 'paused' && run.status !== 'awaiting_review')) {
    l.running = false
    return run
  }
  // An open question is answered, never skipped: continuing without a reply
  // tells the agent so in words, and it decides.
  if (run.question?.kind === 'question') {
    l.running = false
    return respondToRun(runId, note?.trim() || 'No further input from the operator; proceed on your best judgement and say what you assumed.')
  }
  if (run.question?.kind === 'approval') {
    if (run.question.reason === 'budget') extendBudget(run)
    // Withholding the approval is what lets a review that approved nothing take
    // effect. l.approved waives runWhen (see resolveConditions), so granting it
    // here would run the step over an artifact the operator just emptied - the
    // approval would override the decision it was supposed to carry out.
    // Without it, the condition is re-tested and the step is skipped by the
    // ordinary path, with the ordinary sentence naming the file.
    else if (grantApproval) l.approved.add(run.question.stepId)
    if (note?.trim() && run.question.stepId) l.notes[run.question.stepId] = note.trim()
  } else if (note?.trim()) {
    l.nextNote = note.trim()
  }
  run.question = undefined
  // As in restartRun: close any stretch left open by a process that is gone, so
  // resuming does not backdate this run's clock to before the interruption.
  reconcileRunClock(run)
  // Persist 'running' before returning, as restartRun and respondToRun do: a
  // reader that lands between this return and the wave's first publish would
  // otherwise see the old 'paused' record and treat the run as settled.
  run.status = 'running'
  await publish(run)
  // driveToSettlement (via runWave) clears l.running itself once the run is genuinely
  // settled again - see the C6 notes on runWave's pause branch for why that has to
  // happen there and not via a .finally() tacked on here.
  void driveToSettlement(l, run)
  return run
}

/**
 * Re-runs the current step with the user's reply in the background and returns
 * promptly — one more agent call that can run long, on the same UI flow (POST, then
 * watch SSE) as continueRun. Any throw from the loop below is caught the same way
 * driveToSettlement catches runWave's: never as an unhandled rejection. Awaits one
 * publish (marking the run 'running') before returning, the same trade as startRun
 * awaiting the run's creation — not the reply itself, just the durable record that
 * one is in flight.
 */
export async function respondToRun(runId: string, reply: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  const l = live.get(runId)
  if (!run || !l || run.status !== 'paused') return run
  const id = run.currentStepIds[0]
  if (!id) return run
  // Continue the session that asked the question: it already holds the brief
  // and its own output, so the answer alone is the whole input.
  const session = resumableSession(recOf(run, id))
  if (session) l.resumeFrom[id] = session
  const combined = session
    ? `User response:\n${reply}`
    : `Previous agent output:\n${l.outputs[id] ?? ''}\n\nUser response:\n${reply}`
  run.question = undefined
  l.waiting = undefined
  // Flip away from 'paused' before doing any work, matching runWave and the client's
  // isRunning flip ahead of its own executeNode call in respondToStep. Without this,
  // run.status reads 'paused' for the whole duration of the reply - indistinguishable
  // from "still waiting for a reply" - and a waitForSettled call issued right after
  // this returns would resolve immediately on that stale status instead of waiting
  // for the reply to actually finish.
  run.status = 'running'
  await publish(run)
  void (async () => {
    try {
      const ok = await executeNode(l, run, id, combined)
      if (!ok) {
        // C2: mark the rest of the graph skipped, not just the run state - same pattern
        // as runWave's and stopRun's failure branches. Without this a downstream step
        // reads back 'pending' in a dead run, indistinguishable from "about to start".
        skipPending(l.state)
        for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
        run.status = 'failed'
        run.endedAt = Date.now()
        run.currentStepIds = []
        run.nextStepIds = []
        await publish(run)
        return
      }
      // C3: a reply that completes the final step must settle the run as completed,
      // not leave it paused - matching the client engine's step response handler behavior,
      // which calls finish() here instead of unconditionally re-pausing.
      if (isFinished(l.graph, l.state)) {
        run.status = 'completed'
        run.endedAt = Date.now()
        run.currentStepIds = []
        run.nextStepIds = []
        await publish(run)
        return
      }
      // The answered step asked again: pause on the new question. Driving on
      // instead found no schedulable step and failed the run as stuck — a real
      // run died that way with its question still on the record.
      if (l.waiting) {
        run.status = 'paused'
        run.currentStepIds = [l.waiting]
        run.nextStepIds = []
        await publish(run)
        return
      }
      // A run-to-completion run resumes on its own once the answer is in.
      if (run.autoRun && !l.stopped) {
        l.running = true
        await driveToSettlement(l, run)
        return
      }
      run.nextStepIds = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
      run.status = 'paused'
      await publish(run)
    } catch (err) {
      try {
        await failRun(run, err)
      } catch {
        /* see driveToSettlement: persisting the failure itself failed, stop here rather
         * than risk another unhandled rejection. */
      }
    }
  })()
  return run
}

/** The operator's way to steer a run in flight: the note goes straight into every
 *  agent working right now, and is logged on their steps; with no agent mid-call it
 *  waits for whichever step starts next. */
export async function noteRun(runId: string, text: string): Promise<{ delivered: string[] } | { queued: string } | null> {
  const l = live.get(runId)
  if (!l) return null
  const note = text.trim()
  const run = await getRun(runId)
  const delivered: string[] = []
  for (const [stepId, deliver] of l.steer) {
    const rec = run?.steps.find(s => s.stepId === stepId)
    if (!rec || !deliver(note)) continue
    delivered.push(rec.label)
    logLine(l, run!, rec, `[Operator] ${note}`)
  }
  if (delivered.length) {
    log.info('operator note delivered to running agents', { runId, steps: delivered, preview: preview(note) })
    return { delivered }
  }
  l.nextNote = note
  log.info('operator note queued', { runId, preview: preview(text) })
  return { queued: l.nextNote }
}

export async function stopRun(runId: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  if (!run) return null
  // C5: a run that already reached a real outcome is not "stopped" by stopping it again.
  if (TERMINAL_STATUSES.includes(run.status)) return run
  const l = live.get(runId)
  if (l) {
    l.stopped = true
    skipPending(l.state)
    for (const ac of l.aborts.values()) ac.abort()
  }
  for (const s of run.steps) if (s.status === 'pending' || s.status === 'waiting') s.status = 'skipped'
  run.question = undefined
  run.status = 'stopped'
  run.endedAt = Date.now()
  run.currentStepIds = []
  run.nextStepIds = []
  log.info('run stopped', { runId: run.id })
  await publish(run)
  return run
}

export class RestartError extends Error {
  statusCode: number
  data?: Record<string, unknown>
  constructor(statusCode: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.statusCode = statusCode
    this.data = data
  }
}

/** Test seam: forget a run's in-memory record, as a server restart would. */
export function _dropLive(runId: string) { live.delete(runId) }

/**
 * Rebuilds the in-memory scheduling record from the persisted run. Completed
 * steps are re-marked in step order so the graph arms exactly what it would
 * have armed live; their outputs and inputs come back from the record. Anything
 * not completed stays pending and unarmed until a predecessor arms it.
 */
async function rehydrate(run: WorkflowRun): Promise<Live> {
  const existing = live.get(run.id)
  if (existing) return existing
  const workflow = await loadWorkflowSteps(run.workflowSlug)
  if (!workflow) {
    throw new RestartError(409, `Workflow "${run.workflowSlug}" no longer exists, so this run cannot be rebuilt`)
  }
  const steps = alignStepIds(workflow.steps, run)
  const aligned = { ...workflow, steps }
  const graph = buildGraph(steps)
  const state = initRunState(graph)
  const l: Live = {
    workflow: aligned, graph, state, outputs: {}, lastInputs: {}, retryFeedback: {}, resumeFrom: {}, stopped: false, running: false, aborts: new Map(), logs: {}, approved: new Set(), notes: {}, steer: new Map(),
  }
  const header = artifactHeader(runArtifactsDir(run.id), undefined, undefined, run.id, undefined, run.parameters)
  // A declared skip is a settled outcome, the same as completed: a restart of a
  // later step must not run it again. A real restart re-ran the provisioner,
  // which cloned the product a second time beside the checkout the fix step
  // was working in. A scheduler skip (after a failure) has no skipReason and
  // stays pending, so the restart can reach it.
  const settled = (s: RunStep) => s.status === 'completed' || (s.status === 'skipped' && !!s.skipReason)
  for (const s of run.steps) {
    state.visits[s.stepId] = s.visits ?? 0
    // A failed step is restored as failed, not pending: restartRun re-runs failed
    // wave siblings by reading exactly this, and a pending-looking failure would
    // never be picked up again.
    if (!settled(s)) { if (s.status === 'failed') markFailed(state, s.stepId); continue }
    markCompleted(graph, state, s.stepId)
    l.outputs[s.stepId] = s.output
    // Stored input carries the artifact header; computeInput's retry branch
    // rebuilds from lastInputs, so strip it the way executeNode keeps it.
    l.lastInputs[s.stepId] = s.input.startsWith(header) ? s.input.slice(header.length) : s.input
  }
  // A completed node has consumed its arming: live, markRunning clears it before
  // the node executes. Without this an entry node stays armed and re-runs, and
  // re-arms everything downstream with it.
  for (const s of run.steps) if (settled(s)) state.armed[s.stepId] = false
  live.set(run.id, l)
  return l
}

/**
 * A workflow file re-saved since the run began (the template sync regenerates
 * every step id) no longer shares ids with the run. When the agent sequence
 * still matches position for position, the run's ids are authoritative and the
 * file's edges are rewritten to them; anything else is a different workflow.
 */
function alignStepIds(steps: any[], run: WorkflowRun): any[] {
  const known = new Set(steps.map(s => s.id))
  const recorded = new Set(run.steps.map(s => s.stepId))
  if (run.steps.every(s => known.has(s.stepId))) {
    // Ids match, but a node the run never recorded would fail its wave silently.
    if (steps.every(s => recorded.has(s.id))) return steps
    throw new RestartError(409, `Workflow "${run.workflowSlug}" changed since this run started; start a new run instead`)
  }
  const sameShape = steps.length === run.steps.length
    && steps.every((s, i) => s.agentSlug === run.steps[i]?.agentSlug)
  if (!sameShape) {
    throw new RestartError(409, `Workflow "${run.workflowSlug}" changed since this run started; start a new run instead`)
  }
  const idMap: Record<string, string> = {}
  steps.forEach((s, i) => { idMap[s.id] = run.steps[i]!.stepId })
  return steps.map(s => ({
    ...s,
    id: idMap[s.id],
    next: Array.isArray(s.next) ? s.next.map((n: string) => idMap[n] ?? n) : s.next,
  }))
}

function forwardDescendants(graph: WorkflowGraph, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const next of graph.succ[cur] ?? []) {
      if (graph.backEdges.has(`${cur}->${next}`) || seen.has(next)) continue
      seen.add(next); out.push(next); stack.push(next)
    }
  }
  return out
}

const RESTARTABLE: WorkflowRun['status'][] = ['failed', 'stopped', 'interrupted', 'completed']

/**
 * Re-runs `stepId` and everything downstream of it, keeping every other
 * step's output, under the same run id and artifacts directory. The previous
 * attempt of each reset step is snapshotted the way monitor retries are.
 */
export async function restartRun(runId: string, stepId: string, note?: string, startedBy?: string, opts: { /** The runner itself hands a running run over (a widened run); the settled-status gate is the operator's, not its. */ fromRunner?: boolean } = {}): Promise<WorkflowRun> {
  const run = await getRun(runId)
  if (!run) throw new RestartError(404, 'Run not found')
  if (!run.steps.some(s => s.stepId === stepId)) throw new RestartError(400, `Unknown step "${stepId}"`)
  if (!opts.fromRunner && !RESTARTABLE.includes(run.status)) {
    const instead = run.status === 'paused'
      ? 'continue it instead'
      : run.status === 'awaiting_review'
        ? 'record your decisions instead'
        : 'wait for it to settle'
    throw new RestartError(409, `A ${run.status} run cannot be restarted; ${instead}`)
  }
  // Same scope as starting a run: what conflicts is a shared working directory.
  const active = await findRunInWorkspace(runWorkspace(run), run.id)
  if (active) {
    throw new RestartError(
      409,
      `${active.startedBy ? `@${active.startedBy} has` : 'There is'} a run in progress in ${runWorkspace(run)}`,
      { runId: active.id },
    )
  }
  // A restart starts from what is on disk. An in-memory record left by a
  // previous attempt carries that attempt's state, and a second restart
  // scheduled against it found nothing to run and reported the run complete.
  const stale = live.get(runId)
  if (stale?.running) throw new RestartError(409, 'This run is already running')
  if (stale) live.delete(runId)
  const l = await rehydrate(run)

  const reset = [stepId, ...forwardDescendants(l.graph, stepId)]
  // A failed step elsewhere in the same wave would stay failed after a partial
  // restart, and the join downstream then waits on it forever - the run settles
  // with its evidence step never armed. So every other failed step whose
  // predecessors all completed is re-run too, with its own descendants: the
  // operator's restart means "get this run going", not "this one step only".
  const readyFailed = l.graph.nodes.map(n => n.id).filter(id =>
    !reset.includes(id) && l.state.status[id] === 'failed'
    && (l.graph.forwardPreds[id] ?? []).every(p => l.state.status[p] === 'completed'))
  for (const id of readyFailed) for (const d of [id, ...forwardDescendants(l.graph, id)]) if (!reset.includes(d)) reset.push(d)

  // A restart re-runs steps; it does not re-create what earlier steps left on
  // disk. Restarting a downstream step into a workspace with no checkout is how
  // one run spent 3.26M tokens - $50 - searching a directory with no code in
  // it, twice, because the provisioning step had already settled as `skipped`
  // and a partial restart never re-ran it.
  //
  // Deliberately not keyed on any agent slug: the runner does not know which
  // step owns the checkout, only that SOME earlier step was supposed to leave
  // one. If it is missing, no partial restart is sound - so the reset must
  // start from the first step, which re-runs whatever creates it.
  // Scoped to runs that actually route to repositories. A workflow with no
  // product resolved has no checkout to be missing, and blocking those would
  // turn a real guard into a nuisance that gets deleted.
  const expectsCheckout = (run.product?.repos?.length ?? 0) > 0
  if (expectsCheckout && !hasCheckout(runWorkspace(run)) && ancestorsOf(l.graph, stepId).length > 0) {
    throw new RestartError(
      409,
      `This run targets ${run.product?.repos?.join(', ')}, but there is no checkout in ${runWorkspace(run)} — `
      + `restarting this step would run it against an empty directory. Restart from the first step so whatever `
      + `creates the checkout runs again, or start a new run.`,
    )
  }

  // The same gate the start does, for the same reason: a restart after a fix
  // to the environment should say so in seconds, and a restart into an
  // environment still missing its compose file or its Jira status should not
  // spend a step's budget rediscovering that.
  run.preflight = await preflight(run, l.workflow.steps)
  const blocked = preflightFailure(run.preflight)
  if (blocked) {
    await saveRun(run)
    throw new RestartError(409, `Preflight: ${blocked}`)
  }

  const previousOutput = recOf(run, stepId).output
  // The restarted step continues where it was, unless the runner itself is
  // handing the run over with new scope or a new instruction (widen, rework),
  // where the whole brief is the point. Descendants never resume: their work
  // was invalidated by whatever is being redone above them.
  if (!opts.fromRunner) {
    const rec = recOf(run, stepId)
    const session = resumableSession(rec)
    if (session) {
      l.resumeFrom[stepId] = session
      l.retryFeedback[stepId] = note?.trim()
        ? `The run was restarted at this step, with this from the operator: ${note.trim()}\n\nYou still have everything you read. Continue from where you were, do not redo finished work, and end with the report.`
        : 'The run was restarted at this step after an interruption. You still have everything you read. Continue from where you were, do not redo finished work, and end with the report.'
    }
  }
  for (const id of reset) {
    const rec = recOf(run, id)
    // An interruption is not an attempt. A step frozen at 'running' by a server
    // that died never reached an outcome, and counting it against maxVisits is
    // how three container rebuilds exhausted a step's three visits without it
    // ever failing at anything.
    if (rec.status === 'running') {
      l.state.visits[id] = Math.max(0, (l.state.visits[id] ?? rec.visits ?? 1) - 1)
      rec.visits = l.state.visits[id]
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec), `interrupted-${rec.visits + 1}`) } catch { /* best effort */ }
    }
    // Only an attempt that actually ran is worth snapshotting; a skipped step has nothing to keep.
    else if (rec.status !== 'pending' && rec.visits > 0) {
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec), `restart-${rec.visits}`) } catch { /* best effort */ }
    }
    Object.assign(rec, {
      status: 'pending', output: '', error: undefined, startedAt: undefined, completedAt: undefined,
      monitorVerdict: undefined, monitorNote: undefined, model: undefined,
    })
    l.state.status[id] = 'pending'
    l.state.armed[id] = false
    delete l.state.triggeredBy[id]
    delete l.outputs[id]
    delete l.retryFeedback[id]
  }
  // Arm the restart point the way its predecessors would have: an entry arms
  // itself; otherwise every forward predecessor must still read completed.
  if (l.graph.entries.includes(stepId)) armNode(l.state, stepId)
  else if ((l.graph.forwardPreds[stepId] ?? []).every(p => l.state.status[p] === 'completed')) armNode(l.state, stepId)
  else throw new RestartError(409, `Step "${stepId}" has predecessors that did not complete; restart from one of those`)
  for (const id of readyFailed) armNode(l.state, id)
  // By the same argument as the visit concession below, a `runWhen` condition is
  // waived for exactly the steps this restart arms: the predicate guards
  // automatic scheduling, not a person naming the step they want run. Without
  // this, restarting a step that was condition-skipped would silently skip it
  // again and read as a restart that did nothing.
  l.conditionOverride = new Set([stepId, ...readyFailed])
  // An operator's restart is always worth one more visit: the visit cap guards
  // loops and monitor retries, not a person's explicit decision. A step at its
  // cap was otherwise unschedulable, and the empty wave read as a finished run.
  // The cap itself is fixed by the evidence schema, so the count saturates there.
  for (const id of reset) {
    const node = l.graph.nodes.find(n => n.id === id)
    const cap = node ? maxVisitsOf(node) : Infinity
    if ((l.state.visits[id] ?? 0) >= cap) l.state.visits[id] = cap - 1
  }

  // An operator note rides the same channel as a monitor's retry feedback, so
  // the restarted step sees its previous attempt and the correction together.
  if (note?.trim()) {
    l.outputs[stepId] = previousOutput
    l.retryFeedback[stepId] = `Operator note: ${note.trim()}`
  }

  // A restart is a person's decision, and it comes with a fresh allowance.
  extendBudget(run)
  l.stopped = false
  l.running = true
  // A run whose owning process died never published a settled status, so its
  // clock stretch is still open. Close it against what the record last knew
  // happened, BEFORE the status and endedAt below are rewritten - reopening it
  // instead would charge this restart with every hour the run spent dead. A
  // no-op for the runner's own hand-over (widen, rework), where the run never
  // stopped and the stretch is still the current one.
  reconcileRunClock(run)
  run.status = 'running'
  run.error = undefined
  run.endedAt = undefined
  // A question the restarted step asked before is answered by the restart
  // itself; left on the record it showed "Waiting for you" on a running run
  // that nobody could answer.
  run.question = undefined
  l.waiting = undefined
  run.pid = process.pid
  run.bootId = BOOT_ID
  if (startedBy) run.startedBy = startedBy
  run.currentStepIds = []
  run.nextStepIds = [stepId, ...readyFailed]
  await publish(run)
  void driveToSettlement(l, run)
  return run
}
