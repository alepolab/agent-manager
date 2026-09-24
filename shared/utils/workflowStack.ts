import { buildGraph, type GraphNode, type WorkflowGraph } from './workflowGraph.ts'
import type { RunDecision, SendBack } from '../types/run'

/**
 * A workflow's graph as a vertical stack: steps in sequence, and "paths" where
 * the graph splits. Paths either rejoin at one step or end separately.
 *
 * Only series/parallel graphs are drawable. Anything else (a back edge, a step
 * joining two branches of different splits, two first steps) is refused with a
 * reason that names the steps, and the caller shows the workflow read-only
 * rather than reshaping it. The runner never reads this: it is a picture of
 * the graph, and `fromStack` writes the graph back as explicit `next[]`.
 *
 * A split's branches must all meet again at the same step, or not meet at
 * all - a subset of them meeting somewhere else is refused too, honestly:
 * the message names the step where that subset meets early, not the
 * unrelated-looking "joins steps from different branches" a later step in
 * the graph would otherwise report.
 */

export type StackBlock =
  | { kind: 'step', stepId: string }
  | { kind: 'paths', branches: StackBlock[][], rejoin: boolean }

export type StackResult = { ok: true, blocks: StackBlock[] } | { ok: false, reason: string }

export type StackNode = GraphNode & { label?: string }

class NotDrawable extends Error {}

export function stepIdsOf(blocks: StackBlock[]): string[] {
  return blocks.flatMap(b => (b.kind === 'step' ? [b.stepId] : b.branches.flatMap(stepIdsOf)))
}

function topoIndex(g: WorkflowGraph): Map<string, number> {
  const indeg = new Map(g.nodes.map(n => [n.id, g.forwardPreds[n.id]!.length]))
  const queue = g.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
  const order = new Map<string, number>()
  while (queue.length) {
    const id = queue.shift()!
    order.set(id, order.size)
    for (const s of g.succ[id]!) {
      indeg.set(s, indeg.get(s)! - 1)
      if (indeg.get(s) === 0) queue.push(s)
    }
  }
  return order
}

export function toStack(steps: StackNode[]): StackResult {
  if (!steps.length) return { ok: true, blocks: [] }
  const g = buildGraph(steps)
  const name = (id: string) => `"${steps.find(s => s.id === id)?.label ?? id}"`

  if (g.backEdges.size) {
    const [edge] = [...g.backEdges]
    return { ok: false, reason: `A step goes back to an earlier step (${edge}). The stack draws send-backs from runs, not as edges.` }
  }
  const entries = g.nodes.filter(n => g.forwardPreds[n.id]!.length === 0).map(n => n.id)
  if (entries.length !== 1) {
    return { ok: false, reason: `The workflow has ${entries.length} first steps (${entries.map(name).join(', ')}); a stack starts at one.` }
  }

  const order = topoIndex(g)
  const reachMemo = new Map<string, Set<string>>()
  const reach = (id: string): Set<string> => {
    const hit = reachMemo.get(id)
    if (hit) return hit
    const out = new Set<string>([id])
    for (const s of g.succ[id]!) for (const r of reach(s)) out.add(r)
    reachMemo.set(id, out)
    return out
  }
  /** Where the branches starting at `starts` meet first, if they do. */
  const joinOf = (starts: string[]): string | undefined => {
    const [first, ...rest] = starts.map(reach)
    const common = [...first!].filter(id => rest.every(r => r.has(id)))
    return common.sort((a, b) => order.get(a)! - order.get(b)!)[0]
  }

  const seen = new Set<string>()
  function seq(start: string, stop: string | undefined): StackBlock[] {
    const out: StackBlock[] = []
    let id: string | undefined = start
    let isJoin = false
    while (id !== undefined && id !== stop) {
      if (seen.has(id)) throw new NotDrawable(`${name(id)} is reached along two routes.`)
      if (!isJoin && g.forwardPreds[id]!.length > 1) {
        throw new NotDrawable(`${name(id)} joins steps from different branches (${g.forwardPreds[id]!.map(name).join(', ')}).`)
      }
      seen.add(id)
      out.push({ kind: 'step', stepId: id })
      isJoin = false
      const succ: string[] = g.succ[id]!
      if (succ.length === 0) break
      if (succ.length === 1) { id = succ[0]; continue }

      const join = joinOf(succ)
      if (join === undefined && stop !== undefined) {
        throw new NotDrawable(`The branches after ${name(id)} never meet again, but an earlier split expects them to.`)
      }
      for (let i = 0; i < succ.length; i++) {
        for (let j = i + 1; j < succ.length; j++) {
          const si = succ[i]!, sj = succ[j]!
          const pairJoin = joinOf([si, sj])
          if (pairJoin !== undefined && pairJoin !== join) {
            throw new NotDrawable(`${name(pairJoin)} brings ${name(si)} and ${name(sj)} together before the other branches after ${name(id)} meet. The branches of one split have to meet at the same step.`)
          }
        }
      }
      const branches = succ.map(b => (b === join ? [] : seq(b, join)))
      if (join !== undefined && join !== stop) {
        const inside = new Set([id, ...branches.flatMap(stepIdsOf)])
        const outsiders = g.forwardPreds[join]!.filter(p => !inside.has(p))
        if (outsiders.length) {
          throw new NotDrawable(`${name(join)} joins the branches after ${name(id)} and also ${outsiders.map(name).join(', ')}.`)
        }
      }
      out.push({ kind: 'paths', branches, rejoin: join !== undefined })
      id = join
      isJoin = true
    }
    return out
  }

  try {
    const blocks = seq(entries[0]!, undefined)
    const missing = steps.filter(s => !seen.has(s.id))
    if (missing.length) return { ok: false, reason: `${missing.map(s => name(s.id)).join(', ')} cannot be reached from the first step.` }
    return { ok: true, blocks }
  } catch (err) {
    if (err instanceof NotDrawable) return { ok: false, reason: err.message }
    throw err
  }
}

/** The stack written back as a graph: explicit `next[]` on every step, every other field untouched, steps in stack order. */
export function fromStack<T extends GraphNode>(blocks: StackBlock[], steps: T[]): T[] {
  const byId = new Map(steps.map(s => [s.id, s]))
  const next = new Map<string, string[]>()
  const order: string[] = []
  const link = (from: string[], to: string) => {
    for (const f of from) if (!next.get(f)!.includes(to)) next.get(f)!.push(to)
  }
  function walk(bs: StackBlock[], tails: string[]): string[] {
    let ended = false
    for (const b of bs) {
      if (ended) throw new Error('A step cannot follow after paths that do not rejoin.')
      if (b.kind === 'step') {
        if (!byId.has(b.stepId)) throw new Error(`Unknown step "${b.stepId}"`)
        order.push(b.stepId)
        next.set(b.stepId, [])
        link(tails, b.stepId)
        tails = [b.stepId]
      } else {
        const ends = b.branches.flatMap(br => walk(br, tails))
        if (b.rejoin) tails = [...new Set(ends)]
        else { tails = []; ended = true }
      }
    }
    return tails
  }
  walk(blocks, [])
  return order.map(id => ({ ...byId.get(id)!, next: next.get(id)! }))
}

/**
 * The layout for a run. A run stores its steps but not the graph, so the graph
 * comes from the workflow, and is only trusted when the workflow still has
 * exactly the run's steps. Otherwise the run is shown in its own step order.
 */
export function stackForRun(workflowSteps: StackNode[] | null | undefined, runStepIds: string[]): { blocks: StackBlock[], note?: string } {
  const linear = runStepIds.map(stepId => ({ kind: 'step' as const, stepId }))
  if (!workflowSteps) return { blocks: linear, note: 'The workflow no longer exists; steps are shown in run order.' }
  const same = workflowSteps.length === runStepIds.length && workflowSteps.every(s => runStepIds.includes(s.id))
  if (!same) return { blocks: linear, note: 'The workflow has changed since this run; steps are shown in run order.' }
  const r = toStack(workflowSteps)
  return r.ok ? { blocks: r.blocks } : { blocks: linear, note: r.reason }
}

export type StepKind = 'agent' | 'jira' | 'jira-create' | 'notify' | 'loop'

/** What a step does, read from the config it carries. The agent slug is not consulted. */
export function stepKind(step?: { jira?: { action?: string }, notify?: unknown, triggerWorkflow?: unknown }): StepKind {
  if (!step) return 'agent'
  if (step.triggerWorkflow) return 'loop'
  if (step.notify) return 'notify'
  if (step.jira) return step.jira.action === 'create' ? 'jira-create' : 'jira'
  return 'agent'
}

export interface SendBackArrow { from: string, to: string, by: string, note: string, at: number }

/** Every send-back on the run, by a person (decisions) or an agent (sendBacks), oldest first. */
export function sendBackArrows(run: { decisions?: RunDecision[], sendBacks?: SendBack[] }): SendBackArrow[] {
  const people = (run.decisions ?? [])
    .filter(d => d.verdict === 'sent-back' && d.target)
    .map(d => ({ from: d.stepId, to: d.target!, by: d.by, note: d.note ?? '', at: d.at }))
  const agents = (run.sendBacks ?? []).map(s => ({ from: s.from, to: s.target, by: s.by, note: s.instruction, at: s.at }))
  return [...people, ...agents].sort((a, b) => a.at - b.at)
}
