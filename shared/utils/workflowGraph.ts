/**
 * Pure graph logic for workflow execution: successor / predecessor maps, back-edge
 * classification, and which nodes are allowed to run next.
 *
 * Deliberately free of Vue, Nuxt aliases and I/O so `scripts/test-workflow-graph.mjs`
 * can import it under plain node.
 */

/**
 * What has to be true of a step's outcome for one of its edges to be taken.
 *
 * Drawn only from outcomes this engine ALREADY computes, so a conditional edge
 * needs no new vocabulary from an agent:
 *
 * - `pass` / `fail`  the step's own stated Review Result (parseReviewVerdict)
 * - `approved` / `rejected`  how a person answered the step's gate
 * - `default`  taken only when no conditional sibling matched — the else arm
 *
 * An edge with no condition is unconditional and always taken, which is every
 * edge that existed before this type did.
 */
export type EdgeCondition = 'pass' | 'fail' | 'approved' | 'rejected' | 'default'

/** The outcome a completing step reports, against which its edges are judged. */
export type StepOutcome = 'pass' | 'fail' | 'approved' | 'rejected'

export interface GraphEdge {
  to: string
  when?: EdgeCondition
}

export interface GraphNode {
  id: string
  /**
   * Explicit successors. Undefined (legacy workflows) means "the next node in
   * array order". A bare string is an unconditional edge; `{ to, when }` is
   * taken only when the source's outcome matches.
   */
  next?: (string | GraphEdge)[]
  /** How many times this node may run in one execution. Guards cycles. */
  maxVisits?: number
}

/** The target of an edge, however it was written. */
export const edgeTarget = (e: string | GraphEdge): string => (typeof e === 'string' ? e : e.to)
const edgeWhen = (e: string | GraphEdge): EdgeCondition | undefined => (typeof e === 'string' ? undefined : e.when)

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export type MonitorVerdict = 'CONTINUE' | 'RETRY' | 'ABORT'

export interface RunState {
  status: Record<string, RunStatus>
  visits: Record<string, number>
  /** Armed = a predecessor fired and the join is satisfied; the node may run. */
  armed: Record<string, boolean>
  /** Set when a node was armed over a back edge - names the node that fired it. */
  triggeredBy: Record<string, string>
  /**
   * Every edge whose source has completed, and whether that edge was taken.
   *
   * A conditional edge is only decided once its source reports an outcome, so
   * "not in this map" and "decided false" are different facts and a join has to
   * tell them apart: the first means still waiting, the second means this path
   * is dead and the target may be settled without it.
   */
  edges: Record<string, boolean>
  totalRuns: number
}

export interface WorkflowGraph {
  nodes: GraphNode[]
  succ: Record<string, string[]>
  /** Predecessors over forward edges only. Back edges trigger, they do not gate. */
  forwardPreds: Record<string, string[]>
  backEdges: Set<string>
  entries: string[]
  /**
   * The condition on each edge, by `edgeKey`. An edge absent from this map is
   * unconditional — which is every edge in every workflow written before
   * conditions existed, so layout, back-edge classification and join semantics
   * are untouched for them.
   */
  conditions: Record<string, EdgeCondition>
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
  const conditions: Record<string, EdgeCondition> = {}

  nodes.forEach((node, i) => {
    if (node.next === undefined) {
      const following = nodes[i + 1]
      succ[node.id] = following ? [following.id] : []
    } else {
      // Conditions are recorded beside the shape, not inside it: every existing
      // reader of `succ` — layout, back-edge classification, ancestorsOf — asks
      // "where can this go", which a condition does not change. Only arming
      // consults `conditions`.
      const kept = node.next.filter(e => ids.has(edgeTarget(e)))
      succ[node.id] = kept.map(edgeTarget)
      for (const e of kept) {
        const when = edgeWhen(e)
        if (when) conditions[edgeKey(node.id, edgeTarget(e))] = when
      }
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

  return { nodes, succ, forwardPreds, backEdges, entries, conditions }
}

/** Does an outcome satisfy a condition? `default` is resolved by the caller. */
function matches(when: EdgeCondition, outcome: StepOutcome | undefined): boolean {
  return when !== 'default' && when === outcome
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
  const state: RunState = { status: {}, visits: {}, armed: {}, triggeredBy: {}, edges: {}, totalRuns: 0 }
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
export function markCompleted(
  graph: WorkflowGraph,
  state: RunState,
  id: string,
  outcome?: StepOutcome,
): void {
  state.status[id] = 'completed'

  // Decide every out-edge before arming anything. `default` means "no
  // conditional sibling matched", so it cannot be judged one edge at a time.
  const out = graph.succ[id] ?? []
  const anyConditionalMatched = out.some((t) => {
    const when = graph.conditions[edgeKey(id, t)]
    return when !== undefined && matches(when, outcome)
  })

  for (const target of out) {
    const key = edgeKey(id, target)
    const when = graph.conditions[key]
    const taken = when === undefined
      ? true
      : when === 'default'
        ? !anyConditionalMatched
        : matches(when, outcome)
    state.edges[key] = taken
    if (!taken) continue
    if (graph.backEdges.has(key)) {
      armNode(state, target, id)
    } else if ((graph.forwardPreds[target] ?? []).every(p => settled(state, p))) {
      // The original rule, with one widening: a SKIPPED predecessor counts as
      // settled. Without that, a node downstream of a branch would wait forever
      // on the arm the run did not take. `failed` is still not settled — a
      // failed predecessor blocks its target exactly as it always has.
      armNode(state, target)
    }
  }

  settleForward(graph, state)
}

const settled = (state: RunState, id: string) => state.status[id] === 'completed' || state.status[id] === 'skipped'

/**
 * Everything a still-runnable node could still reach.
 *
 * Deliberately ignores conditions: this asks "could the run arrive here at
 * all", and a condition that is false now may be true on the next lap of a
 * loop. Being conservative in this direction leaves a node `pending` a little
 * longer than strictly necessary, which costs nothing; being conservative the
 * other way would skip a step the run was still going to need.
 */
function reachableFromRunnable(graph: WorkflowGraph, state: RunState): Set<string> {
  const seen = new Set<string>()
  const queue = graph.nodes
    .filter(n => state.armed[n.id] || state.status[n.id] === 'running')
    .map(n => n.id)
  while (queue.length) {
    const id = queue.shift()!
    for (const target of graph.succ[id] ?? []) {
      if (seen.has(target)) continue
      seen.add(target)
      queue.push(target)
    }
  }
  return seen
}

/**
 * Skip what this run can no longer reach.
 *
 * Arming is done above, by the same rule as always. This pass exists only for
 * the case conditions introduce: a branch the run did NOT take leaves its
 * target with a forward predecessor that is never going to complete, so the
 * target would sit `pending` forever and any join below it would wait on a step
 * that will never run.
 *
 * A pending node whose every forward in-edge has been decided false is
 * unreachable on this run. It becomes `skipped`, its own out-edges are marked
 * dead, and the loop repeats — because skipping one node is what settles the
 * next. Nothing here ever arms, and nothing here touches a node whose edges are
 * still undecided, so a graph with no conditions never enters this branch at
 * all: its edges are all taken.
 */
function settleForward(graph: WorkflowGraph, state: RunState): void {
  // Bounded by node count: each pass must skip at least one node to continue,
  // so this cannot spin even on a cyclic graph.
  for (let pass = 0; pass <= graph.nodes.length; pass++) {
    let changed = false
    const live = reachableFromRunnable(graph, state)
    for (const node of graph.nodes) {
      const id = node.id
      if (state.status[id] !== 'pending' || state.armed[id]) continue
      const preds = graph.forwardPreds[id] ?? []
      if (!preds.length) continue // an entry; never skipped for want of a parent

      const allDecided = preds.every(p => state.edges[edgeKey(p, id)] !== undefined)
      if (!allDecided) continue
      if (preds.some(p => state.edges[edgeKey(p, id)] === true)) continue
      // Decided against on every arm — but a LOOP can change that answer. A
      // conditional back edge means the step that judged this may run again
      // and judge differently, so the exit of a retry loop is not dead while
      // the loop still has a lap left. Skipping it here is how the exit of
      // `work -> check -(fail)-> work` disappeared the first time round.
      if (live.has(id)) continue

      state.status[id] = 'skipped'
      state.armed[id] = false
      for (const target of graph.succ[id] ?? []) {
        if (state.edges[edgeKey(id, target)] === undefined) state.edges[edgeKey(id, target)] = false
      }
      changed = true
    }
    if (!changed) return
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

/**
 * What a step deliberately did NOT do, in a form something other than a person
 * can read.
 *
 *   PIPELINE-NOT-DONE: <what> — <why>
 *
 * CSUP-7524 ended "Two blockers remain, both outside this lane's authority" and
 * never listed them; its implement step said "The forward fix is implemented,
 * tested and committed. The backfill is not" — of 10,547 orphan records the
 * ticket was about. Eight of thirteen runs state nothing of the kind at all,
 * and two of thirteen metas mention a residual. The scope boundary is the first
 * thing a reviewer needs and the last thing anybody wrote down.
 *
 * Every line is kept, not just the last: a step can leave several things
 * undone, and dropping all but one would be a second omission.
 */
export function parseNotDone(text: string | undefined | null): { what: string, why: string }[] {
  return [...(text ?? '').matchAll(/^PIPELINE-NOT-DONE:[^\S\n]*(.+?)[^\S\n]*(?:—|:| - )[^\S\n]*(.*)$/gm)]
    .map(m => ({ what: m[1]!.trim(), why: m[2]!.trim() }))
    .filter(e => e.what)
}

/**
 * A review step's own answer: did the work it judged pass or not.
 *
 * This exists because five consecutive runs shipped a pull request over their
 * reviewer's explicit refusal. CSUP-7524's QA step opened with
 * "## Review Result: **FAIL** — 2 CRITICAL, 3 HIGH" and said "the client commit
 * doesn't exist"; the pipeline then ran three more steps and opened three pull
 * requests. Same in CSUP-7526, CSUP-7514, CSUP-7519 and SBN-4091. The verdict
 * was never hidden — it was the first line of the step's output — and the
 * runner had no way to read it, because a review step's judgement lived only in
 * prose while every enforceable outcome (halt, skip, rework, monitor verdict)
 * needed a marker the reviewers do not emit.
 *
 * So the convention the reviewers ALREADY write is the machine channel:
 * `Review Result: FAIL`, with `VERDICT:`/`PIPELINE-VERDICT:` accepted as
 * synonyms, at the start of a line and through any markdown decoration around
 * it (`## `, `**`). WARNING is a third real answer and is not a refusal — it
 * reads as PASS with a note, which is what it meant in CSUP-7495.
 *
 * `null` means the step never stated one. The runner treats that as a failure
 * for a step that was asked for a verdict, deliberately: "unreadable counts as
 * pass" is the exact reasoning that let a FAIL ship.
 */
export type ReviewVerdict = 'PASS' | 'WARNING' | 'FAIL'

const VERDICT_LINE = /^[#>\s]*\**\s*(?:PIPELINE-)?(?:REVIEW\s+RESULT|VERDICT)\s*\**\s*[::]\s*\**\s*(PASS|FAIL|WARNING)\b/gim
/** The same marker anywhere in a line, not only at its start. Used for FAIL only — see below. */
const VERDICT_ANYWHERE = /\**\s*(?:PIPELINE-)?(?:REVIEW\s+RESULT|VERDICT)\s*\**\s*[::]\s*\**\s*FAIL\b/gi

export function parseReviewVerdict(text: string | undefined | null): ReviewVerdict | null {
  // Quoted text is not a statement. A reviewer that pastes the required format
  // back as an example — a fenced block showing `Review Result: FAIL` — is
  // demonstrating the contract, not invoking it, and the unanchored FAIL scan
  // below would otherwise stop the run over its own instructions.
  const body = (text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  // A FAIL counts wherever it appears, and outranks a PASS on any other line.
  //
  // The anchored form alone lost a reviewer that changed its mind: "Review
  // Result: PASS … Actually wait, Review Result: FAIL" parsed as PASS, because
  // the second statement had prose in front of it. Self-correction mid-answer
  // is ordinary model behaviour, and this whole mechanism exists because a FAIL
  // went unheard — so the two readings are not weighed evenly. A false FAIL
  // stops a run a person can restart; a missed FAIL opens a pull request over a
  // refusal, which is the defect this file is fixing.
  if (VERDICT_ANYWHERE.test(body)) { VERDICT_ANYWHERE.lastIndex = 0; return 'FAIL' }
  VERDICT_ANYWHERE.lastIndex = 0
  const matches = [...body.matchAll(VERDICT_LINE)]
  const last = matches[matches.length - 1]
  return last ? (last[1]!.toUpperCase() as ReviewVerdict) : null
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
