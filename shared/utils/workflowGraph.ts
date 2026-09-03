/**
 * Pure graph logic for workflow execution: successor / predecessor maps, back-edge
 * classification, and which nodes are allowed to run next.
 *
 * Deliberately free of Vue, Nuxt aliases and I/O so `scripts/test-workflow-graph.mjs`
 * can import it under plain node.
 */

export interface GraphNode {
  id: string
  /** Explicit successors. Undefined (legacy workflows) means "the next node in array order". */
  next?: string[]
  /** How many times this node may run in one execution. Guards cycles. */
  maxVisits?: number
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type MonitorVerdict = 'CONTINUE' | 'RETRY' | 'ABORT'

export interface RunState {
  status: Record<string, RunStatus>
  visits: Record<string, number>
  /** Armed = a predecessor fired and the join is satisfied; the node may run. */
  armed: Record<string, boolean>
  /** Set when a node was armed over a back edge - names the node that fired it. */
  triggeredBy: Record<string, string>
  totalRuns: number
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  succ: Record<string, string[]>
  /** Predecessors over forward edges only. Back edges trigger, they do not gate. */
  forwardPreds: Record<string, string[]>
  backEdges: Set<string>
  entries: string[]
}

export const DEFAULT_MAX_VISITS = 3
/** Hard stop for a whole execution, so a cycle can never bill forever. */
export const MAX_TOTAL_RUNS = 50
/** Parallel branches share one projectDir - keep the blast radius small. */
export const MAX_CONCURRENCY = 3

export const edgeKey = (from: string, to: string): string => `${from}->${to}`

export function maxVisitsOf(node: GraphNode): number {
  const raw = Number(node.maxVisits)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_VISITS
}

/** Shortest hop count from the nodes nothing feeds into - how deep each node reads on the canvas. */
function computeDepths(nodes: GraphNode[], succ: Record<string, string[]>): Record<string, number> {
  const incoming: Record<string, number> = {}
  for (const node of nodes) incoming[node.id] = 0
  for (const node of nodes) {
    for (const target of succ[node.id] ?? []) incoming[target] = (incoming[target] ?? 0) + 1
  }

  const depth: Record<string, number> = {}
  const seeds = nodes.filter(n => incoming[n.id] === 0).map(n => n.id)
  // A component that is one closed loop has no in-degree-zero node; seed it at its first node.
  const queue = seeds.length ? [...seeds] : nodes.length ? [nodes[0]!.id] : []
  for (const id of queue) depth[id] = 0

  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    for (const target of succ[id] ?? []) {
      if (depth[target] === undefined) {
        depth[target] = depth[id]! + 1
        queue.push(target)
      }
    }
    // Anything the seeds could not reach starts its own layering.
    if (i === queue.length - 1) {
      const orphan = nodes.find(n => depth[n.id] === undefined)
      if (orphan) {
        depth[orphan.id] = 0
        queue.push(orphan.id)
      }
    }
  }

  return depth
}

/** Every node reachable from each node, so we can tell which edges actually close a cycle. */
function computeDescendants(nodes: GraphNode[], succ: Record<string, string[]>): Record<string, Set<string>> {
  const descendants: Record<string, Set<string>> = {}
  for (const node of nodes) {
    const seen = new Set<string>()
    const queue = [...(succ[node.id] ?? [])]
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(succ[id] ?? []))
    }
    descendants[node.id] = seen
  }
  return descendants
}

/**
 * An edge is a back edge when it closes a cycle *and* points at a node that sits no deeper
 * than its source - which is what a person means when they draw an arrow back to an earlier
 * step. Classifying purely by DFS order would instead cut the cycle wherever the traversal
 * happened to arrive first, which can turn a parallel branch into a sequential one.
 */
function findBackEdges(nodes: GraphNode[], succ: Record<string, string[]>): Set<string> {
  const back = new Set<string>()
  const depth = computeDepths(nodes, succ)
  const descendants = computeDescendants(nodes, succ)
  const order: Record<string, number> = {}
  nodes.forEach((node, i) => { order[node.id] = i })

  for (const node of nodes) {
    for (const target of succ[node.id] ?? []) {
      // Not part of a cycle at all - the target cannot get back here.
      if (!descendants[target]?.has(node.id)) continue
      const targetDepth = depth[target] ?? 0
      const sourceDepth = depth[node.id] ?? 0
      if (targetDepth < sourceDepth) back.add(edgeKey(node.id, target))
      // Same depth: cut the edge that points at the earlier step, so the choice is stable.
      else if (targetDepth === sourceDepth && order[target]! <= order[node.id]!) {
        back.add(edgeKey(node.id, target))
      }
    }
  }

  return back
}

export function buildGraph(nodes: GraphNode[]): WorkflowGraph {
  const ids = new Set(nodes.map(n => n.id))
  const succ: Record<string, string[]> = {}

  nodes.forEach((node, i) => {
    if (node.next === undefined) {
      const following = nodes[i + 1]
      succ[node.id] = following ? [following.id] : []
    } else {
      succ[node.id] = node.next.filter(id => ids.has(id))
    }
  })

  const backEdges = findBackEdges(nodes, succ)

  const forwardPreds: Record<string, string[]> = {}
  for (const node of nodes) forwardPreds[node.id] = []
  for (const node of nodes) {
    for (const target of succ[node.id]!) {
      if (!backEdges.has(edgeKey(node.id, target))) forwardPreds[target]!.push(node.id)
    }
  }

  let entries = nodes.filter(n => forwardPreds[n.id]!.length === 0).map(n => n.id)
  // A graph that is one closed loop has no natural entry - start at the first node.
  if (!entries.length && nodes.length) entries = [nodes[0]!.id]

  return { nodes, succ, forwardPreds, backEdges, entries }
}

export function initRunState(graph: WorkflowGraph): RunState {
  const state: RunState = { status: {}, visits: {}, armed: {}, triggeredBy: {}, totalRuns: 0 }
  for (const node of graph.nodes) {
    state.status[node.id] = 'pending'
    state.visits[node.id] = 0
    state.armed[node.id] = false
  }
  for (const id of graph.entries) state.armed[id] = true
  return state
}

/** Every node allowed to run right now. Callers cap the slice at MAX_CONCURRENCY. */
export function readyNodes(graph: WorkflowGraph, state: RunState): string[] {
  if (state.totalRuns >= MAX_TOTAL_RUNS) return []
  return graph.nodes
    .filter(node => state.armed[node.id]
      && state.status[node.id] !== 'running'
      && (state.visits[node.id] ?? 0) < maxVisitsOf(node))
    .map(node => node.id)
}

export function canRevisit(graph: WorkflowGraph, state: RunState, id: string): boolean {
  const node = graph.nodes.find(n => n.id === id)
  if (!node) return false
  return (state.visits[id] ?? 0) < maxVisitsOf(node) && state.totalRuns < MAX_TOTAL_RUNS
}

export function armNode(state: RunState, id: string, triggeredBy?: string): void {
  state.armed[id] = true
  if (triggeredBy) state.triggeredBy[id] = triggeredBy
  else delete state.triggeredBy[id]
}

export function markRunning(state: RunState, id: string): void {
  state.armed[id] = false
  state.status[id] = 'running'
  state.visits[id] = (state.visits[id] ?? 0) + 1
  state.totalRuns += 1
}

/**
 * Mark a node done and arm whatever it feeds. A back edge arms its target on its own;
 * a forward edge arms only once every forward predecessor of the target has completed,
 * which is what makes a join wait for all of its branches.
 */
export function markCompleted(graph: WorkflowGraph, state: RunState, id: string): void {
  state.status[id] = 'completed'
  for (const target of graph.succ[id] ?? []) {
    if (graph.backEdges.has(edgeKey(id, target))) {
      armNode(state, target, id)
    } else if ((graph.forwardPreds[target] ?? []).every(p => state.status[p] === 'completed')) {
      armNode(state, target)
    }
  }
}

export function markFailed(state: RunState, id: string): void {
  state.status[id] = 'failed'
  state.armed[id] = false
}

export function skipPending(state: RunState): void {
  for (const id of Object.keys(state.status)) {
    if (state.status[id] === 'pending') {
      state.status[id] = 'skipped'
      state.armed[id] = false
    }
  }
}

export function isFinished(graph: WorkflowGraph, state: RunState): boolean {
  const running = graph.nodes.some(n => state.status[n.id] === 'running')
  return !running && readyNodes(graph, state).length === 0
}

/** Concatenate predecessor outputs into one prompt, labelled so the agent can tell them apart. */
export function joinInputs(parts: { label: string, text: string }[]): string {
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]!.text
  return parts.map(p => `## Output from ${p.label}\n\n${p.text}`).join('\n\n---\n\n')
}

/** Anything unreadable counts as CONTINUE - a chatty monitor must not wedge the run. */
export function parseVerdict(text: string): MonitorVerdict {
  const matches = [...(text ?? '').matchAll(/VERDICT:\s*(CONTINUE|RETRY|ABORT)/gi)]
  const last = matches[matches.length - 1]
  return last ? (last[1]!.toUpperCase() as MonitorVerdict) : 'CONTINUE'
}

const CLIP = 4000
const clip = (text: string): string =>
  text.length > CLIP ? `${text.slice(0, CLIP)}\n...[truncated]` : text

export function monitorPrompt(opts: { label: string, agentSlug: string, input: string, output: string }): string {
  return `You are monitoring one step of an automated workflow.

Step: ${opts.label} (agent: ${opts.agentSlug})

--- INPUT GIVEN TO THE AGENT ---
${clip(opts.input)}

--- OUTPUT IT PRODUCED ---
${clip(opts.output)}

Judge whether the output actually satisfies the step. Give a short assessment (2-3 sentences),
then end your reply with exactly one of these lines:

VERDICT: CONTINUE   - the output is good, move on
VERDICT: RETRY      - the output is deficient, the step should run again with your feedback
VERDICT: ABORT      - something is wrong enough that the workflow should stop`
}
