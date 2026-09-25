import { fromStack, toStack, type StackBlock, type StackNode } from './workflowStack.ts'

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

const endsOpen = (s: StackBlock[]) => { const last = s.at(-1); return last?.kind === 'paths' && !last.rejoin }

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
  return mapSeq(blocks, slot.seq, (s) => {
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
    return next
  })
}

/** The builder makes one level of paths; nested paths in a file still display. */
export function splitAt(blocks: StackBlock[], slot: Slot): StackBlock[] {
  if (slot.seq.length) throw new Error('The builder makes one level of paths. Split before or after this one instead.')
  return mapSeq(blocks, slot.seq, (s) => {
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
    if (left.length === 1) return [...s.slice(0, at.index), ...left[0]!, ...s.slice(at.index + 1)]
    return s.map((b, i) => (i === at.index ? { ...p, branches: left } : b))
  })
}

export function setRejoin(blocks: StackBlock[], at: Slot, rejoin: boolean): StackBlock[] {
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
 * The stack as steps to save, or why it cannot be saved. Proves the result
 * draws again (the spec's `toStack(fromStack(blocks)).ok`), so the builder can
 * never write a file it would then open read-only.
 */
export function canSave<T extends StackNode>(blocks: StackBlock[], steps: T[]): { ok: true, steps: T[] } | { ok: false, reason: string } {
  try {
    const out = fromStack(pruneEmptyPaths(blocks), steps)
    const back = toStack(out)
    return back.ok ? { ok: true, steps: out } : { ok: false, reason: back.reason }
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

export function newStep(kind: ActionKind, opts: { agentSlug?: string, id?: string }): NewStep {
  const id = opts.id ?? crypto.randomUUID()
  if (kind === 'agent') {
    if (!opts.agentSlug) throw new Error('Choose an agent for this step.')
    return { id, agentSlug: opts.agentSlug, label: opts.agentSlug }
  }
  const base = { id, agentSlug: ACTION_AGENT[kind], label: ACTION_LABEL[kind] }
  if (kind === 'jira') return { ...base, jira: {} }
  if (kind === 'jira-create') return { ...base, jira: { action: 'create' } }
  if (kind === 'notify') return { ...base, notify: { channel: '' } }
  return { ...base, triggerWorkflow: {} }
}
