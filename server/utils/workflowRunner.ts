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
  live.set(run.id, {
    workflow: opts.workflow, graph, state: initRunState(graph),
    outputs: {}, lastInputs: {}, retryFeedback: {}, stopped: false,
  })
  return runWave(live.get(run.id)!, run)
}

export async function continueRun(runId: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  const l = live.get(runId)
  if (!run || !l || run.status !== 'paused') return run
  return runWave(l, run)
}

export async function respondToRun(runId: string, reply: string): Promise<WorkflowRun | null> {
  const run = await getRun(runId)
  const l = live.get(runId)
  if (!run || !l || run.status !== 'paused') return run
  const id = run.currentStepIds[0]
  if (!id) return run
  const combined = `Previous agent output:\n${l.outputs[id] ?? ''}\n\nUser response:\n${reply}`
  const ok = await executeNode(l, run, id, combined)
  if (!ok) {
    skipPending(l.state)
    run.status = 'failed'
    run.endedAt = Date.now()
    await publish(run)
    return run
  }
  run.nextStepIds = readyNodes(l.graph, l.state).slice(0, MAX_CONCURRENCY)
  run.status = 'paused'
  await publish(run)
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
