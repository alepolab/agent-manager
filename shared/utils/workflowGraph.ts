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

export function edgeKey(from: string, to: string): string {
  return `${from}->${to}`
}

/**
 * Hard-capped at DEFAULT_MAX_VISITS, deliberately.
 *
 * The evidence bundle's `cost.attempts` is the observed max visits across a
 * run's steps, and the bundle schema caps it at 3. A workflow declaring
 * `maxVisits: 5` could therefore produce a truthful attempts count the schema
 * rejects — and the fix must not be to clamp the reported number, because
 * misreporting an observed fact to satisfy a schema is exactly the fabrication
 * this pipeline exists to prevent. So the limit is enforced where it is a real
 * policy decision (how many times a step may run) rather than where it would be
 * a lie (what actually happened). A workflow asking for more gets 3.
 */
export function maxVisitsOf(node: GraphNode): number {
  const raw = Number(node.maxVisits)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_VISITS
  return Math.min(Math.floor(raw), DEFAULT_MAX_VISITS)
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

/**
 * Every transitive forward-ancestor of `id`, nearest-first.
 *
 * Walks `forwardPreds`, which buildGraph has already stripped of back-edges —
 * so this terminates on cyclic graphs without needing a depth cap of its own.
 * The `seen` set additionally stops a diamond from reporting its shared root
 * once per path.
 */
export function ancestorsOf(graph: WorkflowGraph, id: string): string[] {
  const seen = new Set<string>([id])
  const out: string[] = []
  let frontier = [...(graph.forwardPreds[id] ?? [])]
  while (frontier.length) {
    const next: string[] = []
    for (const node of frontier) {
      if (seen.has(node)) continue
      seen.add(node)
      out.push(node)
      next.push(...(graph.forwardPreds[node] ?? []))
    }
    frontier = next
  }
  return out
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

/**
 * Settle a node whose `runWhen` condition was not met: it never ran, and whatever
 * it feeds still schedules.
 *
 * The graph status is 'completed' even though the run record says 'skipped',
 * because the AND-join in markCompleted tests `status === 'completed'` on every
 * forward predecessor - a branch that legitimately had nothing to do must not
 * wedge the join behind it. That divergence between graph status and record
 * status is deliberate and already load-bearing for Jira steps, which settle the
 * same way (see the `step.jira` branch in server/utils/workflowRunner.ts).
 *
 * Clearing `armed` is the whole reason this is not just a markCompleted call.
 * markCompleted does not clear it; markRunning normally does, and a condition
 * skip deliberately never calls markRunning (nothing was attempted, so nothing
 * may be billed as a visit). Leave `armed` set and readyNodes hands the node
 * straight back on the next pass - the caller's resolution loop never terminates.
 */
export function markSkippedByCondition(graph: WorkflowGraph, state: RunState, id: string): void {
  state.armed[id] = false
  markCompleted(graph, state, id)
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

/**
 * A step's structured way of stopping the run.
 *
 * Deliberately anchored to the start of a line (`^`, multiline): an agent
 * discussing the marker in prose must not halt the pipeline. Deliberately
 * requires a non-empty reason: "something went wrong" with no reason is a
 * halt nobody can act on, and the safer reading of a bare marker is that it
 * was quoted rather than raised. Last match wins, matching parseVerdict.
 */
export function parseHalt(text: string | undefined | null): string | null {
  const matches = [...(text ?? '').matchAll(/^PIPELINE-HALT:[^\S\n]*(\S.*)$/gm)]
  const last = matches[matches.length - 1]
  return last ? last[1]!.trim() : null
}

/**
 * The last `PIPELINE-SKIP: <reason>` a step declared, or null.
 *
 * A skip is the third honest outcome, alongside a result and a halt, and it
 * exists because two real runs died without it. `sdlc-stack-provisioner` was
 * handed an infra ticket whose acceptance criteria are settled by how compose
 * *renders* - nothing to stand up - and its prompt offered only "evidence or
 * halt". Having no way to say "this step does not apply here", it ground
 * through its entire turn budget issuing Bash commands and died on
 * `error_max_turns` with empty output. Halting would have been wrong too: the
 * pipeline was not blocked, and a halt stops every downstream step.
 *
 * So a skip schedules exactly like a completed step - downstream nodes run,
 * and the reasoning is published to them - while recording that no work was
 * performed. That distinction is the whole point: a reviewer reading the
 * evidence bundle must be able to tell "verified, nothing needed" apart from
 * "verified and fixed", and neither may be silently reported as the other.
 *
 * Checked AFTER parseHalt: a step emitting both is in trouble, not idle, and
 * the blocking outcome is the safe one to honour.
 */
/**
 * A step that found the fault in code outside the run's scope says so with
 *   PIPELINE-WIDEN: <registry product key or owner/repo> — <why>
 * and the runner brings that code into the run instead of the step halting
 * or asking. The last such line wins, like the other outcomes.
 */
export function parseWiden(text: string | undefined | null): { target: string, reason: string } | null {
  const matches = [...(text ?? '').matchAll(/^PIPELINE-WIDEN:[^\S\n]*([\w./-]+)[^\S\n]*(?:[—:-]+[^\S\n]*)?(.*)$/gm)]
  const last = matches[matches.length - 1]
  return last ? { target: last[1]!.trim(), reason: last[2]!.trim() } : null
}

/**
 * A step that finds an earlier step's output is what stops it says so with
 *   PIPELINE-REWORK: <step label or agent> — <what to change>
 * and the runner sends the run back to that step with the instruction, instead
 * of the step halting the whole run over something fixable. The last such line
 * wins, like the other outcomes.
 */
export function parseRework(text: string | undefined | null): { target: string, instruction: string } | null {
  const matches = [...(text ?? '').matchAll(/^PIPELINE-REWORK:[^\S\n]*(.+?)[^\S\n]*(?:—|:| - )[^\S\n]*(.*)$/gm)]
  const last = matches[matches.length - 1]
  return last ? { target: last[1]!.trim(), instruction: last[2]!.trim() } : null
}

export function parseSkip(text: string | undefined | null): string | null {
  const matches = [...(text ?? '').matchAll(/^PIPELINE-SKIP:[^\S\n]*(\S.*)$/gm)]
  const last = matches[matches.length - 1]
  return last ? last[1]!.trim() : null
}

export type GateResult = {
  verdict: 'run' | 'skip' | 'error'
  /** Reads as the predicate of a sentence about the file: "<name> <detail>." */
  detail: string
  /** Entries found, when the shape has a countable one. */
  count?: number
}

/**
 * Whether a step's `runWhen` artifact holds something worth running for.
 *
 * Takes the file's text rather than its path so the whole decision - every
 * emptiness rule and every sentence a reviewer reads - stays I/O-free and
 * testable under plain node. The caller does the reading and passes `null` when
 * the file could not be read at all.
 *
 * Missing and malformed are deliberately different verdicts. A file that was
 * never written is a legitimate "nothing to do here": the gate ran and found
 * no work. A file that exists but is not JSON means the step that produced it
 * crashed mid-write or wrote something nobody can consume, and reading that as
 * "nothing to do" would let a broken gate silently complete a run having
 * created nothing - the exact silent-nothing the rest of this pipeline is built
 * to prevent. So it is an error, and it fails the step.
 */
export function gateSatisfied(raw: string | null): GateResult {
  if (raw === null) return { verdict: 'skip', detail: 'was not written' }
  if (!raw.trim()) return { verdict: 'skip', detail: 'is empty' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { verdict: 'error', detail: 'exists but is not valid JSON' }
  }

  if (parsed === null) return { verdict: 'skip', detail: 'holds null' }
  if (Array.isArray(parsed)) {
    return parsed.length
      ? { verdict: 'run', detail: `holds ${parsed.length} ${parsed.length === 1 ? 'entry' : 'entries'}`, count: parsed.length }
      : { verdict: 'skip', detail: 'holds an empty array (0 entries)', count: 0 }
  }
  if (typeof parsed === 'string') {
    return parsed ? { verdict: 'run', detail: 'holds a string' } : { verdict: 'skip', detail: 'holds an empty string' }
  }
  if (typeof parsed === 'object') {
    const keys = Object.keys(parsed as Record<string, unknown>).length
    return keys
      ? { verdict: 'run', detail: `holds an object with ${keys} ${keys === 1 ? 'key' : 'keys'}`, count: keys }
      : { verdict: 'skip', detail: 'holds an empty object', count: 0 }
  }
  // A bare number or boolean: falsy is nothing to do, truthy is something.
  return parsed
    ? { verdict: 'run', detail: `holds ${JSON.stringify(parsed)}` }
    : { verdict: 'skip', detail: `holds ${JSON.stringify(parsed)}` }
}

/** A step the runner executes itself, without a model: it starts one child run
 *  per entry in `source`, routing each entry to a workflow. */
export interface TriggerWorkflowConfig {
  /** Array artifact in the run's artifacts directory; one child run per entry. */
  source: string
  /** Entry field whose value picks the workflow (e.g. 'work_type'). */
  routeBy?: string
  /** A `routeBy` value mapped to the workflow slug it dispatches to. */
  routes?: Record<string, string>
  /** Where an entry goes when `routeBy`/`routes` do not resolve it, and the
   *  only target when neither is configured. */
  slug?: string
}

export interface DispatchTarget {
  /** Identifies the entry in reports, and names the child's own workspace. */
  key: string
  /** The workflow the child run starts. */
  slug: string
  /** The entry itself, so the caller can build the child's opening prompt. */
  entry: Record<string, unknown>
}

export interface DispatchPlan {
  targets: DispatchTarget[]
  /** Reads as the predicate of a sentence about the file: "<name> <detail>." */
  detail: string
  /** Set when no plan could be made; the step fails and dispatches nothing. */
  error?: string
}

/** Fields an entry may carry its identity in, nearest-first. A scan pipeline's
 *  drafts are keyed by ticket before the ticket exists and by key after. */
const ENTRY_KEY_FIELDS = ['jira_key', 'key', 'id', 'ticket', 'title']

/**
 * What to call one entry of an artifact: its own identity where it has one,
 * else its position.
 *
 * Exported because the review panel names the same entries a dispatch will,
 * and two different names for one draft - "DRAFT-002" on screen, "entry 2" in
 * the run log - is a reviewer unable to tell whether the thing they approved
 * is the thing that ran.
 */
export function entryKey(entry: Record<string, unknown>, index: number): string {
  const named = ENTRY_KEY_FIELDS.map(f => entry[f]).find(v => typeof v === 'string' && v.trim())
  return typeof named === 'string' ? named.trim() : `entry ${index + 1}`
}

/**
 * Which child runs a `triggerWorkflow` step should start, from the artifact it
 * dispatches over.
 *
 * Takes the file's text rather than its path, for the same reason
 * `gateSatisfied` above does: every routing rule and every sentence a reviewer
 * reads stays I/O-free and testable under plain node. The caller reads the file
 * and passes `null` when it could not be read at all.
 *
 * Absent and malformed are deliberately different, exactly as they are for a
 * `runWhen` gate. A file that was never written, or holds an empty array, is a
 * legitimate "nothing to dispatch" - the step ran and found no work. A file
 * that is not JSON, or is JSON but not an array, means the step that produced
 * it crashed mid-write or wrote something nobody can consume; reading that as
 * "nothing to dispatch" would let a scan complete having silently started
 * nothing, which is the failure this pipeline is built to prevent.
 *
 * Routing is all-or-nothing. One entry nobody can route fails the whole step
 * and starts no children, because a partially dispatched batch leaves some
 * tickets in flight and others silently dropped, with nothing on the run
 * saying which were which. Failing names the entry and the value that had no
 * route, so the fix is a one-line edit to `routes`.
 */
export function planDispatch(raw: string | null, cfg: TriggerWorkflowConfig): DispatchPlan {
  const none = (detail: string): DispatchPlan => ({ targets: [], detail })
  if (raw === null) return none('was not written')
  if (!raw.trim()) return none('is empty')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { targets: [], detail: 'exists but is not valid JSON', error: 'exists but is not valid JSON' }
  }
  if (!Array.isArray(parsed)) {
    const shape = parsed === null ? 'null' : typeof parsed
    const why = `holds ${shape}, not the array of entries this step dispatches over`
    return { targets: [], detail: why, error: why }
  }
  if (!parsed.length) return none('holds an empty array (0 entries)')

  const targets: DispatchTarget[] = []
  for (const [i, raw_] of parsed.entries()) {
    // A non-object entry has no field to route by and no field to be named by.
    const entry: Record<string, unknown> = (raw_ && typeof raw_ === 'object' && !Array.isArray(raw_))
      ? raw_ as Record<string, unknown>
      : {}
    const key = entryKey(entry, i)

    const routed = cfg.routeBy ? entry[cfg.routeBy] : undefined
    const slug = (typeof routed === 'string' && cfg.routes?.[routed]) || cfg.slug
    if (!slug) {
      const why = !cfg.routeBy
        ? 'this step names no workflow to dispatch to: set a target workflow, or a routing field and table'
        : typeof routed !== 'string' || !routed
          ? `${key} has no "${cfg.routeBy}" to route on, and this step has no fallback workflow`
          : `${key} routes on "${cfg.routeBy}": "${routed}", which is in no route and this step has no fallback workflow`
      return { targets: [], detail: why, error: why }
    }
    targets.push({ key, slug, entry })
  }
  return {
    targets,
    detail: `holds ${targets.length} ${targets.length === 1 ? 'entry' : 'entries'} to dispatch`,
  }
}

const CLIP = 4000
const clip = (text: string): string =>
  text.length > CLIP ? `${text.slice(0, CLIP)}\n...[truncated]` : text

export function monitorPrompt(opts: { label: string, agentSlug: string, input: string, output: string, artifactsDir?: string }): string {
  return `You are monitoring one step of an automated workflow.

Step: ${opts.label} (agent: ${opts.agentSlug})

--- INPUT GIVEN TO THE AGENT ---
${clip(opts.input)}

--- OUTPUT IT PRODUCED ---
${clip(opts.output)}

The step writes its evidence as files in the run artifacts directory${opts.artifactsDir ? `:
${opts.artifactsDir}` : ' named in the input'}. The output is a summary; the files are the proof. Before you vote RETRY for missing evidence, Read the files the step names there (meta.json, *.md, *.xml) and judge on what they contain — a step whose files hold the proof has done its job even if its summary did not paste it. Vote RETRY only when the evidence is absent from both the output and the files.

Judge whether the output actually satisfies the step. Give a short assessment (2-3 sentences),
then end your reply with exactly one of these lines:

VERDICT: CONTINUE   - the output is good, move on
VERDICT: RETRY      - the output is deficient, the step should run again with your feedback
VERDICT: ABORT      - something is wrong enough that the workflow should stop`
}
