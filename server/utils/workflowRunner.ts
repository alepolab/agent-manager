import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed,
  skipPending, isFinished, armNode, canRevisit, joinInputs, parseVerdict,
  monitorPrompt, MAX_CONCURRENCY, ancestorsOf,
  type WorkflowGraph, type RunState,
} from '../../shared/utils/workflowGraph.ts'   // relative, not an alias: the node
                                               // test scripts import this file
                                               // directly and cannot resolve ~~/
import { createRun, getRun, saveRun } from './workflowRunStore.ts'
import { callAgent } from './agentCaller.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

export type AgentCaller =
  (agentSlug: string, input: string, projectDir?: string) => Promise<string>

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
  steps: { id: string, agentSlug: string, label: string, next?: string[], monitorSlug?: string, maxVisits?: number, contextMode?: 'predecessors' | 'ancestors' }[]
}

export interface StartRunOpts {
  workflow: WorkflowLike
  initialPrompt: string
  autoRun: boolean
  projectDir?: string
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
  /** True while this run's wave loop is actually executing in the background - the
   *  re-entrancy guard for continueRun (C6). Set synchronously, before any await, so
   *  two "concurrent" calls can never both observe it false. */
  running: boolean
}
const live = new Map<string, Live>()
const subscribers = new Map<string, Set<(run: WorkflowRun) => void>>()

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

async function publish(run: WorkflowRun) {
  const prior = publishChains.get(run.id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(async () => {
    await saveRun(run)
    for (const fn of subscribers.get(run.id) ?? []) {
      try { fn(run) } catch { /* a broken subscriber must not stop the run */ }
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

function computeInput(l: Live, run: WorkflowRun, id: string, initialPrompt: string): string {
  const feedback = l.retryFeedback[id]
  if (feedback) {
    delete l.retryFeedback[id]
    return [
      l.lastInputs[id] ?? initialPrompt, '---', 'Your previous attempt:',
      l.outputs[id] ?? '', '---', 'Reviewer feedback:', feedback,
      'Revise your work and produce a corrected result.',
    ].join('\n\n')
  }
  const trigger = l.state.triggeredBy[id]
  if (trigger) return l.outputs[trigger] ?? ''
  const step = stepOf(l, id)
  // ancestorsOf returns nearest-first; reverse so the join reads
  // oldest-to-newest, the order a person reads a pipeline in.
  const preds = step?.contextMode === 'ancestors'
    ? ancestorsOf(l.graph, id).reverse()
    : (l.graph.forwardPreds[id] ?? [])
  if (!preds.length) return initialPrompt
  return joinBudgeted(preds.map(p => ({ label: recOf(run, p).label, text: l.outputs[p] ?? '' })))
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
): Promise<{ verdict: 'CONTINUE' | 'RETRY' | 'ABORT', review: string }> {
  if (!step.monitorSlug) return { verdict: 'CONTINUE', review: '' }
  try {
    const review = await agentCaller(
      step.monitorSlug,
      monitorPrompt({ label: step.label, agentSlug: step.agentSlug, input, output }),
      projectDir,
    )
    const verdict = parseVerdict(review)
    Object.assign(rec, { monitorVerdict: verdict, monitorNote: review })
    return { verdict, review }
  } catch (err) {
    const monitorNote = `Monitor failed: ${err instanceof Error ? err.message : 'unknown error'}`
    Object.assign(rec, { monitorVerdict: 'CONTINUE', monitorNote })
    return { verdict: 'CONTINUE', review: monitorNote }
  }
}

async function executeNode(l: Live, run: WorkflowRun, id: string, override?: string): Promise<boolean> {
  const step = stepOf(l, id)
  const rec = recOf(run, id)
  if (!step || !rec) return false

  const input = override ?? computeInput(l, run, id, run.initialPrompt)
  l.lastInputs[id] = input
  markRunning(l.state, id)
  Object.assign(rec, {
    status: 'running', input, output: '', error: undefined,
    completedAt: undefined, monitorVerdict: undefined, monitorNote: undefined,
    startedAt: Date.now(), visits: l.state.visits[id],
  })
  // currentStepIds is NOT touched here. For a wave, it already holds every node in the
  // wave (set once by runWave before any of them start) - see the C4 note there for why
  // narrowing it to this one node would corrupt that during concurrent execution. For a
  // single-step respondToRun call it already holds [id] from the prior pause.
  await publish(run)

  try {
    const output = await agentCaller(step.agentSlug, input, run.projectDir)
    l.outputs[id] = output
    Object.assign(rec, { status: 'completed', output, completedAt: Date.now() })

    if (step.monitorSlug) {
      const { verdict, review } = await runMonitor(step, rec, input, output, run.projectDir)
      if (verdict === 'ABORT') {
        markFailed(l.state, id)
        Object.assign(rec, { status: 'failed', error: 'Monitor aborted the workflow' })
        return false
      }
      if (verdict === 'RETRY' && canRevisit(l.graph, l.state, id)) {
        l.retryFeedback[id] = review
        l.state.status[id] = 'completed'
        armNode(l.state, id)
        return true
      }
    }

    markCompleted(l.graph, l.state, id)
    return true
  } catch (err) {
    markFailed(l.state, id)
    Object.assign(rec, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Unknown error',
      completedAt: Date.now(),
    })
    return false
  }
}

async function runWave(l: Live, run: WorkflowRun): Promise<WorkflowRun> {
  if (l.stopped) { l.running = false; return run }

  const wave = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  if (!wave.length) {
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }

  run.status = 'running'
  // currentStepIds is the whole wave, set once before anything in it runs. executeNode
  // deliberately never reassigns it (C4) - if it did, concurrent execution would leave
  // it reflecting only whichever node happened to reach that line last, not the wave.
  run.currentStepIds = wave
  run.nextStepIds = []
  await publish(run)

  // Genuine concurrency (C4), each executeNode call publish()es independently as it
  // progresses (mirroring the client engine's parallel step execution). publish() (above)
  // serializes those writes per run id so they can never race on disk.
  const results = await Promise.all(wave.map(id => executeNode(l, run, id)))

  if (results.some(ok => !ok)) {
    skipPending(l.state)
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
    run.status = 'failed'
    run.endedAt = Date.now()
    run.currentStepIds = []
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
 * Creates and persists the run, then kicks the wave loop off in the background and
 * returns immediately — the run is owned by the server, not by this HTTP request.
 * Awaiting this only awaits the run's creation (a fast filesystem write), never the
 * workflow's execution: for autoRun that could be many agent calls and minutes, and
 * even a single manual wave is a call the caller should not have to hold a connection
 * open for. Callers that need the outcome use waitForSettled(run.id), the way the SSE
 * stream and this module's own tests do.
 */
export async function startRun(opts: StartRunOpts): Promise<WorkflowRun> {
  const run = await createRun({
    workflowSlug: opts.workflow.slug,
    workflowName: opts.workflow.name,
    autoRun: opts.autoRun,
    initialPrompt: opts.initialPrompt,
    projectDir: opts.projectDir,
    steps: opts.workflow.steps.map(s => ({ stepId: s.id, label: s.label, agentSlug: s.agentSlug })),
  })
  const graph = buildGraph(opts.workflow.steps)
  const l: Live = {
    workflow: opts.workflow, graph, state: initRunState(graph),
    outputs: {}, lastInputs: {}, retryFeedback: {}, stopped: false, running: false,
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
export async function continueRun(runId: string): Promise<WorkflowRun | null> {
  const l = live.get(runId)
  // Re-entrancy guard (C6), matching the client engine's isRunning check pattern. This has
  // to be set synchronously, before the first await below - otherwise two calls that both
  // arrive while a run is paused would each see the guard still clear and both go on to
  // drive the same run's wave loop concurrently.
  if (!l || l.running) return getRun(runId)
  l.running = true
  const run = await getRun(runId)
  if (!run || run.status !== 'paused') {
    l.running = false
    return run
  }
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
  const combined = `Previous agent output:\n${l.outputs[id] ?? ''}\n\nUser response:\n${reply}`
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

export async function stopRun(runId: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  if (!run) return null
  // C5: a run that already reached a real outcome is not "stopped" by stopping it again.
  if (TERMINAL_STATUSES.includes(run.status)) return run
  const l = live.get(runId)
  if (l) { l.stopped = true; skipPending(l.state) }
  for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
  run.status = 'stopped'
  run.endedAt = Date.now()
  run.currentStepIds = []
  run.nextStepIds = []
  await publish(run)
  return run
}
