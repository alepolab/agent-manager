import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed, maxVisitsOf,
  skipPending, isFinished, armNode, canRevisit, joinInputs, parseVerdict, parseReviewVerdict, parseHalt, parseSkip, parseWiden, parseRework, parseNotDone,
  monitorPrompt, MAX_CONCURRENCY, ancestorsOf, edgeKey,
  type WorkflowGraph, type RunState, type StepOutcome, type GraphEdge,
} from '../../shared/utils/workflowGraph.ts'   // relative, not an alias: the node
                                               // test scripts import this file
                                               // directly and cannot resolve ~~/
import { runElapsedMinutes, startRunClock, settleRunClock, reconcileRunClock } from '../../shared/utils/runClock.ts'
import type { Role } from '../../shared/types/role.ts'
import { defaultBudget, absoluteUsdCeiling, createRun, getRun, saveRun, listRuns, loadWorkflowSteps, findActiveRun, findRunInWorkspace, findRunForTicket, BOOT_ID } from './workflowRunStore.ts'
import { runWorkspace, hasCheckout, browserSurface } from './workspace.ts'
import { resolveProduct, productByKey, registeredProductKeys } from './registry.ts'
import { resolveModelMeta } from './models.ts'
import { onRunTransition } from './notify.ts'
import { envForUser } from './users.ts'
import { callAgent, type AgentUsage, type AgentProgress, type AgentCallOptions } from './agentCaller.ts'
import { AgentResultError, declaredModelOf } from './agentCaller.ts'
import { captureBaseline, workingTreeDirty, uncommittedPatch } from './gitFacts.ts'
import { shipIntegrity, describeShipFindings, type ShipFinding } from './shipIntegrity.ts'
import { recordCommandLine, forgetRun } from './commandLedger.ts'
import { checkTestLock, headOf, changedPathsSince } from './testLock.ts'
import { parseProposal, floorFrom, adopt, classProvenance } from '../../shared/utils/classification.ts'
import { collectReviewComments } from './reviewComments.ts'
import { resolveStackRecipe, StackError } from './stackRecipe.ts'
import { stackUp, stackDown } from './stackLifecycle.ts'
import { planDeploy, runDeploy, DeployError } from './deployStep.ts'
import { prUrlsOf } from './ciPoller.ts'
import { baseBranchFor, describeBranchChoice } from './branchPolicy.ts'
import { artifactsWritable, checkoutDirFor, ensureRunBranch, findCheckout, laneBranchFor, ensureLane, mergeLane, removeLane } from './workspace.ts'
import { runPreflight as realPreflight, preflightFailure, type PreflightReport, type PreflightSteps } from './preflight.ts'
import { criteriaForGate } from './gateCriteria.ts'

/**
 * Preflight, overridable the way the agent caller is. A runner check is about
 * the runner; whether THIS machine has a checkout, a docker daemon or the
 * plugin installed is what scripts/test-preflight.mjs is for.
 */
let preflight: (run: WorkflowRun, steps: PreflightSteps[]) => Promise<PreflightReport> = realPreflight
export function setPreflight(fn: typeof preflight) { preflight = fn }
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir, transcriptPath } from './claudeDir.ts'
import { oversightFor, oversightForGate, oversightReason, needsJustification, BLAST_RADIUS_ORDER, type BlastRadius, type GateKind } from '../../shared/utils/oversight.ts'
import {
  runArtifactsDir, initRunArtifacts, writeStepArtifact, finalizeRunArtifacts, artifactHeader,
  markArtifactsUnusable, recordClassification,
} from './runArtifacts.ts'
import { createLogger, preview } from './log.ts'
import { notifyTicketOutcome } from './ticketNotifier.ts'
import { isJiraPostingEnabled } from './jiraCredentials.ts'
import { runJiraStep, type JiraStepConfig } from './jiraSteps.ts'
import { viewIssue, downloadAttachments } from './jiraTicketSource.ts'
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
/**
 * Substituting the caller also turns OFF light interpretation, and that is not
 * a convenience: a run whose agents are stubbed must not reach a live model for
 * a risk floor or a summary line. Without this, every harness in this file's
 * suite pays a real model call per classifying step — one of them timed out at
 * fifteen seconds waiting for exactly that. The deterministic path is what a
 * stubbed run is FOR.
 */
export function setAgentCaller(fn: AgentCaller) {
  agentCaller = fn
  if (fn !== callAgent) process.env.AGENT_LIGHT_INTERPRET = '0'
}
/** Exposed for tests: the exact function reference executeNode will call next. */
export function getAgentCaller() { return agentCaller }
/** True unless a test has overridden the caller with setAgentCaller(). */
export function isRealAgentCallerActive() { return agentCaller === callAgent }

interface WorkflowLike {
  slug: string
  name: string
  steps: { id: string, agentSlug: string, label: string, next?: (string | GraphEdge)[], monitorSlug?: string, maxVisits?: number, approval?: boolean, verdict?: boolean, gateRole?: Role, gateKind?: GateKind, ownerRole?: Role, contextMode?: 'predecessors' | 'ancestors', jira?: JiraStepConfig, pr?: boolean, testsUnlocked?: boolean, reviewComments?: boolean, stack?: 'up', deploy?: { env: string, step: string, app?: string, limit?: string, check?: boolean }, continuesSession?: boolean }[]
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
  /**
   * Why this ticket is being run again although a completed run already did it.
   * Required to start a second run on the same ticket — see findRunForTicket:
   * CSUP-7514 was solved twice in two codebases because nothing asked.
   */
  rerunReason?: string
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
  /**
   * stepId -> the lane worktree this step's agent works in, for the duration of
   * one parallel wave. Empty for a wave of one, which keeps the single-lane path
   * exactly as it was: the step works in the run's own worktree.
   */
  laneDirs: Record<string, string>
  /** stepId -> the lane branch to merge back into the run branch when the wave settles. */
  laneBranches: Record<string, string>
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
  /** True while this run's wave loop is actually executing in the background - the
   *  re-entrancy guard for continueRun (C6). Set synchronously, before any await, so
   *  two "concurrent" calls can never both observe it false. */
  running: boolean
  /** A step found the fault outside the run's scope; runWave re-provisions and continues from there. */
  widen?: { from: string, target: string, reason: string, added: string[] }
  /** A step sent the run back to an earlier step with an instruction; runWave restarts from there. */
  rework?: { from: string, target: string, instruction: string }
}
const live = new Map<string, Live>()
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
function logLine(l: Live, run: WorkflowRun, rec: RunStep, line: string, kind?: 'text' | 'tool' | 'result') {
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
  // The same line, parsed into the record of what this run actually executed.
  // Every tool call an agent makes already passes through here as a line
  // carrying its command; until now that was written to a log nothing read. See
  // commandLedger.ts for what the gates then ask of it — and note that `kind`
  // is load-bearing: a line the AGENT typed reads exactly like a tool call, and
  // only the block it came from tells them apart.
  recordCommandLine(run.id, rec.stepId, line, kind, l.laneDirs[rec.stepId] ?? run.projectDir)
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
    // Money is extended like the rest, and then clamped: continuing a gate
    // grants another allowance, it does not grant an unlimited one. Four real
    // runs had their caps ratcheted this way with nothing watching the total.
    // The ceiling caps the EXTENSION, never the budget a run is already
    // operating under: clamping downward would strand a run mid-flight the
    // moment someone clicked continue, on an instance whose configured cap is
    // above the ceiling. Raise-only, bounded.
    maxUsd: Math.max(
      run.budget.maxUsd ?? 0,
      Math.min(absoluteUsdCeiling(), (spent.usd ?? 0) + (fresh.maxUsd ?? 0)),
    ),
  }
  if (extended.maxTokens !== run.budget.maxTokens || extended.maxMinutes !== run.budget.maxMinutes
    || extended.maxUsd !== run.budget.maxUsd) {
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
  // Money last because it is the cap an operator set in the units they think
  // in; the two above are proxies for it that have never once fired first.
  if (b.maxUsd && (u.usd ?? 0) > b.maxUsd) {
    return `Budget exceeded: $${(u.usd ?? 0).toFixed(2)} spent over the $${b.maxUsd.toFixed(2)} cap.`
  }
  return null
}

/**
 * Take down the stack this run started, once, and record that it happened.
 *
 * Idempotent by `stackStopped`: publish() runs on every status transition and a
 * run can reach a terminal status more than once (a stop after a failure), and
 * `docker compose down` twice is harmless but a second attempt that fails would
 * overwrite an accurate record with a confusing one.
 *
 * Never throws. A teardown that fails must not change the run's outcome - the
 * work is done either way - but it is recorded so nobody has to guess whether
 * containers are still up.
 */
async function takeStackDown(run: WorkflowRun): Promise<void> {
  if (!run.stackStarted || run.stackStopped) return
  try {
    const recipe = await resolveStackRecipe({ compose: `alepo-dev-team-infra/${run.stackStarted}` })
    const result = await stackDown(recipe, { runId: run.id })
    run.stackStopped = result.summary
    log.info('stack taken down with the run', { runId: run.id, product: run.stackStarted, ok: result.ok })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    run.stackStopped = `Taking the ${run.stackStarted} stack down failed: ${why}. It may still be running; check with docker ps.`
    log.warn('could not take the stack down', { runId: run.id, product: run.stackStarted, error: why })
  }
}

/**
 * Posting the ticket outcome, behind a seam so tests never reach Jira.
 * Defaults to the real notifier.
 */
type TicketPoster = typeof notifyTicketOutcome
let ticketPoster: TicketPoster | null = null
export function setTicketPoster(fn: TicketPoster | null) { ticketPoster = fn }
const postTicketOutcome: TicketPoster = (...args) => (ticketPoster ?? notifyTicketOutcome)(...args)

/** Records that the comment has landed, so no later boot re-owes it. */
async function clearNotifyIntent(run: WorkflowRun): Promise<void> {
  if (run.ticketNotifyPending !== true) return
  run.ticketNotifyPending = false
  await saveRun(run)
}

/**
 * Finishes ticket notifications a dead process owed.
 *
 * publish() saves the terminal status before it posts, because the comment
 * renders from finalized artifacts - the PR URLs it quotes are written by
 * finalizeRunArtifacts, which must run first. That ordering means a process
 * death between the two leaves a run recorded as finished whose ticket was
 * never told, and a settled run is never re-published, so nothing retries.
 *
 * Rather than reorder and post a comment that cannot name the PR, the INTENT
 * is written with the terminal status and cleared only once the comment is
 * really on the ticket. This sweep, run at boot, is what clears it. A repeat
 * is safe because notifyTicketOutcome reads its own marker first.
 */
export async function completePendingTicketNotifications(): Promise<{ notified: string[], failed: string[] }> {
  const out = { notified: [] as string[], failed: [] as string[] }
  for (const run of await listRuns()) {
    if (run.ticketNotifyPending !== true || !run.ticketKey) continue
    try {
      const result = await postTicketOutcome({ id: run.watch, name: run.workflowName }, run.ticketKey, run)
      if (result.posted) {
        await clearNotifyIntent(run)
        out.notified.push(run.id)
        log.info('finished a ticket notification the previous process owed', { runId: run.id, ticketKey: run.ticketKey })
      } else {
        // Still owed: posting is disabled, or Jira refused. Left on the record
        // rather than dropped, because dropping it is the silent loss this
        // whole mechanism exists to prevent.
        out.failed.push(run.id)
      }
    } catch (err) {
      out.failed.push(run.id)
      log.warn('could not finish an owed ticket notification', {
        runId: run.id, ticketKey: run.ticketKey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

/**
 * A run that says it shipped must be able to show the work.
 *
 * Checked here, in publish, for the same reason finalize is: there are
 * six-plus places a run reaches a terminal status and a check at each site is
 * one that gets forgotten. Only a run about to be recorded `completed` is
 * asked — a failed or stopped run is already telling the truth.
 *
 * The downgrade is deliberate and is the whole point: three real runs finished
 * `completed` while their fix sat on an unmerged lane branch, two commits ahead
 * of the pushed branch, or on no branch with a pull request at all. Every one
 * of them read as success on the runs page and in its Jira comment.
 */
/**
 * The risk class of a run nothing classified, measured from what it changed.
 *
 * Six of thirteen runs carried no class at all and two carried one that did not
 * match the diff — a 1,850-line change that added a server-side call to an
 * external address API was recorded `ui_parsing`. Oversight, review depth and
 * customer notification all key off this field, so an absent one is not a
 * neutral default: it is every gate firing on a guess. The floor is computed
 * from the paths git says the run touched, the same function intake's own
 * proposal is checked against, and recorded with its provenance so nobody reads
 * it as a step's own claim.
 */
async function classifyFromDiff(run: WorkflowRun): Promise<void> {
  if (run.blastRadius || !run.projectDir || !run.baseCommit) return
  try {
    const floor = floorFrom(await changedPathsSince(run.projectDir, run.baseCommit))
    if (!floor) return
    run.blastRadius = floor
    run.classSource = 'floor-only'
    log.info('blast radius measured from the diff at the end of the run', { runId: run.id, blastRadius: floor })
  } catch (err) {
    // Unmeasurable stays unclassified, which oversight already treats as the
    // most cautious answer. A guess here would be worse than the absence.
    log.warn('could not measure a blast radius from the diff', { runId: run.id, error: String(err) })
  }
}

async function enforceShipIntegrity(run: WorkflowRun): Promise<void> {
  if (run.status !== 'completed' || run.shipIntegrity) return
  // Read from the RECORD, not from live state: a run resumed after a restart
  // has no Live object here, and "was this workflow meant to ship?" must not
  // depend on whether the process that started it is still alive.
  const expectPr = run.expectsPr === true
  let meta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed
  } catch { /* no meta yet: the git checks below still answer */ }
  let findings: ShipFinding[]
  try {
    // Plus anywhere the ledger saw this run write outside its own checkout —
    // repoDirsOf can only enumerate the places a run is SUPPOSED to write, and
    // a3cb9d37's frontend fix sat in a repository it had never heard of.
    let strayDirs: string[] = []
    try {
      const { readCommandLedger, strayWork } = await import('./commandLedger.ts')
      strayDirs = run.projectDir
        ? strayWork(await readCommandLedger(run.id), run.projectDir).map(s => s.dir)
        : []
    } catch { /* no ledger: the checks below still answer for the known repos */ }
    findings = await shipIntegrity(run, expectPr, meta, strayDirs)
  } catch (err) {
    // A check that cannot run must not invent a verdict in either direction.
    log.warn('ship integrity could not be checked', { runId: run.id, error: String(err) })
    return
  }
  run.shipIntegrity = findings
  if (!findings.length) return
  run.status = 'failed'
  run.error = `The work this run reports is not reachable. ${describeShipFindings(findings)}`
  log.warn('run downgraded from completed: its work is not reachable', {
    runId: run.id, problems: findings.map(f => f.problem),
  })
}

async function publish(run: WorkflowRun) {
  if (TERMINAL_STATUSES.includes(run.status)) {
    await classifyFromDiff(run)
    await enforceShipIntegrity(run)
    // In-flight command bookkeeping for a finished run: the file on disk is the
    // record from here, and these maps would otherwise grow for the life of the
    // process.
    forgetRun(run.id)
  }
  // The run clock, advanced here for the same reason finalizeRunArtifacts is
  // called here: every status transition in this file passes through publish(),
  // and there are too many terminal branches for per-site bookkeeping to stay
  // correct. Running opens a stretch (idempotently - a wave publishes 'running'
  // many times); anything else closes it, so the time a run spends failed,
  // paused or stopped is never counted as time it worked.
  if (run.status === 'running') startRunClock(run)
  else settleRunClock(run)
  run.usage = computeUsage(run)
  // The intent to notify is written WITH the terminal status, in the same
  // saveRun below - not after the post. A process that dies before posting
  // then leaves a record that still says the comment is owed.
  // Only when posting is actually on. With JIRA_POST_ENABLED unset the comment
  // is rendered and recorded but deliberately never sent, so nothing is owed -
  // marking it pending would have every run on an ordinary machine accrue a
  // debt that each boot then re-renders forever.
  if (TERMINAL_STATUSES.includes(run.status) && run.ticketKey && !run.ticketCommented
    && run.ticketNotifyPending === undefined && isJiraPostingEnabled()) {
    run.ticketNotifyPending = true
  }
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
    if (!TERMINAL_STATUSES.includes(run.status) && EVIDENCE_FINAL_STATUSES.includes(run.status)) {
      // An interrupted run: its evidence is finalized, nothing else is. No
      // teardown (a resume needs the stack), no ticket comment (the run has not
      // ended), no reaping (its containers may be mid-step).
      try {
        await flushLogs(run.id)
        await finalizeRunArtifacts(run)
      } catch (err) {
        log.warn('could not finalize the artifacts of an interrupted run', { runId: run.id, error: String(err) })
      }
    }
    if (TERMINAL_STATUSES.includes(run.status)) {
      // Take down whatever this run started, here for the same reason finalize
      // is here: there are six-plus terminal branches and a teardown at each
      // site is one that gets forgotten. A failed run is exactly when a stack
      // is most likely to be left running, so this must not be on the happy
      // path. Volumes are never removed - the data and seed survive.
      await takeStackDown(run)
      // Then whatever the run created that the stack recipe does not own:
      // 150 GB of images, containers and build cache leaked because nothing
      // was labelled and nothing looked. Only objects carrying THIS run's
      // label are touched, and never a volume.
      try {
        const { reapRun } = await import('./dockerReap.ts')
        const reaped = await reapRun(run.id, { apply: true })
        if (reaped.removed.length) log.info('reaped docker objects this run created', { runId: run.id, removed: reaped.removed.length })
      } catch (err) {
        log.warn('could not reap this run\'s docker objects', { runId: run.id, error: String(err) })
      }
      await withdrawTestUnlocks(run)
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
            const result = await postTicketOutcome(
              { id: run.watch, name: run.workflowName },
              run.ticketKey,
              run,
            )
            // Cleared only on a real post. `posted` is also true when the
            // marker says a previous attempt did it, which is equally a reason
            // to stop owing it.
            if (result.posted) await clearNotifyIntent(run)
            log.info('ticket notified', {
              runId: run.id, ticketKey: run.ticketKey,
              posted: result.posted, reason: result.reason ?? '(none)',
            })
          } catch (err) {
            // The intent stays on the record, so the next boot finishes it.
            log.error('ticket notification failed; it stays owed and the next boot will retry', {
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
    // A settled run frees the checkout it held and the capacity slot it
    // occupied, which is the only moment the next queued task can start. Doing
    // it here rather than on a timer means "one after another" needs nobody
    // watching; `onRunSettled` never throws and never blocks this publish.
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped' || run.status === 'interrupted') {
      // Imported here rather than at module scope on purpose: the dispatcher
      // reaches the workflow store and the Jira client, and pulling that chain
      // into the runner's own module graph put it in front of thirteen
      // plain-node tests that never needed it. It is only wanted at runtime,
      // at exactly this moment.
      void import('./queueDispatcher.ts')
        .then(m => m.onRunSettled())
        .catch(err => console.error('[queue] could not dispatch after settle:', err instanceof Error ? err.message : err))
    }
  })
  publishChains.set(run.id, next)
  await next
}

const SETTLED_STATUSES: WorkflowRun['status'][] = ['paused', 'completed', 'failed', 'stopped']
const isSettled = (status: WorkflowRun['status']) => SETTLED_STATUSES.includes(status)
/** Statuses stopRun (C5) must never overwrite - the run already reached its real outcome. */
const TERMINAL_STATUSES: WorkflowRun['status'][] = ['completed', 'failed', 'stopped']

/**
 * Statuses whose EVIDENCE is final even though the run may move again.
 *
 * `interrupted` is not terminal — the process died and a later boot resumes it
 * — but its artifacts are as complete as they will ever be until that happens,
 * and finalize is what writes the contract report, the provenance and the
 * index row. A run that is never resumed used to be checked by nothing at all:
 * no `contract_missing`, no index row, no summary. Teardown and the ticket
 * comment stay behind TERMINAL_STATUSES, because those are about the run
 * ending, not about the evidence being current.
 */
const EVIDENCE_FINAL_STATUSES: WorkflowRun['status'][] = [...TERMINAL_STATUSES, 'interrupted']

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
  // Asked of every place the SDK might have written it, not just this app's
  // config directory: in a container those are different directories, and
  // looking only in ours made every resume a silent cold start.
  return transcriptPath(rec.sessionProject, rec.sessionId) ? rec.sessionId : undefined
}

/**
 * The predecessor's session this step continues, or undefined for a cold start.
 *
 * Only for a step that declares `continuesSession`, and only when the answer is
 * unambiguous: exactly one forward predecessor, which completed, whose
 * transcript is still on disk. Anything else starts fresh — the same contract
 * as `resumableSession`: undefined is always correct, only more expensive.
 *
 * Fan-in is the reason for the single-predecessor rule. A step joining three
 * upstream branches has no "the" session to continue, and silently picking one
 * would hand it one third of its context while the header it would otherwise
 * have received carried all three.
 */
function inheritedSession(l: Live, run: WorkflowRun, id: string): string | undefined {
  const step = stepOf(l, id)
  if (!step?.continuesSession) return undefined
  const preds = l.graph.forwardPreds[id] ?? []
  if (preds.length !== 1) {
    log.info('step declares continuesSession but has no single predecessor; starting fresh', { runId: run.id, stepId: id, preds: preds.length })
    return undefined
  }
  const rec = run.steps.find(s => s.stepId === preds[0])
  if (!rec || rec.status !== 'completed') return undefined
  const session = resumableSession(rec)
  if (session) log.info('step continues its predecessor\'s session', { runId: run.id, stepId: id, from: rec.stepId, sessionId: session })
  return session
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
/**
 * Where a step's test unlock may be written: its own working directory, and
 * nowhere else.
 *
 * This used to also copy the unlock into the run's shared worktree, so the
 * reason would survive the lane being removed. That made the shared `.agent`
 * directory a channel between lanes running at the same moment: run a3cb9d37
 * lost its client lane's work because lock state armed by the BACKEND lane was
 * reachable from it, and the client fix ended up staged and uncommitted.
 *
 * A capability granted to one step must not be visible to a sibling that never
 * earned it. The reason is preserved by withdrawTestUnlocks, which copies it
 * into the run's own evidence when the run ends - a better home for it than a
 * worktree that gets deleted.
 */
export function testUnlockTargets(run: { projectDir?: string }, workdir: string): string[] {
  return [workdir]
}

async function unlockTests(run: WorkflowRun, label: string, workdir: string): Promise<void> {
  const body = JSON.stringify({ reason: `The "${label}" step of ${run.workflowName} writes tests and code together by design.`, run: run.id, step: label, at: new Date().toISOString() }, null, 2)
  // The hook reads the unlock relative to the directory the agent is in, so the
  // step's own workdir is the one that decides whether it may edit tests. When
  // that workdir is a lane, the run's worktree gets a copy too: the lane is
  // removed once its wave merges, and the unlock is also the evidence that this
  // step was allowed to touch tests and why. Losing that with the lane would
  // leave the reason nowhere on the record.
  // The reason is recorded with the run's evidence AS THE GRANT IS MADE, not
  // when it is withdrawn. A lane's worktree is removed once its wave merges,
  // taking the unlock file with it - so a copy made at teardown finds nothing,
  // and the justification for touching tests would exist nowhere. That is the
  // need the old copy-into-the-shared-worktree served, without making the
  // shared directory a channel between concurrent lanes.
  try {
    await mkdir(runArtifactsDir(run.id), { recursive: true })
    await writeFile(join(runArtifactsDir(run.id), 'test-unlock.json'), body)
  } catch { /* evidence is best effort; the grant below is what the step needs */ }

  for (const target of testUnlockTargets(run, workdir)) {
    const dir = join(target, '.agent')
    try {
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'test-unlock.json')
      await writeFile(path, body)
      // Remembered ON THE RECORD, not in memory: the capability has to be
      // withdrawn even if this process dies and another one finishes the run.
      if (!run.testUnlocks?.includes(path)) run.testUnlocks = [...(run.testUnlocks ?? []), path]
    } catch (err) {
      log.warn('could not write the test unlock; the plugin lock will stop the step at its first test edit', { runId: run.id, dir, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * Withdraws the permission to edit tests when the run that earned it ends.
 *
 * The unlock was written into the checkout and nothing ever removed it, so
 * every later agent working in that checkout inherited it - a capability
 * granted to one step, for one reason, held forever afterwards. The lock only
 * means something if it comes back.
 *
 * Only files this run wrote are removed, checked by the run id inside them: a
 * lane's checkout can be shared, and deleting someone else's unlock would
 * silently stop their step at its first test edit.
 */
async function withdrawTestUnlocks(run: WorkflowRun): Promise<void> {
  for (const path of run.testUnlocks ?? []) {
    try {
      const body = await readFile(path, 'utf-8')
      const owner = JSON.parse(body)?.run
      if (owner && owner !== run.id) continue
      // Only the permission is withdrawn. The reason was already written to the
      // run's evidence when the grant was made, which is the only moment it is
      // certain to still exist: a lane worktree may be gone by now.
      await rm(path, { force: true })
    } catch { /* already gone, or a lane removed with its worktree */ }
  }
  run.testUnlocks = []
}

/**
 * What this step is allowed to do with tests, in its own input.
 *
 * Exactly one step of a workflow owns the tests, and the plugin's lock enforces
 * that - but nothing ever TOLD the other steps. Run a3cb9d37 died of it: the
 * client lane's agent wrote a new spec file in a step that does not own tests,
 * the lock fired correctly, and its finished work sat staged and uncommitted
 * while the run spent another twenty minutes reaching a monitor that aborted.
 *
 * A rule an agent is not told is a rule it discovers by being stopped halfway
 * through committing. So the step that owns the tests is told it does, and
 * every other step is told which step does and what to do instead - report the
 * gap, never write the test. Silent when no step owns them, because then there
 * is no rule to state and a false prohibition teaches agents to ignore the
 * real ones.
 */
function testOwnershipNote(l: Live, step: { label: string, testsUnlocked?: boolean }): string {
  const owner = l.workflow.steps.find(s => s.testsUnlocked === true)
  if (!owner) return ''
  if (step.testsUnlocked === true) {
    return `This step owns the tests for this run: you may add and edit test files here, and the runner has written the unlock that permits it. No other step may.`
  }
  return `"${owner.label}" owns the tests for this run; this step does not. Do not add or edit any test file here - `
    + 'the lock will stop the commit, and work that cannot be committed is work nobody gets. '
    + `If you find a case that needs covering, say so in your result and name it, so "${owner.label}" or a person can add it.`
}

/**
 * Drive deploy.sh for a step that declared a deploy.
 *
 * The gate is the step's own: only `dev` runs unattended, and any other
 * environment needs this step to carry `approval: true` and for that gate to
 * have been answered. `l.approved` holds exactly that - the ids whose gate a
 * person has released - so a template that declares a prod deploy without a
 * gate gets nothing executed and a step told why.
 *
 * Never throws: a deploy that cannot run is a fact the agent needs, not a
 * reason to kill the run.
 */
async function runDeployForStep(
  l: Live, run: WorkflowRun, rec: RunStep, id: string, step: { deploy?: { env: string, step: string, app?: string, limit?: string, check?: boolean }, approval?: boolean },
): Promise<string> {
  const want = step.deploy!
  try {
    const plan = await planDeploy({ env: want.env, step: want.step, app: want.app, limit: want.limit, check: want.check })
    // The answered gate, from the runner's own record of what a person
    // released. Not from the step's declaration, which is what an author
    // intended rather than what a person decided.
    const approved = step.approval === true && l.approved.has(id)
    const result = await runDeploy(plan, { approved, approvedBy: approved ? (run.decisions?.at(-1)?.by ?? 'a gate answer') : undefined })
    for (const line of result.ran) logLine(l, run, rec, line)
    logLine(l, run, rec, result.summary)
    return result.ok
      ? result.summary
      : `${result.summary} Do not run deploy.sh yourself - report what you could not verify without it.`
  } catch (err) {
    const why = err instanceof DeployError ? err.message : `The deploy could not be planned: ${err instanceof Error ? err.message : String(err)}`
    logLine(l, run, rec, why)
    return why
  }
}

/**
 * What a money- or protocol-class run owes the evidence bundle, in the agent's
 * own input.
 *
 * The schema has always required an `adversarial` object for these two classes,
 * and nothing ever asked for one - the requirement could not even fire until
 * classification began writing `blast_radius`. The runner deliberately does not
 * write it: a two-node rerun, an adversarial pattern search and a mutation
 * score are work, and a runner filling in a plausible object would be
 * manufacturing evidence rather than collecting it.
 *
 * Empty for every other class. A demand that does not apply teaches an agent to
 * ignore the ones that do.
 */
function adversarialDemand(run: WorkflowRun): string {
  if (run.blastRadius !== 'money' && run.blastRadius !== 'protocol') return ''
  return `\n\nEVIDENCE THIS RUN OWES: it is classified \`${run.blastRadius}\`, and the evidence bundle requires an `
    + '`adversarial` object in meta.json for that class. Write it yourself into meta.json with these fields: '
    + '`report` (what you attacked and what held), `two_node_rerun` (boolean - did the failing case rerun on a second node), '
    + '`pattern_search` (what you searched the codebase for, e.g. other unguarded call sites of the same shape) and '
    + '`mutation_score` (0-1, or null if you did not measure one). '
    + 'The runner will not write this for you: it is verification work, and an invented report is worse than an absent one. '
    + 'A bundle without it fails validation.\n'
}

/**
 * Start the product's stack for a step that declared it needs one.
 *
 * Failure is reported into the step's own output rather than thrown: a stack
 * that cannot start is a fact the step's agent has to know about - and for a
 * run with no registered stack, no command is invented at all.
 */
async function bringStackUp(l: Live, run: WorkflowRun, rec: RunStep): Promise<string> {
  const compose = run.product?.stack?.compose
  if (!compose) {
    const note = 'This step asked for a stack, and this run has no product with a registered stack - '
      + 'nothing was started. Work without one; do not try to start a stack yourself.'
    logLine(l, run, rec, note)
    return note
  }
  try {
    const recipe = await resolveStackRecipe({ compose })
    const result = await stackUp(recipe, { runId: run.id })
    for (const line of result.ran) logLine(l, run, rec, line)
    logLine(l, run, rec, result.summary)
    if (result.ok) {
      // On the RUN, not on Live: a server that dies mid-run must still be able
      // to find what it started, or the containers are nobody's.
      run.stackStarted = recipe.product
      run.stackStopped = undefined
    }
    return result.ok
      ? `${result.summary} The runner started it and will take it down when this run settles; you do not need to.`
      : `${result.summary} Do not try to start it yourself - report what you could not verify without it.`
  } catch (err) {
    // A StackError already explains itself in the terms a person needs: which
    // file was looked for, or that .env is a human's job.
    const note = err instanceof StackError
      ? err.message
      : `The stack could not be started: ${err instanceof Error ? err.message : String(err)}`
    logLine(l, run, rec, note)
    return note
  }
}

/**
 * Record what this step's output and diff say about how risky the run is.
 *
 * Never throws and never fails the step: a classification that cannot be
 * computed leaves the run unclassified, which oversight.ts already treats as
 * `stop`. Failing here would turn a git hiccup into a dead run while making the
 * gate no safer.
 */
/**
 * The question to pause on when a step changed a repository this run does not
 * own, or null when everything landed where it should.
 *
 * Asked once per run: a person who has been told and continued has decided, and
 * re-asking at every subsequent step would turn a decision into a nag. The
 * allowed set is everywhere a run may legitimately reach — its own lanes, the
 * products a step widened it to, and the deployment checkout its stack comes
 * from — so the widening feature does not read as an alarm.
 */
async function detectStrayWork(l: Live, run: WorkflowRun, stepId: string): Promise<string | null> {
  if (!run.projectDir || run.strayWorkAsked) return null
  let entries
  try {
    const { readCommandLedger } = await import('./commandLedger.ts')
    entries = await readCommandLedger(run.id)
  } catch {
    return null // no ledger, nothing to say — never a reason to stop a run
  }
  if (!entries.length) return null
  const { strayWork } = await import('./commandLedger.ts')
  const allowed = [
    ...Object.values(l.laneDirs),
    ...(run.product?.alsoInScope ?? []).flatMap(p => p.repos.map(r => checkoutDirFor(r, run.startedBy))),
    ...(run.product?.stack?.compose ? [checkoutDirFor(`alepolab/${run.product.stack.compose.split('/')[0]}`, run.startedBy)] : []),
    runArtifactsDir(run.id),
    getClaudeDir(),
  ]
  const stray = strayWork(entries.filter(e => e.stepId === stepId), run.projectDir, allowed)
  if (!stray.length) return null
  run.strayWorkAsked = true
  return [
    `This run changed a repository it was not launched against.`,
    ...stray.map(s => `  ${s.dir} — ${s.what}`),
    ``,
    `It is registered against ${run.product?.name ?? 'no product'}${run.product?.repos?.length ? ` (${run.product.repos.join(', ')})` : ''} and its checkout is ${run.projectDir}.`,
    `Work done anywhere else cannot reach origin from this run: its branch, its pull request and its evidence all belong to the checkout above.`,
    ``,
    `Continue only if that is deliberate — otherwise stop this run and start one against the product that owns the code.`,
  ].join('\n')
}

async function adoptClassification(
  l: Live, run: WorkflowRun, rec: RunStep, output: string, cwd: string | undefined, headBefore: string | null,
): Promise<void> {
  const proposed = parseProposal(output)
  let floor: BlastRadius | null = null
  // Did the risk read actually run? Starts false, so a path that never reaches
  // the read (no checkout, no baseline, a throw) is treated as "not assessed"
  // rather than as assessed-and-clean.
  let riskRead = false
  if (cwd) {
    // Against the run's own baseline, not the step's: the class describes the
    // whole change a reviewer will be asked to approve, and a migration written
    // three steps ago still makes this run a schema change.
    const since = run.baseCommit ?? headBefore
    if (since) {
      try {
        const paths = await changedPathsSince(cwd, since)
        floor = floorFrom(paths)
        // What the paths MEAN, where their shape proves nothing — money
        // arithmetic lives in ordinary Java, which no path rule can catch. The
        // stronger of the two wins, so this can only ever raise oversight; if
        // the model is unavailable the rules floor stands exactly as before.
        const { agentFloorFrom } = await import('./lightAgent.ts')
        const read = await agentFloorFrom(paths)
        // Whether the read HAPPENED, kept apart from what it said. An
        // unavailable model must not read as a clean bill of health.
        riskRead = read.read
        if (read.class && (BLAST_RADIUS_ORDER as string[]).includes(read.class)) {
          const asClass = read.class as BlastRadius
          if (!floor || BLAST_RADIUS_ORDER.indexOf(asClass) > BLAST_RADIUS_ORDER.indexOf(floor)) {
            logLine(l, run, rec, `a light read of the touched files raises the risk floor to \`${asClass}\`; the path rules alone said ${floor ?? 'nothing'}`)
            floor = asClass
          }
        }
      } catch (err) {
        logLine(l, run, rec, `could not read the diff to classify this run: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (proposed === null && floor === null) return

  // A LOW class can only ever come from an agent's own proposal: floorFrom
  // never asserts one, by design, because path evidence cannot rule danger
  // out. So `docs` and `ui_parsing` rest entirely on the claim of the party
  // the classification governs — and they are exactly the two classes that
  // buy `auto`, which skips every gate in the run.
  //
  // That is acceptable only while the risk read is actually running: it is
  // the one check that can look at ordinary Java and notice the money
  // arithmetic no path rule can see. When it did NOT run, the low claim is
  // uncorroborated by anything, and adopting it would let a model outage
  // silently switch the pipeline's human oversight off.
  //
  // So leave the run unclassified instead. That is not a new policy — it
  // reuses the one already written into oversight.ts: an unclassified run
  // stops, because absence of evidence is not evidence of safety.
  const LOW: BlastRadius[] = ['docs', 'ui_parsing']
  if (!riskRead && floor === null && proposed !== null && LOW.includes(proposed)) {
    logLine(l, run, rec,
      `this step proposed \`${proposed}\`, but the risk read did not run and no path rule corroborates it; `
      + 'leaving the run unclassified so its gates stop for a person rather than accepting an unchecked low class')
    log.warn('low class proposed with no risk read; left unclassified', { runId: run.id, stepId: rec.stepId, proposed })
    return
  }

  // An adopted class is a floor of its own from here on. A later step may raise
  // the run's risk - it may discover the money path - but nothing may lower what
  // the evidence already established.
  const result = adopt({ proposed, floor })
  if (!result.adopted) return

  const held = (run.blastRadius && (BLAST_RADIUS_ORDER as string[]).includes(run.blastRadius))
    ? run.blastRadius as BlastRadius
    : null
  // Already at least this risky: keep what the evidence established. A later
  // step may RAISE the run's risk - it may discover the money path - but nothing
  // lowers it, including a step that re-reads a smaller part of the change.
  if (held && BLAST_RADIUS_ORDER.indexOf(held) >= BLAST_RADIUS_ORDER.indexOf(result.adopted)) return

  run.blastRadius = result.adopted
  run.classSource = result.source ?? undefined
  logLine(l, run, rec, classProvenance(result))
  await recordClassification(run.id, { blast_radius: result.adopted, class_source: result.source ?? undefined })
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
  // Where this step's agent actually works: its own lane when the wave runs more
  // than one step, else the run's worktree. Everything below uses `cwd` rather
  // than run.projectDir, so the agent, the header it is given and the record all
  // name the same directory - a header promising the run worktree while the
  // agent ran in a lane is how the last worktree bug read from the outside.
  const cwd = l.laneDirs[id] ?? run.projectDir
  if (step.testsUnlocked && cwd) await unlockTests(run, step.label, cwd)
  // The commit this step starts from, so the test lock below can read what the
  // step itself changed rather than everything the run has done so far.
  const headBefore = cwd ? await headOf(cwd) : null

  // Bring the product's stack up before the agent runs, because a step that
  // needs a stack cannot do anything without one. The lifecycle is read out of
  // the product's own compose file, so the runner asks the infra repo how to
  // start it rather than an agent guessing - and the stack is taken down when
  // the run settles, in publish(), including when it fails.
  const stackNote = step.stack === 'up' ? await bringStackUp(l, run, rec) : ''
  const deployNote = step.deploy ? await runDeployForStep(l, run, rec, id, step) : ''

  // Hand this step the review its own pull request collected. Written BEFORE the
  // agent starts, because an agent cannot act on evidence that appears after it
  // finishes - which is the whole reason review comments on three real pull
  // requests went unanswered until a person noticed them.
  //
  // Never fatal: a run whose review cannot be read should still run its step and
  // say so, rather than failing over a reviewer's availability.
  if (step.reviewComments) {
    try {
      const prUrls = await prUrlsOf(run)
      const collected = await collectReviewComments(run, { prUrls })
      const actionable = collected.prs.reduce((n, p) => n + p.counts.actionable, 0)
      const waiting = collected.prs.filter(p => !p.review.ready).map(p => `${p.repo}#${p.number}: ${p.review.why}`)
      logLine(l, run, rec, prUrls.length
        ? `review-comments.json written: ${actionable} actionable comment(s) across ${collected.prs.length} pull request(s)`
        : 'review-comments.json written: this run recorded no pull request, so there is no review to read')
      for (const w of waiting) logLine(l, run, rec, `review not ready - ${w}`)
    } catch (err) {
      logLine(l, run, rec, `could not collect review comments: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // A visit that continues the previous session needs no header: that session
  // already has it, and re-sending it invites the model to start over.
  const resume = l.resumeFrom[id] ?? inheritedSession(l, run, id)
  delete l.resumeFrom[id]
  // The stack outcome is part of what this step is working with, so it goes to
  // the agent rather than only into the run log - including on a resumed visit,
  // where the header is skipped but the stack may have changed since.
  const stackContext = stackNote ? `\n\nSTACK: ${stackNote}\n` : ''
  const testsContext = testOwnershipNote(l, step) ? `\n\nTESTS: ${testOwnershipNote(l, step)}\n` : ''
  // A verdict step is told the contract it is held to. Enforcing a format the
  // agent was never given would be a trap; every reviewer in the estate already
  // opens with this line, and now it decides whether the run continues.
  const verdictContext = step.verdict
    ? '\n\nVERDICT: this step owns the decision. Open your output with exactly one line — `Review Result: PASS`, `Review Result: WARNING` or `Review Result: FAIL` — before anything else. FAIL stops the run and nothing is shipped; WARNING continues and is recorded. State no verdict and the run stops: silence is not approval.\n'
    : ''
  const deployContext = deployNote ? `\n\nDEPLOY: ${deployNote}\n` : ''
  // What this run's risk class obliges it to produce. Told while the step can
  // still do the work: finding out at finalize, or from a CI validation
  // failure, is finding out too late - a two-node rerun and a pattern search
  // cannot be done retroactively.
  const classContext = adversarialDemand(run)
  const input = stackContext + testsContext + verdictContext + deployContext + classContext + (resume ? body : artifactHeader(runArtifactsDir(run.id), run.product, run.startedBy, run.id, cwd ? {
    dir: cwd, branch: l.laneBranches[id] ?? run.branch,
    ...(run.branch && run.baseBranch ? { policy: describeBranchChoice(run.branch, baseBranchFor(run.workType, run.origin, run.product?.branches)) } : {}),
  } : undefined) + body)

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
  //
  // `jira.after` opts out of that: the step has real agent work AND Jira work,
  // so the agent runs first and the REST calls follow below. Without it this
  // branch returned before the agent ran at all - which is how a step labelled
  // "Evidence, Docs & Pull Request" completed successfully having assembled no
  // evidence, written no docs and opened no pull request, its entire output
  // three sentences about Jira.
  if (step.jira && !step.jira.after) {
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

  const ac = new AbortController()
  l.aborts.set(id, ac)
  // A step that hangs used to run until the process died. SBN-4091 spent 19.8
  // hours against a 180-minute cap with 23 minutes of agent work inside it,
  // because the budget is only read BETWEEN steps and this step never returned
  // to be between anything. The watchdog is the run's own remaining time, armed
  // on the controller stopRun already uses, so a hung step ends the way an
  // operator stop does rather than by outliving everyone's attention.
  const leftMs = Math.max(60_000, (run.budget.maxMinutes - runElapsedMinutes(run)) * 60_000)
  let watchdogFired = false
  const watchdog = setTimeout(() => { watchdogFired = true; ac.abort() }, leftMs)
  // Never hold the process open on this timer alone.
  if (typeof watchdog.unref === 'function') watchdog.unref()
  try {
    // The product's own toolchain, last so a registry pin wins over whatever
    // the host's PATH would have given the agent. See ProductMatch.toolchain.
    const userEnv = { ...await envResolver(run.startedBy).catch(() => ({})), ...(run.product?.toolchain ?? {}) }
    logLine(l, run, rec, `step started, visit ${rec.visits}`)
    const raw = await agentCaller(step.agentSlug, input, cwd, { signal: ac.signal, env: userEnv, ...(resume ? { resume } : {}), onSteer: (deliver) => { l.steer.set(id, deliver) }, onSession: (sessionId, cwd) => {
      // The transcript is a normal Claude Code session, so it is readable on /cli;
      // named after the run so it is findable there among the developer's own.
      // Claude Code names the transcript folder by replacing every non-alphanumeric
      // character of the working directory with '-' (verified against ~/.claude/projects).
      Object.assign(rec, { sessionId, sessionProject: cwd.replace(/[^A-Za-z0-9]/g, '-') })
      void publish(run)
      // Loaded on demand: that module's extension-less imports do not resolve under the plain-node tests.
      void import('./claudeCodeHistory.ts').then(m => m.setSessionName(sessionId, `${run.ticketKey ?? run.workflowSlug} · ${step.label} · run ${run.id.slice(0, 8)}`)).catch(() => {})
    }, onProgress: (progress: AgentProgress) => {
      if (progress.line) { logLine(l, run, rec, progress.line, progress.lineKind); return }
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

    // Work that landed somewhere this run does not own — checked before the
    // step's own markers, because a step that changed the wrong repository has
    // a bigger problem than whatever it wants to say next. Paused, not failed:
    // the honest answers are "widen the run" or "stop and re-run against the
    // right product", and both are a person's call. See strayWork.
    const stray = await detectStrayWork(l, run, id)
    if (stray) {
      l.outputs[id] = output
      Object.assign(rec, { status: 'waiting', output, model, usage })
      run.question = { stepId: id, text: stray, kind: 'question', askedAt: Date.now() }
      l.waiting = id
      logLine(l, run, rec, stray)
      log.warn('run changed a repository it was not launched against', { runId: run.id, stepId: id })
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

    // A REVIEW step's own answer, enforced.
    //
    // Five consecutive runs opened a pull request over their reviewer's
    // explicit refusal. CSUP-7524's QA step said "Review Result: FAIL — 2
    // CRITICAL" and "the client commit doesn't exist"; three steps later the
    // run opened three pull requests and finished `completed`. CSUP-7526,
    // CSUP-7514, CSUP-7519 and SBN-4091 are the same shape. The verdict was
    // never hidden — it was the first line of the step's output — but the only
    // enforceable outcomes were markers (halt, rework) the reviewers do not
    // emit, and an `approval` gate, which asks a PERSON and therefore does
    // nothing on a run classified `auto` or approved in a hurry.
    //
    // So the step's stated verdict IS the gate, checked before `step.pr` below:
    // a refused change must not reach the code that opens a pull request.
    //
    // A missing verdict fails too, and that asymmetry is deliberate. The
    // monitor path already defaults an unreadable answer to CONTINUE
    // (parseVerdict), and treating silence as consent is exactly how a FAIL
    // came to ship. A step that declared PIPELINE-SKIP is exempt: it examined
    // its job and found nothing to judge.
    // What this step decided, for its conditional out-edges to be judged
    // against. Undefined on a step that decides nothing, in which case every
    // out-edge is unconditional and this changes nothing.
    let stepOutcome: StepOutcome | undefined
    if (step.verdict && !skip) {
      const verdict = parseReviewVerdict(output)
      // Stating nothing is a format slip, not a refusal, so it gets the same
      // second chance the monitor gives a RETRY: ask again, with the contract
      // repeated, while the step still has a visit. Only then does silence
      // stop the run. An explicit FAIL is never retried — the reviewer said
      // what it meant, and re-asking until it relents is not oversight.
      if (!verdict && canRevisit(l.graph, l.state, id)) {
        try {
          await writeStepArtifact(run, rec, run.steps.indexOf(rec), `no-verdict-${rec.visits}`)
        } catch { /* best effort */ }
        l.retryFeedback[id] = 'You did not state a verdict. Reply again, and open with exactly one line: `Review Result: PASS`, `Review Result: WARNING` or `Review Result: FAIL`.'
        run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId: id, reason: 'the review step stated no verdict and was asked again' }]
        l.state.status[id] = 'completed'
        armNode(l.state, id)
        log.warn('review step stated no verdict; asking again', { runId: run.id, stepId: id, visits: rec.visits })
        return true
      }
      // A declared FAIL route turns a refusal into a PATH instead of the end
      // of the run. Without one, a `verdict` step that says FAIL has nowhere
      // to send the work, so stopping is the only honest thing left — which is
      // what this did for every workflow before conditional edges existed, and
      // still does for every workflow that declares no such edge.
      const failRoute = verdict === 'FAIL'
        && (l.graph.succ[id] ?? []).some(t => l.graph.conditions[edgeKey(id, t)] === 'fail')
      if (failRoute) {
        stepOutcome = 'fail'
        l.outputs[id] = output
        Object.assign(rec, { status: 'completed', output, model, usage, completedAt: Date.now() })
        markCompleted(l.graph, l.state, id, 'fail')
        const went = (l.graph.succ[id] ?? [])
          .filter(t => l.state.edges[edgeKey(id, t)])
          .map(t => l.workflow.steps.find(x => x.id === t)?.label ?? t)
        logLine(l, run, rec, `review verdict FAIL — routed to ${went.join(', ') || 'nothing'}`)
        log.info('review step routed on FAIL', () => ({ runId: run.id, stepId: id, to: went }))
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return true
      }
      if (verdict === 'PASS' || verdict === 'WARNING') stepOutcome = 'pass'
      if (verdict !== 'PASS' && verdict !== 'WARNING') {
        const reason = verdict === 'FAIL'
          ? `Review verdict FAIL — ${preview(output)}`
          : `This step owns a verdict and stated none. It must open with "Review Result: PASS", "WARNING" or "FAIL"; the run stops rather than read silence as approval.`
        markFailed(l.state, id)
        Object.assign(rec, { status: 'failed', output, model, usage, error: reason, completedAt: Date.now() })
        log.warn('review step refused the work', () => ({
          runId: run.id, stepId: id, agentSlug: step.agentSlug, verdict: verdict ?? 'none', durationMs,
        }))
        logLine(l, run, rec, reason)
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      }
      logLine(l, run, rec, `review verdict: ${verdict}`)
    }

    // The pull request, BEFORE the Jira half below, so the outcome comment can
    // carry a URL the runner has actually got. A step declaring `pr` gets this
    // whether or not its agent mentioned a pull request - which is the point:
    // the step labelled "Evidence, Docs & Pull Request" completed nine times
    // over without opening one, because no agent in the estate opens PRs.
    let prLines: string[] = []
    if (step.pr && !skip) {
      const { runPrStep } = await import('./prStep.ts')
      const { recordPrUrls } = await import('./runArtifacts.ts')
      try {
        const result = await runPrStep(run)
        prLines = result.lines
        await recordPrUrls(run.id, result.prs)
        // A refused pull request FAILS the step. It used to be one line among
        // ten, which is how "no pull request was opened" came to read as a
        // detail rather than as the run not having shipped — and why two runs
        // whose build had failed still finished `completed`.
        if (result.refused?.length) {
          const reason = result.refused.map(r => `${r.repo}: ${r.reason}`).join('\n')
          markFailed(l.state, id)
          Object.assign(rec, { status: 'failed', output, model, usage, error: `Pull request refused — ${reason}`, completedAt: Date.now() })
          for (const line of prLines) logLine(l, run, rec, line)
          log.warn('pull request refused for lack of execution evidence', { runId: run.id, stepId: id, repos: result.refused.map(r => r.repo) })
          try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
          return false
        }
      } catch (err) {
        // Never fatal: the commits are already on the branch, and a step that
        // fails here would hide the work rather than ship it.
        prLines = [`Pull request step failed: ${err instanceof Error ? err.message : String(err)}. The commits are on ${run.branch ?? 'the run branch'}.`]
      }
      for (const line of prLines) logLine(l, run, rec, line)
    }

    // The Jira half of an `after` step, once the agent's half has succeeded.
    // This order is the point: the outcome comment reads the pull request URLs
    // the agent has just reported, so running Jira first would post a comment
    // about work that had not happened yet.
    let recorded = prLines.length ? `${output}\n\n${prLines.join('\n')}` : output
    if (step.jira?.after && !skip) {
      let jiraOut: string
      try {
        jiraOut = await runJiraStep(run, step.jira)
      } catch (err) {
        jiraOut = `Jira step failed: ${err instanceof Error ? err.message : String(err)}. The ticket was not changed; the run goes on.`
      }
      // A Jira skip - no ticket on this run - must not skip the STEP, whose
      // agent just did the work. The sentinel is rendered as a plain sentence
      // so parseSkip cannot see it downstream either.
      const note = jiraOut.startsWith('PIPELINE-SKIP:')
        ? jiraOut.replace(/^PIPELINE-SKIP:\s*/, 'Jira: ')
        : jiraOut
      for (const line of note.split('\n')) logLine(l, run, rec, line)
      recorded = `${recorded}\n\n${note}`
    }

    // What this step says it left undone, carried on the record where the
    // summary, the evidence and a reviewer can all read it.
    const notDone = parseNotDone(output)
    if (notDone.length) {
      run.notDone = [...(run.notDone ?? []).filter(e => e.stepId !== id), ...notDone.map(e => ({ ...e, stepId: id, label: rec.label }))]
      for (const e of notDone) logLine(l, run, rec, `not done: ${e.what} — ${e.why}`)
    }
    l.outputs[id] = recorded
    Object.assign(rec, {
      status: skip ? 'skipped' : 'completed',
      output: recorded, model, usage, completedAt: Date.now(),
      ...(skip ? { skipReason: skip } : {}),
    })
    log.info(skip ? 'step skipped itself' : 'step completed', () => ({
      runId: run.id, stepId: id, agentSlug: step.agentSlug, model,
      ...(skip ? { skipReason: preview(skip) } : {}),
      outputLength: output.length, durationMs,
      inputTokens: usage?.input_tokens ?? '(none reported)', outputTokens: usage?.output_tokens ?? '(none reported)',
    }))

    // THE CLASSIFICATION. oversight.ts decides whether a gate fires purely from
    // run.blastRadius, and nothing ever wrote it: every run read as
    // unclassified, so every gate stopped and the tiering never tiered.
    //
    // Runner-owned, like identity and watch, because a value the classified
    // party can set is not a control: a step wanting to skip a gate has every
    // incentive to call its change ui_parsing. The step's PIPELINE-CLASS line is
    // a PROPOSAL; the floor derived from the paths it actually touched can only
    // ever raise it, and an already-adopted class is never lowered on a later
    // visit.
    await adoptClassification(l, run, rec, output, cwd, headBefore)

    // THE TEST LOCK. The step that owns the tests may write them; every other
    // step editing a test invalidates the evidence chain of the whole run - "A
    // modified test file is never a pass, and no amount of subsequent green
    // recovers it" (.agents/workflows/runbook-a/resources/phase-gates.md). The
    // unlock file alone never enforced this, because nothing read the diff.
    //
    // Checked before the monitor, deliberately: a monitor reviewing an output
    // whose tests were softened is reviewing a fiction, and it would vote on
    // prose while the diff underneath it is the actual verdict.
    if (cwd && headBefore) {
      const lock = await checkTestLock({ dir: cwd, since: headBefore, testsUnlocked: step.testsUnlocked })
      if (lock.indeterminate) {
        // Unknown is not a violation, and failing a step because git could not
        // be read would turn an environment fault into a defect report. It is
        // recorded so the gap is visible on the record rather than silent.
        logLine(l, run, rec, `test lock not verified: ${lock.why}`)
        log.warn('test lock could not be verified', { runId: run.id, stepId: id, why: lock.why })
      } else if (!lock.ok) {
        markFailed(l.state, id)
        const why = `This step modified ${lock.touched.length} test file(s) it does not own: ${lock.touched.join(', ')}. `
          + 'A modified test is never a pass - it invalidates the run\'s evidence chain, and no amount of subsequent green recovers it. '
          + 'Revert the test changes and fix the code the test judges, or declare the step testsUnlocked if writing tests is genuinely its job.'
        for (const line of why.split('\n')) logLine(l, run, rec, line)
        Object.assign(rec, { status: 'failed', output: recorded, model, usage, error: why, completedAt: Date.now() })
        log.warn('step broke the test lock', { runId: run.id, stepId: id, touched: lock.touched })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      } else if (lock.touched.length) {
        // The owning step's own test files, named on the record: the evidence
        // should say which oracle this run is judged against.
        logLine(l, run, rec, `tests written by this step: ${lock.touched.join(', ')}`)
      }
    }

    if (step.monitorSlug) {
      const { verdict, review } = await runMonitor(step, rec, input, output, run.projectDir, runArtifactsDir(run.id))
      if (verdict === 'ABORT') {
        markFailed(l.state, id)
        run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId: id, reason: `monitor aborted the step: ${preview(review)}` }]
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
        run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId: id, reason: `monitor asked for another attempt: ${preview(review)}` }]
        l.state.status[id] = 'completed'
        armNode(l.state, id)
        return true
      }
      // RETRY with no visit left. This used to fall through to markCompleted:
      // the step was recorded `monitorVerdict: 'RETRY'` and `status:
      // 'completed'` at the same time, its deficient output was published
      // downstream, and nothing said so — a reviewer's "do this again" read as
      // approval because the budget ran out. A monitor that refuses is a
      // refusal at the last visit exactly as much as at the first.
      if (verdict === 'RETRY') {
        markFailed(l.state, id)
        const node = l.graph.nodes.find(n => n.id === id)
        const spent = `after ${rec.visits} of ${node ? maxVisitsOf(node) : rec.visits} visit(s)`
        Object.assign(rec, {
          status: 'failed', model,
          error: `Monitor asked for another attempt ${spent} and there is none left: ${preview(review)}`,
        })
        log.warn('monitor retry had no visit left', { runId: run.id, stepId: id, visits: rec.visits })
        try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
        return false
      }
    }

    markCompleted(l.graph, l.state, id, stepOutcome)
    // Progress clears the interruption count: only CONSECUTIVE restarts with
    // nothing achieved in between are the loop worth pausing on. `restarts`
    // above is the durable record and is never cleared here.
    run.interruptions = 0
    try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
    return true
  } catch (err) {
    if (watchdogFired) {
      markFailed(l.state, id)
      const spent = Math.round(runElapsedMinutes(run))
      Object.assign(rec, {
        status: 'failed',
        error: `The step was stopped after the run's ${run.budget.maxMinutes}-minute budget ran out (${spent} min elapsed). It produced no result.`,
        completedAt: Date.now(),
      })
      run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId: id, reason: 'watchdog: the run ran out of time while this step was in flight' }]
      log.warn('step aborted by the run watchdog', { runId: run.id, stepId: id, minutes: spent })
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return false
    }
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
      run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId: id, reason: `the step hit its own ${err.subtype === 'error_max_turns' ? 'turn' : 'duration'} limit and was retried from its log tail` }]
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
    clearTimeout(watchdog)
    l.aborts.delete(id)
    l.steer.delete(id)
  }
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

  // The radius is normally recorded once, where the worktree is cut. But that
  // path early-returns for a run that already has its branch, so a run that was
  // restarted, resumed after the server died, or reworked back to an earlier
  // step never passes through it again — and would arrive here unclassified and
  // stop for a person even when its own meta.json says `docs`. Backfill at the
  // point the answer is actually needed, and only while it is still missing.
  if (run.blastRadius === undefined) {
    const late = await readClassification(run)
    if (late?.blast_radius) {
      run.blastRadius = late.blast_radius
      run.workType = run.workType ?? late.work_type
      run.origin = run.origin ?? late.origin
    }
  }

  // A step marked for approval is a point where a gate MAY fire; the run's own
  // blast radius decides whether it does. A docs or ui_parsing change flows
  // straight through the same runbook that stops hard on a money one, so
  // nobody learns to click approve without reading. See shared/utils/oversight.
  // Still-unclassified stays `stop`: absence of evidence is not evidence of safety.
  // A step may declare what KIND of question its gate asks. Story, spec and
  // security gates carry a floor, because the blast radius cannot answer "is
  // this the right thing?" or "does this expose anything?" — see
  // shared/utils/oversight.ts. A step with no `gateKind` tiers exactly as
  // before.
  const gate = wave.find(id => stepOf(l, id)?.approval && !l.approved.has(id)
    && oversightForGate(run.blastRadius, (stepOf(l, id) as { gateKind?: GateKind } | undefined)?.gateKind) !== 'auto')
  if (gate) {
    const label = stepOf(l, gate)?.label ?? gate
    const gateKind = (stepOf(l, gate) as { gateKind?: GateKind } | undefined)?.gateKind
    // Whose decision this is, from the step that declares it. A gate with no
    // `gateRole` stays everyone's, which is the old behaviour and the honest
    // default for a workflow that never said.
    const gateRole = (stepOf(l, gate) as { gateRole?: Role } | undefined)?.gateRole
    // What the gate can actually PROVE, resolved before the person is asked.
    // A gate screen that shows only the step's prose asks the reviewer to
    // re-derive trust in the diff, which is the work the pipeline was supposed
    // to remove. Never throws: a criterion that cannot be derived comes back
    // `blocked`, which is a refusal, not a pass.
    let criteria: Awaited<ReturnType<typeof criteriaForGate>> = []
    try {
      criteria = await criteriaForGate(run, run.projectDir)
    } catch (err) {
      log.warn('could not resolve gate criteria', { runId: run.id, error: String(err) })
    }
    run.question = {
      stepId: gate,
      // The step label and nothing else.
      //
      // This string used to carry the gate's owner and the oversight reason
      // concatenated onto it, and both are POLICY: identical on every row of
      // the same class. Three screens rendered it, so every approval in a
      // queue read the same for its first sixty characters, and the one fact
      // that distinguished two decisions — which change, and how dangerous —
      // was past the truncation. Both are already structured on the record
      // (`role`, `gateKind`, `oversight`, `blastRadius`); a consumer that
      // wants to explain the policy can compose it once, in a detail view,
      // rather than in every row.
      text: `Approve "${label}" to run it.`,
      ...(criteria.length ? { criteria } : {}),
      kind: 'approval',
      askedAt: Date.now(),
      ...(gateRole ? { role: gateRole } : {}),
      ...(gateKind ? { gateKind } : {}),
      // Snapshot WHY this gate stopped, not merely what the run is classified
      // as now. A later step may raise the class, and a reader then sees a
      // tier that disagrees with the reason the run is on their screen.
      // RunDecision already keeps its own blastRadius for exactly this reason.
      oversight: oversightForGate(run.blastRadius, gateKind),
      ...(run.blastRadius ? { blastRadius: run.blastRadius } : {}),
    }
    run.status = 'paused'
    run.currentStepIds = []
    run.nextStepIds = wave
    l.running = false
    log.info('run waits for approval', { runId: run.id, stepId: gate })
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

  // One worktree per concurrent step, cut before any of them starts.
  await openLanes(l, run, wave)

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

  // The wave is over: fold every lane's commits back into the run branch before
  // anything reads the checkout again. Done for a failed wave too, so a lane
  // that did complete beside a failing sibling keeps its work.
  const laneFailure = await closeLanes(l, run, wave)
  if (laneFailure) {
    skipPending(l.state)
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
    run.status = 'failed'
    run.error = laneFailure
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

  if (results.some(ok => !ok)) {
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

  if (isFinished(l.graph, l.state)) {
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

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
async function readClassification(run: WorkflowRun): Promise<{ work_type?: string, origin?: string, blast_radius?: string } | null> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    // `blast_radius` is read here because it is written here: intake merges all
    // three into the same meta.json (app/utils/templates.ts). This reader
    // declared it in its return type and then did not return it, so
    // `classified?.blast_radius` was `undefined` on every run ever recorded and
    // the entire risk-tier policy in shared/utils/oversight.ts never executed —
    // every approval step stopped, nothing was ever owner-gated, and
    // ApprovalNeedsReason could not be thrown. One absent key in one object
    // literal, and no test caught it: test-oversight.mjs exercises oversightFor()
    // in isolation and never asks whether anything populates its input.
    return meta && typeof meta === 'object'
      ? { work_type: meta.work_type, origin: meta.origin, blast_radius: meta.blast_radius }
      : null
  } catch { return null }
}

/**
 * Give every step of a parallel wave its own worktree, so two agents writing at
 * once cannot contend for one git index.
 *
 * Sequential on purpose: `worktree add` takes the repository's index lock, and
 * the whole reason lanes exist is that concurrent git in one checkout fails.
 *
 * A wave of one gets nothing - that step works in the run's worktree, exactly
 * as before lanes existed. Jira steps get nothing either: the runner makes REST
 * calls for them and no agent ever enters a directory.
 *
 * Best effort per lane: a lane that cannot be cut leaves that step in the run
 * worktree with a warning, which is the old behaviour rather than a dead run.
 */
async function openLanes(l: Live, run: WorkflowRun, wave: string[]): Promise<void> {
  if (wave.length < 2 || !run.projectDir || !run.branch) return
  for (const id of wave) {
    const step = stepOf(l, id)
    if (!step || step.jira) continue
    const laneBranch = laneBranchFor(run.branch, step.label)
    try {
      l.laneDirs[id] = await ensureLane(run.projectDir, laneBranch)
      l.laneBranches[id] = laneBranch
      const rec = recOf(run, id)
      if (rec) rec.worktree = l.laneDirs[id]
    } catch (err) {
      log.warn('could not cut a lane worktree; this step shares the run worktree with its wave', {
        runId: run.id, stepId: id, laneBranch, error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (Object.keys(l.laneBranches).length) {
    log.info('wave lanes ready', { runId: run.id, lanes: wave.map(id => l.laneBranches[id]).filter(Boolean) })
  }
}

/**
 * Merge every lane of a settled wave back into the run branch and remove it, so
 * the run branch holds all of the wave's work before the next step reads the
 * checkout - and so the pull request is cut from one branch, not several.
 *
 * Only lanes whose step COMPLETED are merged: a failed step's commits stay on
 * its lane branch rather than landing half-done work on the run branch, and the
 * branch is left in place so a person can look at it.
 *
 * A conflict is reported on the run and fails the wave. Two agents that edited
 * the same lines is a workflow whose lanes were not disjoint, and no automatic
 * resolution here could be trusted to keep both.
 */
/**
 * Write a lane's uncommitted work into the run's artifacts, and answer the
 * file name — or null when there was nothing to save, or saving failed.
 *
 * Best effort by design: the worktree is being kept regardless, so a failure
 * here loses nothing that was not already safe. It must never take the wave
 * down, which is the whole reason it swallows its own errors.
 */
async function saveLanePatch(run: WorkflowRun, stepId: string, laneDir: string | undefined): Promise<string | null> {
  try {
    const patch = await uncommittedPatch(laneDir)
    if (!patch) return null
    const name = `lane-uncommitted-${safeName(recOf(run, stepId)?.label ?? stepId)}.patch`
    await writeFile(join(runArtifactsDir(run.id), name), patch)
    return name
  } catch (err) {
    log.warn('could not save the lane patch', { runId: run.id, stepId, error: String(err) })
    return null
  }
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step'

async function closeLanes(l: Live, run: WorkflowRun, wave: string[]): Promise<string | null> {
  if (!run.projectDir) return null
  let failure: string | null = null
  for (const id of wave) {
    const laneBranch = l.laneBranches[id]
    if (!laneBranch) continue
    const rec = recOf(run, id)
    const laneDir = l.laneDirs[id]
    delete l.laneDirs[id]
    delete l.laneBranches[id]
    if (rec?.status !== 'completed') {
      log.warn('lane left unmerged: its step did not complete', { runId: run.id, stepId: id, laneBranch, status: rec?.status })
      continue
    }
    try {
      const said = await mergeLane(run.projectDir, laneBranch)
      log.info('lane merged', { runId: run.id, stepId: id, result: said })
      // `mergeLane` merges COMMITS. `removeLane` then runs `worktree remove
      // --force`, which deletes everything that was not one — and run a3cb9d37
      // lost its client fix exactly here, "staged and uncommitted", 566
      // insertions across 5 files, with no error and no log line. So the lane
      // is measured before it is destroyed, and a dirty one is kept: a
      // worktree left behind is noise, and the alternative is deleting work
      // nobody can recover.
      // `null` is NOT "clean": workingTreeDirty answers null when it could not
      // measure at all — no directory, not a worktree, or `git status` itself
      // failed (a locked or corrupted index, a permission error). Reading that
      // as clean would delete an unmeasured worktree, which is the same loss
      // through a different door, so only a positive measurement of nothing
      // permits the removal.
      const left = await workingTreeDirty(laneDir)
      if (left === null || left.length) {
        // A copy in the run's evidence, before anything else. Keeping the
        // worktree protects the work from this code; the patch protects it from
        // the next person to run `worktree remove --force` by hand, which is
        // what the message below tells them to do. SBN-4091's frontend fix was
        // recovered from exactly this kind of artifact and from nothing else.
        const saved = await saveLanePatch(run, id, laneDir)
        rec.laneKept = left === null
          ? `${laneBranch}: its worktree at ${laneDir} could not be checked for uncommitted work, so it was kept. Look before you remove it: git -C ${run.projectDir} worktree remove ${laneDir}`
          : `${laneBranch}: ${left.length} uncommitted file(s) left in ${laneDir}. They are NOT in the run branch — commit them there or copy them out, then: git -C ${run.projectDir} worktree remove --force ${laneDir}`
        if (saved) rec.laneKept += ` A copy of the uncommitted work is in the run's artifacts as ${saved}.`
        log.warn('lane kept: its worktree still holds uncommitted work', {
          runId: run.id, stepId: id, laneBranch, uncommitted: left?.length ?? 'unmeasurable', laneDir,
        })
        logLine(l, run, rec, rec.laneKept)
        continue
      }
      await removeLane(run.projectDir, laneBranch)
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      log.error('lane could not be merged', { runId: run.id, stepId: id, laneBranch, error: failure })
    }
  }
  return failure
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

  // Every run, every ticket: whatever is attached to the ticket comes down
  // into the worktree before any agent starts.
  //
  // A screenshot on a ticket is often the whole specification — the defect,
  // the layout, the error dialog — and it was unreachable. Agents have no
  // shell and no Jira access, and Jira's attachment URLs need the same
  // credentials the issue fetch needed, so a ticket whose description said
  // "see attached" handed the run nothing and said nothing about it either.
  //
  // Best effort, never fatal: a ticket with no attachments costs one field
  // that viewIssue already asks for, and an attachment that will not download
  // is reported in the log rather than failing a run over a file.
  if (run.ticketKey) {
    try {
      const issue = await viewIssue(run.ticketKey, await envResolver(run.startedBy))
      if (issue.attachments.length) {
        const { saved, failed } = await downloadAttachments(issue, run.projectDir, await envResolver(run.startedBy))
        if (saved.length) log.info('ticket attachments', { runId: run.id, ticket: run.ticketKey, saved: saved.map(s => s.filename) })
        if (failed.length) log.warn('ticket attachments could not be fetched', { runId: run.id, failed })
      }
    } catch (err) {
      log.warn('ticket attachments unavailable', { runId: run.id, ticket: run.ticketKey, error: err instanceof Error ? err.message : String(err) })
    }
  }
  run.workType = run.workType ?? classified?.work_type
  run.blastRadius = run.blastRadius ?? classified?.blast_radius
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
  // A ticket that already has a COMPLETED run is done until someone says
  // otherwise. A failed one is the ordinary retry path and is not blocked.
  // The escape hatch is an env var rather than a parameter because every entry
  // point - the API, a watch dispatch, the CLI, a test harness - reaches this
  // one function, and a per-caller flag is a flag somebody forgets to set.
  if (ticketKey && process.env.AGENT_ALLOW_DUPLICATE_TICKET_RUNS === '1') {
    // Loud, because an escape hatch nobody can see in the logs is how a test
    // setting ends up in a production environment and nothing says so.
    log.warn('duplicate-ticket guard bypassed by AGENT_ALLOW_DUPLICATE_TICKET_RUNS', { ticketKey })
  }
  if (ticketKey && !opts.rerunReason && process.env.AGENT_ALLOW_DUPLICATE_TICKET_RUNS !== '1') {
    const prior = await findRunForTicket(ticketKey)
    if (prior?.status === 'completed') {
      throw new Error(
        `${ticketKey} already has a completed run (${prior.id}${prior.branch ? `, branch ${prior.branch}` : ''}`
        + `${prior.endedAt ? `, finished ${new Date(prior.endedAt).toISOString().slice(0, 10)}` : ''}). `
        + 'Read what it produced before starting another: two runs on one ticket have already shipped two independent fixes in two codebases. '
        + 'Pass a rerun reason to start anyway, or set AGENT_ALLOW_DUPLICATE_TICKET_RUNS=1 on an instance that runs tickets repeatedly by design.',
      )
    }
  }
  // Captured BEFORE createRun, so the baseline is the project directory's
  // HEAD at the true moment execution begins — before any step, and so any
  // agent, has had a chance to touch it. See gitFacts.ts's captureBaseline
  // and shared/types/run.ts's WorkflowRun.baseCommit for why this can never
  // fall back to a guess: an absent baseline means computeFixFacts later
  // reports nothing, rather than diffing against a branch's shared base and
  // attributing that branch's whole history to this run.
  const baseCommit = await captureBaseline(projectDir)
  const run = await createRun({
    product,
    startedBy: opts.startedBy,
    workflowSlug: opts.workflow.slug,
    workflowName: opts.workflow.name,
    autoRun: opts.autoRun,
    initialPrompt: opts.initialPrompt,
    watch: opts.watch,
    ticketKey,
    projectDir,
    baseCommit,
    // Whether this workflow ships at all, snapshotted like the steps below: the
    // ship-integrity check must not fail a research workflow for opening no
    // pull request, and must not be talked out of failing one that does ship by
    // a template edited after the run started.
    expectsPr: opts.workflow.steps.some(s => s.pr === true),
    // The graph this run will actually execute, kept with the run. See
    // rehydrate: a boot reseed rewrites the definitions on disk, and a resume
    // five seconds later used to pick up the new one mid-run.
    workflowSnapshot: opts.workflow.steps,
    ...(opts.rerunReason ? { rerunReason: opts.rerunReason } : {}),
    // `ownerRole` is snapshotted with the rest: the run page must render whose
    // work a step is without loading the workflow, and a template edited after
    // this run started must not rewrite what this run's history says.
    steps: opts.workflow.steps.map(s => ({ stepId: s.id, label: s.label, agentSlug: s.agentSlug, ...(s.ownerRole ? { ownerRole: s.ownerRole } : {}) })),
  })
  await ensureRunCheckout(run)
  // Before the gate below, not after: a run that fails preflight is precisely
  // the one whose reason has to be readable afterwards, and the artifacts
  // directory is where the run page and the assembler look for it.
  try { await initRunArtifacts(run, opts.workflow.name) } catch { /* absence is the signal */ }

  // Everything an agent should never discover by spending its budget: the
  // compose file, the checkout, git as the agents will see it, docker, the
  // Jira statuses this workflow will ask for. Four real runs died on four
  // such things, each after twenty to sixty minutes of paid model work.
  run.preflight = await preflight(run, opts.workflow.steps)
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

  const graph = buildGraph(opts.workflow.steps)
  const l: Live = {
    workflow: opts.workflow, graph, state: initRunState(graph),
    outputs: {}, lastInputs: {}, retryFeedback: {}, resumeFrom: {}, stopped: false, running: false, aborts: new Map(), logs: {}, approved: new Set(), notes: {}, steer: new Map(), laneDirs: {}, laneBranches: {},
  }
  live.set(run.id, l)
  void driveToSettlement(l, run)
  return run
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
    // The counter resets on progress, which is right for deciding whether to
    // keep resuming and wrong as a record: 28 retries, restarts and aborts
    // happened across ten real runs and every one of their records reported
    // zero. The log below is append-only and never reset, so first-pass yield
    // and rework rate are answerable afterwards.
    run.restarts = [...(run.restarts ?? []), {
      at: Date.now(), bootId: BOOT_ID, stepId: frozen.stepId, reason: 'the previous process died mid-step',
    }]
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
/** Approving an owner-gated run without saying why. The route answers 400. */
export class ApprovalNeedsReason extends Error {}

export async function continueRun(runId: string, note?: string): Promise<WorkflowRun | null> {
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
    if (stored?.status !== 'paused') return stored
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
  if (!run || run.status !== 'paused') {
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
    // An owner-gated change is approved with a reason or not at all. Writing one
    // sentence is the cheapest defence against a gate decaying into a reflex:
    // it cannot be satisfied without having read something. Reject already
    // demanded a reason; approve did not, which had it backwards — saying yes to
    // a money change is the answer that needs the justification.
    if (run.question.reason !== 'budget' && needsJustification(run.blastRadius, run.question.gateKind) && !note?.trim()) {
      l.running = false
      throw new ApprovalNeedsReason(
        `This run is classified \`${run.blastRadius}\`, which is owner-gated: say in one line why this is right before approving.`)
    }
    if (run.question.reason === 'budget') extendBudget(run)
    else l.approved.add(run.question.stepId)
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
    for (const id of l.aborts.keys()) recordRestart(run, id, 'a person stopped the run while this step was in flight')
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
/**
 * The gates a person has already answered, from the durable record.
 *
 * This used to be an empty set, so a restart forgot every approval: the
 * resumed run raised the same gate at the same step and asked the same person
 * the same question again. The decisions were on the record the whole time -
 * `recordDecision` appends one for every answered gate - and nothing read them
 * back.
 *
 * Only `approved` counts. A rejection is not permission, and a rework decision
 * means the step is meant to run again with feedback, not to skip its gate.
 */
function approvalsFrom(run: WorkflowRun): Set<string> {
  return new Set((run.decisions ?? []).filter(d => d.verdict === 'approved').map(d => d.stepId))
}

async function rehydrate(run: WorkflowRun): Promise<Live> {
  const existing = live.get(run.id)
  if (existing) return existing
  // The run's OWN snapshot first. On boot the seeder rewrites the workflow
  // definitions on disk and interrupted runs resume five seconds later, so a
  // run interrupted at step 5 of the old graph would otherwise resume against
  // the new one — the definition changing under a run that is still inside it.
  // Falling back to disk keeps every run recorded before the snapshot existed
  // resumable.
  const workflow = run.workflowSnapshot
    ? { slug: run.workflowSlug, name: run.workflowName, steps: run.workflowSnapshot }
    : await loadWorkflowSteps(run.workflowSlug)
  if (!workflow) {
    throw new RestartError(409, `Workflow "${run.workflowSlug}" no longer exists, so this run cannot be rebuilt`)
  }
  const steps = alignStepIds(workflow.steps, run)
  const aligned = { ...workflow, steps }
  const graph = buildGraph(steps)
  const state = initRunState(graph)
  const l: Live = {
    workflow: aligned, graph, state, outputs: {}, lastInputs: {}, retryFeedback: {}, resumeFrom: {}, stopped: false, running: false, aborts: new Map(), logs: {}, approved: approvalsFrom(run), notes: {}, steer: new Map(), laneDirs: {}, laneBranches: {},
  }
  const header = artifactHeader(runArtifactsDir(run.id), undefined, undefined, run.id)
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
/** Appended by every path that ends an attempt; see WorkflowRun.restarts. */
function recordRestart(run: WorkflowRun, stepId: string, reason: string): void {
  run.restarts = [...(run.restarts ?? []), { at: Date.now(), bootId: BOOT_ID, stepId, reason }]
}

export async function restartRun(runId: string, stepId: string, note?: string, startedBy?: string, opts: { /** The runner itself hands a running run over (a widened run); the settled-status gate is the operator's, not its. */ fromRunner?: boolean } = {}): Promise<WorkflowRun> {
  const run = await getRun(runId)
  if (!run) throw new RestartError(404, 'Run not found')
  if (!run.steps.some(s => s.stepId === stepId)) throw new RestartError(400, `Unknown step "${stepId}"`)
  if (!opts.fromRunner && !RESTARTABLE.includes(run.status)) {
    throw new RestartError(409, `A ${run.status} run cannot be restarted; ${run.status === 'paused' ? 'continue it instead' : 'wait for it to settle'}`)
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
  recordRestart(run, stepId, note ? `an operator restarted from this step: ${note}` : 'an operator restarted from this step')
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
