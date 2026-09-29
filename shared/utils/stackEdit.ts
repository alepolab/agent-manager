import { fromStack, stepIdsOf, toStack, type StackBlock, type StackNode } from './workflowStack.ts'

/**
 * The edits the stack builder can make. Every function returns a new array and
 * never mutates its input; an edit the stack cannot hold throws an Error whose
 * message is shown to the person as it is.
 *
 * The builder keeps the layout (`StackBlock[]`) and the step configs apart,
 * and only joins them at save time through `canSave`, which is also the one
 * place that proves the result can be drawn again.
 */

/** From the top level into nested branches: at `block` (a paths block), into `branch`. */
export type SeqPath = { block: number, branch: number }[]
/** A position in one sequence: where to insert, or where a block sits. */
export interface Slot { seq: SeqPath, index: number }

const OPEN_END = 'Nothing can follow paths that end separately. Turn on "Rejoin after paths" first.'

export function seqAt(blocks: StackBlock[], seq: SeqPath): StackBlock[] {
  let cur = blocks
  for (const { block, branch } of seq) {
    const b = cur[block]
    if (!b || b.kind !== 'paths') throw new Error(`Block ${block} is not a split.`)
    const next = b.branches[branch]
    if (!next) throw new Error(`The split has no branch ${branch + 1}.`)
    cur = next
  }
  return cur
}

function mapSeq(blocks: StackBlock[], seq: SeqPath, fn: (s: StackBlock[]) => StackBlock[]): StackBlock[] {
  if (!seq.length) return fn(blocks)
  const [head, ...rest] = seq
  return blocks.map((b, i) => {
    if (i !== head!.block) return b
    if (b.kind !== 'paths') throw new Error(`Block ${i} is not a split.`)
    return { ...b, branches: b.branches.map((br, j) => (j === head!.branch ? mapSeq(br, rest, fn) : br)) }
  })
}

/** Whether a sequence ends in paths that each end separately (no rejoin). */
export const endsOpen = (s: StackBlock[]) => { const last = s.at(-1); return last?.kind === 'paths' && !last.rejoin }

export function findStep(blocks: StackBlock[], stepId: string, seq: SeqPath = []): Slot | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.kind === 'step') { if (b.stepId === stepId) return { seq, index: i } }
    else {
      for (let j = 0; j < b.branches.length; j++) {
        const hit = findStep(b.branches[j]!, stepId, [...seq, { block: i, branch: j }])
        if (hit) return hit
      }
    }
  }
  return null
}

export function insertStep(blocks: StackBlock[], slot: Slot, stepId: string): StackBlock[] {
  if (findStep(blocks, stepId)) throw new Error('That step is already in the workflow.')
  return mapSeq(blocks, slot.seq, (s) => {
    if (slot.index < 0 || slot.index > s.length) throw new Error('Move out of range.')
    if (slot.index >= s.length && endsOpen(s)) throw new Error(OPEN_END)
    return [...s.slice(0, slot.index), { kind: 'step', stepId }, ...s.slice(slot.index)]
  })
}

export function removeStep(blocks: StackBlock[], stepId: string): StackBlock[] {
  const at = findStep(blocks, stepId)
  if (!at) throw new Error(`Unknown step "${stepId}".`)
  return mapSeq(blocks, at.seq, s => s.filter((_, i) => i !== at.index))
}

export function moveWithin(blocks: StackBlock[], seq: SeqPath, from: number, to: number): StackBlock[] {
  return mapSeq(blocks, seq, (s) => {
    if (from < 0 || from >= s.length || to < 0 || to >= s.length) throw new Error('Move out of range.')
    const next = [...s]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    const open = next.findIndex(b => b.kind === 'paths' && !b.rejoin)
    if (open !== -1 && open !== next.length - 1) throw new Error('Paths that end separately have to stay last.')
    if (!seq.length && next[0]!.kind === 'paths') throw new Error('A split needs a step before it.')
    return next
  })
}

/** The builder makes one level of paths; nested paths in a file still display. */
export function splitAt(blocks: StackBlock[], slot: Slot): StackBlock[] {
  if (slot.seq.length) throw new Error('The builder makes one level of paths. Split before or after this one instead.')
  return mapSeq(blocks, slot.seq, (s) => {
    if (slot.index < 0 || slot.index > s.length) throw new Error('Move out of range.')
    if (slot.index === 0) throw new Error('A split needs a step before it.')
    if (slot.index >= s.length && endsOpen(s)) throw new Error(OPEN_END)
    return [...s.slice(0, slot.index), { kind: 'paths', branches: [[], []], rejoin: true }, ...s.slice(slot.index)]
  })
}

function mapPaths(blocks: StackBlock[], at: Slot, fn: (p: Extract<StackBlock, { kind: 'paths' }>, s: StackBlock[]) => StackBlock[]): StackBlock[] {
  return mapSeq(blocks, at.seq, (s) => {
    const p = s[at.index]
    if (!p || p.kind !== 'paths') throw new Error('There is no split here.')
    return fn(p, s)
  })
}

export function addBranch(blocks: StackBlock[], at: Slot): StackBlock[] {
  return mapPaths(blocks, at, (p, s) => s.map((b, i) => (i === at.index ? { ...p, branches: [...p.branches, []] } : b)))
}

/** Down to one branch, the split is no longer a split: its steps take its place. */
export function removeBranch(blocks: StackBlock[], at: Slot, branch: number): StackBlock[] {
  return mapPaths(blocks, at, (p, s) => {
    const left = p.branches.filter((_, j) => j !== branch)
    if (left.length === p.branches.length) throw new Error(`The split has no branch ${branch + 1}.`)
    if (left.length === 1) {
      const rest = s.slice(at.index + 1)
      if (rest.length && endsOpen(left[0]!)) throw new Error(OPEN_END)
      return [...s.slice(0, at.index), ...left[0]!, ...rest]
    }
    return s.map((b, i) => (i === at.index ? { ...p, branches: left } : b))
  })
}

export function setRejoin(blocks: StackBlock[], at: Slot, rejoin: boolean): StackBlock[] {
  if (!rejoin && at.seq.length > 0) throw new Error('A path inside another split has to rejoin.')
  return mapPaths(blocks, at, (p, s) => {
    if (!rejoin && at.index !== s.length - 1) throw new Error('Steps follow these paths, so they have to rejoin.')
    return s.map((b, i) => (i === at.index ? { ...p, rejoin } : b))
  })
}

/** A split with no steps in any branch means nothing; it is dropped rather than saved. */
export function pruneEmptyPaths(blocks: StackBlock[]): StackBlock[] {
  const out: StackBlock[] = []
  for (const b of blocks) {
    if (b.kind === 'step') { out.push(b); continue }
    const branches = b.branches.map(pruneEmptyPaths)
    if (branches.every(br => br.length === 0)) continue
    out.push({ ...b, branches })
  }
  return out
}

/**
 * The shape the stack would redraw as: nested splits normalized bottom-up,
 * then at each sequence level — a split whose branches are all empty is
 * dropped; a split that ends in a rejoin:false keeps none of its empty
 * branches (nothing follows to tell them apart), a rejoin:true split keeps at
 * most one (a graph cannot tell two empty branches apart either); a split
 * left with one branch is unwrapped in place, its blocks replacing it; and a
 * split that is the last block of an open sequence is rejoin:false, because
 * nothing after it could tell the difference. A sequence is open when there
 * is no rejoin to fall back to: the top level, and the branches of a
 * rejoin:false split. Inside a branch of a rejoining split the outer rejoin
 * follows, so a trailing split there keeps its rejoin. Applied until nothing changes,
 * since one pass can produce a new last block for the next to act on.
 */
export function normalize(blocks: StackBlock[]): StackBlock[] {
  let cur = blocks
  while (true) {
    const next = normalizeOnce(cur, true)
    if (JSON.stringify(next) === JSON.stringify(cur)) return next
    cur = next
  }
}

function normalizeOnce(blocks: StackBlock[], open: boolean): StackBlock[] {
  const out: StackBlock[] = []
  for (const b of blocks) {
    if (b.kind === 'step') { out.push(b); continue }
    const branches = b.branches.map(br => normalizeOnce(br, !b.rejoin))
    const collapsed = b.rejoin
      ? (branches.some(br => br.length === 0) ? [...branches.filter(br => br.length > 0), []] : branches)
      : branches.filter(br => br.length > 0)
    if (collapsed.length === 0) continue
    if (collapsed.length === 1) { out.push(...collapsed[0]!); continue }
    out.push({ ...b, branches: collapsed })
  }
  if (open && out.length) {
    const last = out[out.length - 1]!
    if (last.kind === 'paths' && last.rejoin) out[out.length - 1] = { ...last, rejoin: false }
  }
  return out
}

/**
 * The stack as steps to save, or why it cannot be saved. Refuses a step id
 * used twice outright, then proves the result draws back as the shape shown
 * (`toStack(fromStack(normalize(blocks)))` equals `normalize(blocks)`), so the
 * builder can never write a file it would then open differently.
 */
export function canSave<T extends StackNode>(blocks: StackBlock[], steps: T[]): { ok: true, steps: T[] } | { ok: false, reason: string } {
  const ids = stepIdsOf(blocks)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup !== undefined) {
    const label = steps.find(s => s.id === dup)?.label ?? dup
    return { ok: false, reason: `Step "${label}" appears twice.` }
  }
  try {
    const shown = normalize(blocks)
    const out = fromStack(shown, steps)
    const back = toStack(out)
    if (!back.ok) return { ok: false, reason: back.reason }
    if (JSON.stringify(back.blocks) !== JSON.stringify(shown)) {
      return { ok: false, reason: 'This would save as a different shape than the one shown. Undo the last change to the paths and try again.' }
    }
    return { ok: true, steps: out }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export type ActionKind = 'agent' | 'jira' | 'jira-create' | 'notify' | 'loop'

/** The runner-executed step kinds and the agent slug each is stored under. */
export const ACTION_AGENT: Record<Exclude<ActionKind, 'agent'>, string> = {
  'jira': 'sdlc-jira-tracker',
  'jira-create': 'sdlc-jira-creator',
  'notify': 'sdlc-notifier',
  'loop': 'sdlc-auto-dispatcher',
}

export const ACTION_LABEL: Record<ActionKind, string> = {
  'agent': 'Run an agent',
  'jira': 'Update Jira ticket',
  'jira-create': 'Create Jira tickets',
  'notify': 'Post to a channel',
  'loop': 'Loop over items',
}

export interface NewStep {
  id: string
  agentSlug: string
  label: string
  jira?: { action?: 'create' }
  notify?: { channel: string }
  triggerWorkflow?: Record<string, never>
}

/** `label` names an agent step (the agent's display name); the slug stands in without one. */
export function newStep(kind: ActionKind, opts: { agentSlug?: string, id?: string, label?: string }): NewStep {
  const id = opts.id ?? crypto.randomUUID()
  if (kind === 'agent') {
    if (!opts.agentSlug) throw new Error('Choose an agent for this step.')
    return { id, agentSlug: opts.agentSlug, label: opts.label || opts.agentSlug }
  }
  const base = { id, agentSlug: ACTION_AGENT[kind], label: ACTION_LABEL[kind] }
  if (kind === 'jira') return { ...base, jira: {} }
  if (kind === 'jira-create') return { ...base, jira: { action: 'create' } }
  if (kind === 'notify') return { ...base, notify: { channel: '' } }
  return { ...base, triggerWorkflow: {} }
}
