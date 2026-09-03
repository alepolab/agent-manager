import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed,
  skipPending, isFinished, armNode, canRevisit, joinInputs, parseVerdict,
  monitorPrompt, MAX_CONCURRENCY,
  type WorkflowGraph, type RunState,
} from '../../shared/utils/workflowGraph.ts'   // relative, not an alias: the node
                                               // test scripts import this file
                                               // directly and cannot resolve ~~/
import { createRun, getRun, saveRun } from './workflowRunStore.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

export type AgentCaller =
  (agentSlug: string, input: string, projectDir?: string) => Promise<string>

/** Replaced in tests so the loop is exercisable without API calls. */
let agentCaller: AgentCaller = async () => {
  throw new Error('no agent caller configured')
}
export function setAgentCaller(fn: AgentCaller) { agentCaller = fn }

interface WorkflowLike {
  slug: string
  name: string
  steps: { id: string, agentSlug: string, label: string, next?: string[], monitorSlug?: string, maxVisits?: number }[]
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
}
const live = new Map<string, Live>()
const subscribers = new Map<string, Set<(run: WorkflowRun) => void>>()

export function subscribe(runId: string, fn: (run: WorkflowRun) => void): () => void {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set())
  subscribers.get(runId)!.add(fn)
  return () => subscribers.get(runId)?.delete(fn)
}

async function publish(run: WorkflowRun) {
  await saveRun(run)
  for (const fn of subscribers.get(run.id) ?? []) {
    try { fn(run) } catch { /* a broken subscriber must not stop the run */ }
  }
}

const SETTLED_STATUSES: WorkflowRun['status'][] = ['paused', 'completed', 'failed', 'stopped']
const isSettled = (status: WorkflowRun['status']) => SETTLED_STATUSES.includes(status)

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
  const preds = l.graph.forwardPreds[id] ?? []
  if (!preds.length) return initialPrompt
  return joinInputs(preds.map(p => ({ label: recOf(run, p).label, text: l.outputs[p] ?? '' })))
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
  run.currentStepIds = [id]
  await publish(run)

  try {
    const output = await agentCaller(step.agentSlug, input, run.projectDir)
    l.outputs[id] = output
    Object.assign(rec, { status: 'completed', output, completedAt: Date.now() })

    if (step.monitorSlug) {
      const review = await agentCaller(step.monitorSlug,
        monitorPrompt({ label: step.label, agentSlug: step.agentSlug, input, output }), run.projectDir)
      const verdict = parseVerdict(review)
      Object.assign(rec, { monitorVerdict: verdict, monitorNote: review })
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
  if (l.stopped) return run

  const wave = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  if (!wave.length) {
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    await publish(run)
    return run
  }

  run.status = 'running'
  run.currentStepIds = wave
  run.nextStepIds = []
  await publish(run)

  const results: boolean[] = []
  for (const id of wave) results.push(await executeNode(l, run, id))

  if (results.some(ok => !ok)) {
    skipPending(l.state)
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
    run.status = 'failed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    await publish(run)
    return run
  }

  if (isFinished(l.graph, l.state)) {
    run.status = 'completed'
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    await publish(run)
    return run
  }

  run.nextStepIds = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  if (run.autoRun && !l.stopped) return runWave(l, run)

  run.status = 'paused'
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
    outputs: {}, lastInputs: {}, retryFeedback: {}, stopped: false,
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
  const run = await getRun(runId)
  const l = live.get(runId)
  if (!run || !l || run.status !== 'paused') return run
  void driveToSettlement(l, run)
  return run
}

/**
 * Re-runs the current step with the user's reply in the background and returns
 * promptly — one more agent call that can run long, on the same UI flow (POST, then
 * watch SSE) as continueRun. Any throw from the loop below is caught the same way
 * driveToSettlement catches runWave's: never as an unhandled rejection.
 */
export async function respondToRun(runId: string, reply: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  const l = live.get(runId)
  if (!run || !l || run.status !== 'paused') return run
  const id = run.currentStepIds[0]
  if (!id) return run
  const combined = `Previous agent output:\n${l.outputs[id] ?? ''}\n\nUser response:\n${reply}`
  void (async () => {
    try {
      const ok = await executeNode(l, run, id, combined)
      if (!ok) {
        skipPending(l.state)
        run.status = 'failed'
        run.endedAt = Date.now()
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
  const l = live.get(runId)
  if (!run) return null
  if (l) { l.stopped = true; skipPending(l.state) }
  for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
  run.status = 'stopped'
  run.endedAt = Date.now()
  run.currentStepIds = []
  run.nextStepIds = []
  await publish(run)
  return run
}
