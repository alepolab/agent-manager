# Run Stack (Plan 2 of 3): Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workflow builder's Vue Flow canvas with a vertical stack editor:
- a trigger card, then step cards, with "+" between them
- typed actions
- paths
- a Setup/Configure drawer

A Build | Run switch shows the same page's runs as the run stack from Plan 1.

**Architecture:**
- **Pure edit operations** go in `shared/utils/stackEdit.ts`, with plain-node tests: insert, remove, move, split, branches, rejoin, prune, save check, new-step defaults. They change a `StackBlock[]`. The page keeps two pieces of state: `blocks` (the layout) and `steps` (step configs by id). Saving goes through `canSave` → `fromStack` → `toStack`, and writes explicit `next[]`.
- **Build-mode components** are separate from the run components: `WorkflowStackEditor`, `BuildStackBlocks`, `BuildStackCard`, `ActionPicker`. They share the layout function, the look, and the step-kind labels. A run card and a build card do different jobs, and merging them would put both jobs' conditions in every template.
- **The step drawer and the trigger drawer** reuse what the builder already has. The step settings fields move out of the modal. `WorkflowSchedulePanel` keeps schedules. The Inputs editor moves out of its modal.

**Tech Stack:** Nuxt 3, Vue 3 `<script setup>`, Nuxt UI v3, Tailwind v4. The node 24 test scripts import `.ts` directly.

**Spec:** `docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md`, section 3. Section 4 (Test a step) is Plan 3, so this plan builds no Test tab.

## Global Constraints

- **No change to the workflow file format.** Save writes the same fields as today. Steps keep every field they had. `position` is left untouched and ignored.
- **Save refuses a stack that can't be drawn again.** It checks `toStack(fromStack(blocks, steps)).ok` first and shows the reason. The spec requires this.
- **Workflows the stack can't draw** (`toStack` returns `ok: false`) open read-only, with the reason. The file is never reshaped.
- **Only one level of paths can be created.** A "Split into paths" choice is not offered inside a branch. Nested paths in an existing file still display.
- **The action picker writes these exact fields:**
  - Run an agent → `agentSlug`
  - Update Jira ticket → `agentSlug: 'sdlc-jira-tracker'`, `jira: {}`
  - Create Jira tickets → `agentSlug: 'sdlc-jira-creator'`, `jira: { action: 'create' }`
  - Post to a channel → `agentSlug: 'sdlc-notifier'`, `notify: { channel: '' }`
  - Loop over items → `agentSlug: 'sdlc-auto-dispatcher'`, `triggerWorkflow: {}`
  - Ask for approval → `approval: true` on the step below the "+"
  - Split into paths → a paths block with two empty branches and `rejoin: true`
- **A path's condition** is its first step's `runWhen.artifact`. Empty means the branch always runs.
- **Keep Vue Flow installed.** `@vue-flow/*` and its `main.css` rules stay, because `app/pages/graph.vue` uses them. Only the builder's use of Vue Flow goes away.
- **Keep these labels and contracts:**
  - buttons "Run", "Save", "Start" (in the run modal), "Add input", and "Inputs (N)"
  - the heading text "Workflow inputs"
  - the field label "Concurrency group"
  - the URLs `?start=1`, `?clone=<id>`, `?run=<id>` and `?tab=schedule`. The last one is linked from the `/workflows` cards and opens the trigger drawer on Triggers.
  - `data-testid="schedule-card"`, which comes from `WorkflowSchedulePanel`
- **Permissions:** `readOnly = !can('configure')`, as today. Read-only hides every "+", drag handle, delete and field edit.
- **Imports:** value imports inside `shared/` use the `.ts` extension. App code imports shared modules as `~~/shared/...`.
- **Colours:** CSS variables, and `RUN_STATUS_COLOR` for status. No literal hex.
- **Tests:** plain-node tests are `node scripts/test-<name>.mjs`. The typecheck is `npx nuxt typecheck` and must stay at 0 errors; bun is not installed. UI is verified in a real browser with a throwaway Playwright script under `/tmp`, against a disposable seeded `CLAUDE_DIR`, the way `e2e/*.smoke.mjs` do it.
- **Known baseline failures:**
  - `scripts/test-jira-steps.mjs` and `scripts/test-ticket-notifier.mjs` (missing JIRA env)
  - `scripts/test-gitignore-keeps-plans.mjs` (only in this worktree)
  - the Groups section (section 5) of `e2e/concurrency-groups.smoke.mjs`
- **Commits** are authored by the configured identity (arishtjain-alepo) and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Where to work:** worktree `/home/alepo/repos/agent-manager-run-stack-spec`, branch `feat/run-stack`, on top of Plan 1 (`fd23bb5`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `shared/utils/stackEdit.ts` | create | Pure stack edits, `canSave`, `newStep` |
| `scripts/test-stack-edit.mjs` | create | Tests for all of the above, including shipped-workflow round trips |
| `app/utils/buildStack.ts` | create | Injection key, context type, picker choices |
| `app/components/WorkflowStackEditor.vue` | create | Owns the edit operations; provides context; renders the trigger card and the top level |
| `app/components/BuildStackBlocks.vue` | create | Recursive: "+" slots, cards, approval cards, paths with conditions and rejoin, drag reorder |
| `app/components/BuildStackCard.vue` | create | One step in build mode |
| `app/components/ActionPicker.vue` | create | The "+" popover: typed actions, agent search, approval, split |
| `app/components/StepDrawer.vue` | create | Setup and Configure for one step |
| `app/components/StepConfigFields.vue` | create | Configure fields per step kind (moved from the settings modal) |
| `app/components/WorkflowInputsEditor.vue` | create | The parameters editor (moved from the Inputs modal) |
| `app/components/TriggerDrawer.vue` | create | Triggers (schedules and watches), Inputs, Settings |
| `app/pages/workflows/[slug].vue` | rewrite | Header, Build/Run switch, editor plus drawer, run mode through `RunStack` |
| `app/components/WorkflowNode.vue`, `WorkflowRunBar.vue`, `WorkflowRunPanel.vue`, `RunLiveCard.vue` | delete | No importers left (`RunLiveCard` already had none) |
| `e2e/schedules-and-parameters.smoke.mjs`, `e2e/concurrency-groups.smoke.mjs`, `e2e/workflow-run-panel.smoke.mjs` | modify | Point at the new builder |
| `e2e/workflow-builder.smoke.mjs` | create | Build, split, save, reload, check the file |
| `CLAUDE.md`, the spec | modify | Document the builder; record corrections |

---

### Task 1: Pure stack edits (`shared/utils/stackEdit.ts`)

**Files:**
- Create: `shared/utils/stackEdit.ts`
- Test: `scripts/test-stack-edit.mjs`

**Interfaces:**
- Consumes: `toStack`, `fromStack`, `stepKind`, `StackBlock`, `StackNode` from `shared/utils/workflowStack.ts`.
- Produces:
  - `type SeqPath = { block: number, branch: number }[]`, the route from the top level into nested branches
  - `interface Slot { seq: SeqPath, index: number }`, a position in one sequence. It is used both as an insertion point and as the location of a block.
  - `seqAt(blocks, seq): StackBlock[]`
  - `findStep(blocks, stepId): Slot | null`
  - `insertStep(blocks, slot, stepId): StackBlock[]`
  - `removeStep(blocks, stepId): StackBlock[]`
  - `moveWithin(blocks, seq, from, to): StackBlock[]`
  - `splitAt(blocks, slot): StackBlock[]`
  - `addBranch(blocks, at: Slot): StackBlock[]`
  - `removeBranch(blocks, at: Slot, branch: number): StackBlock[]`
  - `setRejoin(blocks, at: Slot, rejoin: boolean): StackBlock[]`
  - `pruneEmptyPaths(blocks): StackBlock[]`
  - `canSave<T extends StackNode>(blocks, steps: T[]): { ok: true, steps: T[] } | { ok: false, reason: string }`
  - `type ActionKind = 'agent' | 'jira' | 'jira-create' | 'notify' | 'loop'`
  - `ACTION_AGENT: Record<Exclude<ActionKind, 'agent'>, string>`
  - `ACTION_LABEL: Record<ActionKind, string>`
  - `newStep(kind: ActionKind, opts: { agentSlug?: string, id?: string }): NewStep`
  - Every edit returns a new array and never mutates its input. An edit the stack can't hold throws `Error` with a message to show the person.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-stack-edit.mjs`:

```js
/**
 * Self-check for shared/utils/stackEdit.ts: every edit the stack builder can
 * make, and the save check that stands between those edits and the file.
 *
 * The rule these protect: an edit either produces a stack that saves to a
 * graph the stack can draw again, or it is refused with a sentence a person
 * can act on. Nothing is ever mutated in place.
 *
 *   node scripts/test-stack-edit.mjs
 */
import assert from 'node:assert/strict'

const E = await import('../shared/utils/stackEdit.ts')
const { toStack, stepKind, stepIdsOf } = await import('../shared/utils/workflowStack.ts')
const { buildGraph } = await import('../shared/utils/workflowGraph.ts')
const { workflowTemplates, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')

const S = id => ({ kind: 'step', stepId: id })
const P = (branches, rejoin = true) => ({ kind: 'paths', branches, rejoin })
const step = (id, next, extra = {}) => ({ id, label: id.toUpperCase(), agentSlug: 'x', ...(next ? { next } : {}), ...extra })
const frozen = v => JSON.stringify(v)

// ── 1. addressing ──────────────────────────────────────────────────────────
{
  const blocks = [S('a'), P([[S('b'), S('c')], [S('d')]]), S('e')]
  assert.deepEqual(E.findStep(blocks, 'e'), { seq: [], index: 2 })
  assert.deepEqual(E.findStep(blocks, 'c'), { seq: [{ block: 1, branch: 0 }], index: 1 })
  assert.equal(E.findStep(blocks, 'zz'), null)
  assert.deepEqual(E.seqAt(blocks, [{ block: 1, branch: 1 }]), [S('d')])
  assert.throws(() => E.seqAt(blocks, [{ block: 0, branch: 0 }]), /not a split/)
}

// ── 2. insert, remove, move — never in place ───────────────────────────────
{
  const blocks = [S('a'), S('b')]
  const before = frozen(blocks)
  assert.deepEqual(E.insertStep(blocks, { seq: [], index: 1 }, 'n'), [S('a'), S('n'), S('b')])
  assert.deepEqual(E.insertStep(blocks, { seq: [], index: 2 }, 'n'), [S('a'), S('b'), S('n')])
  assert.deepEqual(E.removeStep(blocks, 'a'), [S('b')])
  assert.deepEqual(E.moveWithin(blocks, [], 0, 1), [S('b'), S('a')])
  assert.equal(frozen(blocks), before, 'the input is untouched')
  assert.throws(() => E.removeStep(blocks, 'zz'), /Unknown step "zz"/)
  assert.throws(() => E.moveWithin(blocks, [], 0, 5), /out of range/)

  const nested = [S('a'), P([[S('b'), S('c')], [S('d')]]), S('e')]
  assert.deepEqual(E.moveWithin(nested, [{ block: 1, branch: 0 }], 1, 0), [S('a'), P([[S('c'), S('b')], [S('d')]]), S('e')])
  assert.deepEqual(E.insertStep(nested, { seq: [{ block: 1, branch: 1 }], index: 0 }, 'n'), [S('a'), P([[S('b'), S('c')], [S('n'), S('d')]]), S('e')])
}

// ── 3. paths: split, branches, rejoin ──────────────────────────────────────
{
  assert.deepEqual(E.splitAt([S('a'), S('b')], { seq: [], index: 1 }), [S('a'), P([[], []]), S('b')])
  assert.throws(() => E.splitAt([S('a'), P([[S('b')], [S('c')]])], { seq: [{ block: 1, branch: 0 }], index: 1 }), /one level of paths/)

  const at = { seq: [], index: 1 }
  const withPaths = [S('a'), P([[S('b')], [S('c')]]), S('d')]
  assert.deepEqual(E.addBranch(withPaths, at), [S('a'), P([[S('b')], [S('c')], []]), S('d')])
  assert.deepEqual(E.removeBranch(E.addBranch(withPaths, at), at, 2), withPaths)
  assert.deepEqual(E.removeBranch(withPaths, at, 1), [S('a'), S('b'), S('d')], 'one branch left: the split unwraps in place')

  assert.throws(() => E.setRejoin(withPaths, at, false), /Steps follow these paths, so they have to rejoin/)
  const last = [S('a'), P([[S('b')], [S('c')]])]
  assert.deepEqual(E.setRejoin(last, at, false), [S('a'), P([[S('b')], [S('c')]], false)])

  const open = [S('a'), P([[S('b')], [S('c')]], false)]
  assert.throws(() => E.insertStep(open, { seq: [], index: 2 }, 'n'), /Nothing can follow paths that end separately/)
  assert.throws(() => E.splitAt(open, { seq: [], index: 2 }), /Nothing can follow paths that end separately/)
  assert.throws(() => E.moveWithin([S('a'), S('b'), P([[S('c')], [S('d')]], false)], [], 2, 0), /have to stay last/)
}

// ── 4. prune ───────────────────────────────────────────────────────────────
assert.deepEqual(E.pruneEmptyPaths([S('a'), P([[], []]), S('b')]), [S('a'), S('b')])
assert.deepEqual(E.pruneEmptyPaths([S('a'), P([[S('b')], []]), S('c')]), [S('a'), P([[S('b')], []]), S('c')], 'one empty branch is a real shape (b is optional)')
assert.deepEqual(E.pruneEmptyPaths([P([[P([[], []])], [S('b')]])]), [P([[], [S('b')]])], 'nested all-empty splits go first')

// ── 5. canSave: shipped workflows, edited, still round-trip ────────────────
for (const t of workflowTemplates.filter(x => ['runbook-a-jira-to-diff', 'scan-security-to-dispatch'].includes(x.id))) {
  const steps = materializeTemplateSteps(t, Object.fromEntries(t.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const blocks = toStack(steps).blocks
  const added = E.newStep('agent', { agentSlug: 'sdlc-verifier', id: 'new-step' })
  const edited = E.insertStep(blocks, { seq: [], index: 1 }, added.id)
  const r = E.canSave(edited, [...steps, added])
  assert.ok(r.ok, `${t.id}: ${r.reason}`)
  assert.equal(r.steps.length, steps.length + 1)
  assert.deepEqual(stepIdsOf(toStack(r.steps).blocks).sort(), [...steps.map(s => s.id), 'new-step'].sort(), `${t.id}: every step survives`)
  const firstId = stepIdsOf(blocks)[0]
  assert.deepEqual(r.steps.find(s => s.id === firstId).next, ['new-step'], `${t.id}: the new step follows the first`)
  assert.ok(r.steps.every(s => Array.isArray(s.next)), 'every step has explicit next[]')
  const original = steps.find(s => s.id === firstId)
  assert.equal(r.steps.find(s => s.id === firstId).label, original.label, 'other fields untouched')
}
{
  // Removing a step reconnects its neighbours.
  const steps = [step('a', ['b']), step('b', ['c']), step('c', [])]
  const r = E.canSave(E.removeStep(toStack(steps).blocks, 'b'), steps)
  assert.ok(r.ok)
  assert.deepEqual(r.steps.map(s => [s.id, s.next]), [['a', ['c']], ['c', []]])
}
{
  // An empty split is dropped on save rather than saved as nothing.
  const steps = [step('a'), step('b')]
  const r = E.canSave([S('a'), P([[], []]), S('b')], steps)
  assert.ok(r.ok)
  assert.deepEqual(buildGraph(r.steps).succ, { a: ['b'], b: [] })
}
{
  // A stack whose graph would not draw again is refused with toStack's reason:
  // a branch that opens with its own split meets before the other branch does.
  const steps = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => step(id))
  const uneven = [S('a'), P([[P([[S('b')], [S('c')]]), S('e')], [S('d')]]), S('f')]
  const r = E.canSave(uneven, steps)
  assert.equal(r.ok, false, 'fromStack writes it, but toStack cannot draw it again')
  assert.match(r.reason, /brings "B" and "C" together before the other branches after "A" meet/)
  const bad = E.canSave([S('a'), P([[S('b')], [S('c')]], false), S('d')], steps.slice(0, 4))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /follow after paths that do not rejoin/)
}

// ── 6. new steps carry the config their kind needs ─────────────────────────
{
  const kinds = { 'agent': 'agent', 'jira': 'jira', 'jira-create': 'jira-create', 'notify': 'notify', 'loop': 'loop' }
  for (const [kind, expected] of Object.entries(kinds)) {
    const s = E.newStep(kind, { agentSlug: kind === 'agent' ? 'sdlc-verifier' : undefined })
    assert.equal(stepKind(s), expected, `${kind} reads back as ${expected}`)
    assert.equal(s.agentSlug, kind === 'agent' ? 'sdlc-verifier' : E.ACTION_AGENT[kind])
    assert.equal(s.label, kind === 'agent' ? 'sdlc-verifier' : E.ACTION_LABEL[kind])
    assert.match(s.id, /^[0-9a-f-]{36}$/)
  }
  assert.deepEqual(E.newStep('jira-create', {}).jira, { action: 'create' })
  assert.deepEqual(E.newStep('notify', {}).notify, { channel: '' })
  assert.throws(() => E.newStep('agent', {}), /Choose an agent/)
}

console.log('stackEdit: all checks passed')
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/test-stack-edit.mjs`
Expected: FAIL with `Cannot find module '.../shared/utils/stackEdit.ts'`.

- [ ] **Step 3: Write the module**

Create `shared/utils/stackEdit.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node scripts/test-stack-edit.mjs`
Expected: `stackEdit: all checks passed`.

If an assertion fails, first check whether the assertion or the module is wrong against the Global Constraints. Don't loosen an assertion to make it pass. Report any assertion you had to change, and why.

- [ ] **Step 5: Run the neighbouring tests**

Run: `node scripts/test-workflow-stack.mjs && node scripts/test-workflow-graph.mjs`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add shared/utils/stackEdit.ts scripts/test-stack-edit.mjs
git commit -m "feat(workflows): pure stack edits and the save check the builder needs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Build-mode stack components

**Files:**
- Create: `app/utils/buildStack.ts`, `app/components/WorkflowStackEditor.vue`, `app/components/BuildStackBlocks.vue`, `app/components/BuildStackCard.vue`, `app/components/ActionPicker.vue`

**Interfaces:**
- Consumes: everything from Task 1; `StackBlock`, `stepKind` from `~~/shared/utils/workflowStack`; `STEP_KIND_LABEL` and `STEP_KIND_ICON` from `~/utils/runStack` (Plan 1); `WorkflowStep` from `~/types`.
- Produces:
  - `<WorkflowStackEditor v-model:blocks v-model:steps v-model:selected :read-only :agents :trigger-summary />`
    - `blocks: StackBlock[]`
    - `steps: WorkflowStep[]`
    - `selected: Selection`
    - `agents: { slug: string, name: string }[]`
    - `triggerSummary: string`
  - `type Selection = { kind: 'trigger' } | { kind: 'step', stepId: string } | null`, exported from `~/utils/buildStack`
  - Edit errors are shown with `useToast()` as `{ title: 'Can't do that here', description: err.message, color: 'warning' }`, and the model is left unchanged.

- [ ] **Step 1: Context and choices (`app/utils/buildStack.ts`)**

```ts
import type { InjectionKey, Ref } from 'vue'
import type { WorkflowStep } from '~/types'
import type { ActionKind, SeqPath, Slot } from '~~/shared/utils/stackEdit'

export type Selection = { kind: 'trigger' } | { kind: 'step', stepId: string } | null

/** What a "+" can add. Approval is a flag on the step below; split adds paths. */
export type PickerChoice =
  | { kind: 'action', action: ActionKind, agentSlug?: string }
  | { kind: 'approval' }
  | { kind: 'split' }

export interface BuildStackContext {
  readOnly: Ref<boolean>
  stepOf: (id: string) => WorkflowStep | undefined
  agentName: (slug: string) => string
  agents: Ref<{ slug: string, name: string }[]>
  isSelected: (id: string) => boolean
  select: (stepId: string) => void
  apply: (choice: PickerChoice, slot: Slot) => void
  remove: (stepId: string) => void
  move: (seq: SeqPath, from: number, to: number) => void
  addBranch: (at: Slot) => void
  removeBranch: (at: Slot, branch: number) => void
  setRejoin: (at: Slot, rejoin: boolean) => void
  /** Writes the branch's first step's runWhen; empty clears it. */
  setCondition: (firstStepId: string, artifact: string) => void
  clearApproval: (stepId: string) => void
}

export const BUILD_STACK_KEY: InjectionKey<BuildStackContext> = Symbol('build-stack')
```

- [ ] **Step 2: `WorkflowStackEditor.vue`**

```vue
<script setup lang="ts">
import type { WorkflowStep } from '~/types'
import type { StackBlock } from '~~/shared/utils/workflowStack'
import * as E from '~~/shared/utils/stackEdit'
import { BUILD_STACK_KEY, type PickerChoice, type Selection } from '~/utils/buildStack'

/**
 * The workflow as an editable stack: the trigger card, then every step, with a
 * "+" between cards. Owns the edits (shared/utils/stackEdit.ts) and hands the
 * results back through v-model; the page decides when to save.
 */
const props = defineProps<{
  blocks: StackBlock[]
  steps: WorkflowStep[]
  selected: Selection
  readOnly: boolean
  agents: { slug: string, name: string }[]
  triggerSummary: string
}>()
const emit = defineEmits<{
  'update:blocks': [StackBlock[]]
  'update:steps': [WorkflowStep[]]
  'update:selected': [Selection]
}>()
const toast = useToast()

const stepById = computed(() => new Map(props.steps.map(s => [s.id, s])))

/** Run an edit; a refusal is told to the person and changes nothing. */
function edit(fn: () => void) {
  try { fn() }
  catch (err) { toast.add({ title: 'Can’t do that here', description: err instanceof Error ? err.message : String(err), color: 'warning' }) }
}
const setBlocks = (b: StackBlock[]) => emit('update:blocks', b)
const patchStep = (id: string, patch: Partial<WorkflowStep>) =>
  emit('update:steps', props.steps.map(s => (s.id === id ? { ...s, ...patch } : s)))

function apply(choice: PickerChoice, slot: E.Slot) {
  edit(() => {
    if (choice.kind === 'split') return setBlocks(E.splitAt(props.blocks, slot))
    if (choice.kind === 'approval') {
      const below = E.seqAt(props.blocks, slot.seq)[slot.index]
      if (!below || below.kind !== 'step') throw new Error('An approval goes above a step. Add the step first.')
      return patchStep(below.stepId, { approval: true })
    }
    const s = E.newStep(choice.action, { agentSlug: choice.agentSlug }) as WorkflowStep
    const blocks = E.insertStep(props.blocks, slot, s.id)
    emit('update:steps', [...props.steps, s])
    setBlocks(blocks)
    emit('update:selected', { kind: 'step', stepId: s.id })
  })
}

provide(BUILD_STACK_KEY, {
  readOnly: toRef(props, 'readOnly'),
  stepOf: id => stepById.value.get(id),
  agentName: slug => props.agents.find(a => a.slug === slug)?.name ?? slug,
  agents: toRef(props, 'agents'),
  isSelected: id => props.selected?.kind === 'step' && props.selected.stepId === id,
  select: id => emit('update:selected', { kind: 'step', stepId: id }),
  apply,
  remove: id => edit(() => {
    setBlocks(E.removeStep(props.blocks, id))
    emit('update:steps', props.steps.filter(s => s.id !== id))
    if (props.selected?.kind === 'step' && props.selected.stepId === id) emit('update:selected', null)
  }),
  move: (seq, from, to) => edit(() => setBlocks(E.moveWithin(props.blocks, seq, from, to))),
  addBranch: at => edit(() => setBlocks(E.addBranch(props.blocks, at))),
  removeBranch: (at, branch) => edit(() => setBlocks(E.removeBranch(props.blocks, at, branch))),
  setRejoin: (at, rejoin) => edit(() => setBlocks(E.setRejoin(props.blocks, at, rejoin))),
  setCondition: (id, artifact) => patchStep(id, { runWhen: artifact.trim() ? { artifact: artifact.trim() } : undefined }),
  clearApproval: id => patchStep(id, { approval: undefined, gateRole: undefined }),
})
</script>

<template>
  <div class="max-w-2xl mx-auto flex flex-col items-center">
    <button
      class="w-full rounded-lg px-3 py-2 t-small flex items-center gap-2 text-left focus-ring"
      :style="{ background: 'var(--surface-raised)', border: `1px solid ${selected?.kind === 'trigger' ? 'var(--accent)' : 'var(--border-subtle)'}` }"
      data-testid="trigger-card" @click="emit('update:selected', { kind: 'trigger' })"
    >
      <UIcon name="i-lucide-radar" class="size-4 shrink-0" style="color: var(--warning);" />
      <span class="min-w-0">
        <span class="block t-label text-label">Trigger</span>
        <span class="block truncate" style="color: var(--text-primary);">{{ triggerSummary }}</span>
      </span>
    </button>
    <div class="w-0.5 h-3" style="background: var(--border-default);" aria-hidden="true" />
    <BuildStackBlocks :blocks="blocks" :seq="[]" />
    <p v-if="!blocks.length && readOnly" class="t-small text-label mt-2">No steps yet.</p>
  </div>
</template>
```

- [ ] **Step 3: `ActionPicker.vue`**

```vue
<script setup lang="ts">
import type { PickerChoice } from '~/utils/buildStack'
import { ACTION_LABEL, type ActionKind } from '~~/shared/utils/stackEdit'
import { STEP_KIND_ICON } from '~/utils/runStack'

/** The "+" between cards: what a step does, then (for an agent) which agent. */
const props = defineProps<{ agents: { slug: string, name: string }[], allowSplit: boolean, allowApproval: boolean }>()
const emit = defineEmits<{ choose: [PickerChoice] }>()
const open = ref(false)
const pickingAgent = ref(false)
const q = ref('')
const shown = computed(() => props.agents.filter(a => `${a.name} ${a.slug}`.toLowerCase().includes(q.value.toLowerCase())))
const RUNNER: ActionKind[] = ['jira', 'jira-create', 'notify', 'loop']
function choose(c: PickerChoice) { emit('choose', c); open.value = false; pickingAgent.value = false; q.value = '' }
</script>

<template>
  <UPopover v-model:open="open">
    <button class="size-6 rounded-full grid place-items-center t-small focus-ring" style="background: var(--surface-raised); border: 1px solid var(--border-default); color: var(--text-tertiary);" aria-label="Add a step here">+</button>
    <template #content>
      <div class="w-64 p-2 space-y-0.5 t-small" role="menu">
        <template v-if="!pickingAgent">
          <p class="t-label text-label px-2 py-1">Add a step</p>
          <button class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="pickingAgent = true">
            <UIcon :name="STEP_KIND_ICON.agent" class="size-4" />{{ ACTION_LABEL.agent }}
          </button>
          <button v-for="k in RUNNER" :key="k" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'action', action: k })">
            <UIcon :name="STEP_KIND_ICON[k]" class="size-4" />{{ ACTION_LABEL[k] }}
          </button>
          <button v-if="allowApproval" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'approval' })">
            <UIcon name="i-lucide-hand" class="size-4" />Ask for approval
          </button>
          <button v-if="allowSplit" class="w-full flex items-center gap-2 px-2 py-1.5 rounded hover-bg text-left" role="menuitem" @click="choose({ kind: 'split' })">
            <UIcon name="i-lucide-split" class="size-4" />Split into paths
          </button>
        </template>
        <template v-else>
          <button class="t-small text-label px-2 py-1 focus-ring" @click="pickingAgent = false">&larr; Back</button>
          <input v-model="q" class="field-search w-full" placeholder="Find an agent" aria-label="Find an agent">
          <div class="max-h-64 overflow-y-auto">
            <button v-for="a in shown" :key="a.slug" class="w-full text-left px-2 py-1.5 rounded hover-bg" role="menuitem" @click="choose({ kind: 'action', action: 'agent', agentSlug: a.slug })">
              <span class="block" style="color: var(--text-primary);">{{ a.name }}</span>
              <span class="block font-mono text-label">{{ a.slug }}</span>
            </button>
            <p v-if="!shown.length" class="px-2 py-1 text-label">No agent matches.</p>
          </div>
        </template>
      </div>
    </template>
  </UPopover>
</template>
```

- [ ] **Step 4: `BuildStackCard.vue`**

```vue
<script setup lang="ts">
import { stepKind } from '~~/shared/utils/workflowStack'
import { BUILD_STACK_KEY } from '~/utils/buildStack'
import { STEP_KIND_ICON, STEP_KIND_LABEL } from '~/utils/runStack'

/** One step in the builder: what it is, what it's set to, and select/delete. */
const props = defineProps<{ stepId: string }>()
const ctx = inject(BUILD_STACK_KEY)!
const step = computed(() => ctx.stepOf(props.stepId))
const kind = computed(() => stepKind(step.value))
const selected = computed(() => ctx.isSelected(props.stepId))
const confirming = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
function del() {
  if (!confirming.value) { confirming.value = true; timer = setTimeout(() => { confirming.value = false }, 4000); return }
  confirming.value = false
  ctx.remove(props.stepId)
}
onUnmounted(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <article
    v-if="step" :id="`build-step-${stepId}`" :data-step="stepId"
    class="w-full rounded-lg grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"
    :style="{ background: 'var(--surface-raised)', border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`, boxShadow: selected ? '0 0 0 3px var(--accent-muted)' : 'none' }"
  >
    <UIcon :name="STEP_KIND_ICON[kind]" class="size-4 shrink-0" style="color: var(--text-accent);" />
    <button class="min-w-0 text-left focus-ring" :aria-pressed="selected" @click="ctx.select(stepId)">
      <span class="block t-small text-label">{{ STEP_KIND_LABEL[kind] }}</span>
      <span class="block t-ui font-medium truncate" style="color: var(--text-primary);">{{ step.label }}</span>
      <span class="block t-small text-label truncate">
        <template v-if="kind === 'agent'">{{ ctx.agentName(step.agentSlug) }}</template>
        <template v-if="step.monitorSlug"> · Check</template>
        <template v-if="step.produces?.length"> · {{ step.produces.length }} {{ step.produces.length === 1 ? 'file' : 'files' }}</template>
        <template v-if="(step.maxVisits ?? 0) > 1"> · retries up to {{ step.maxVisits }}</template>
      </span>
    </button>
    <UButton
      v-if="!ctx.readOnly.value" size="xs" :variant="confirming ? 'solid' : 'ghost'" :color="confirming ? 'error' : 'neutral'"
      :icon="confirming ? undefined : 'i-lucide-trash-2'" :label="confirming ? 'Confirm delete' : undefined"
      :aria-label="`Delete ${step.label}`" @click="del"
    />
  </article>
</template>
```

- [ ] **Step 5: `BuildStackBlocks.vue` (recursive)**

```vue
<script setup lang="ts">
import type { StackBlock } from '~~/shared/utils/workflowStack'
import type { SeqPath } from '~~/shared/utils/stackEdit'
import { BUILD_STACK_KEY } from '~/utils/buildStack'

/**
 * One sequence of the builder's stack. A "+" sits before every block and after
 * the last; steps can be dragged among their siblings; paths show each branch's
 * condition, the rejoin toggle, and add/remove branch.
 */
const props = defineProps<{ blocks: StackBlock[], seq: SeqPath }>()
const ctx = inject(BUILD_STACK_KEY)!
const nested = computed(() => props.seq.length > 0)
const endsOpen = computed(() => { const l = props.blocks.at(-1); return l?.kind === 'paths' && !l.rejoin })
const firstStepOf = (branch: StackBlock[]) => (branch[0]?.kind === 'step' ? branch[0].stepId : null)
const seqKey = JSON.stringify(props.seq)

let dragFrom: number | null = null
function onDragStart(e: DragEvent, i: number) { dragFrom = i; e.dataTransfer?.setData('text/x-stack-seq', seqKey) }
function onDrop(e: DragEvent, to: number) {
  if (dragFrom === null || e.dataTransfer?.getData('text/x-stack-seq') !== seqKey) return
  const from = dragFrom
  dragFrom = null
  if (from !== to) ctx.move(props.seq, from, to)
}
</script>

<template>
  <template v-for="(b, i) in blocks" :key="b.kind === 'step' ? b.stepId : `paths-${i}`">
    <div v-if="!ctx.readOnly.value" class="flex flex-col items-center">
      <ActionPicker :agents="ctx.agents.value" :allow-split="!nested" :allow-approval="b.kind === 'step' && !ctx.stepOf(b.stepId)?.approval" @choose="(c) => ctx.apply(c, { seq, index: i })" />
      <div class="w-0.5 h-3" style="background: var(--border-default);" aria-hidden="true" />
    </div>
    <div v-else-if="i > 0" class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />

    <div
      v-if="b.kind === 'step'" class="w-full space-y-1"
      :draggable="!ctx.readOnly.value" @dragstart="(e) => onDragStart(e, i)" @dragover.prevent @drop="(e) => onDrop(e, i)"
    >
      <section
        v-if="ctx.stepOf(b.stepId)?.approval"
        class="w-full rounded-lg px-3 py-2 flex items-center gap-2 t-small"
        style="background: var(--surface-raised); border: 1px dashed var(--border-default); color: var(--text-secondary);"
      >
        <UIcon name="i-lucide-hand" class="size-3.5" />
        <span class="flex-1">Approval by {{ ctx.stepOf(b.stepId)?.gateRole ?? 'anyone' }} · can send the work back to any earlier step, up to 2 times</span>
        <UButton v-if="!ctx.readOnly.value" size="xs" variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Remove this approval" @click="ctx.clearApproval(b.stepId)" />
      </section>
      <BuildStackCard :step-id="b.stepId" />
    </div>

    <div
      v-else class="w-full rounded-xl p-3 space-y-2" style="border: 1px dashed var(--border-default);"
      role="group" :aria-label="b.rejoin ? 'Paths that run in parallel and rejoin' : 'Paths that each end separately'"
    >
      <div class="grid gap-3 max-sm:!grid-cols-1" :style="{ gridTemplateColumns: `repeat(${b.branches.length}, minmax(0, 1fr))` }">
        <div v-for="(br, j) in b.branches" :key="j" class="flex flex-col items-stretch gap-1 min-w-0">
          <div class="flex items-center gap-1">
            <input
              v-if="firstStepOf(br) && !ctx.readOnly.value"
              class="field-input t-small font-mono flex-1 min-w-0" :value="ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact ?? ''"
              placeholder="Always (or: runs if this file exists)" :aria-label="`Condition for path ${j + 1}`"
              @change="(e) => ctx.setCondition(firstStepOf(br)!, (e.target as HTMLInputElement).value)"
            >
            <p v-else class="t-small font-mono text-label truncate flex-1">{{ firstStepOf(br) ? (ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact ? `If ${ctx.stepOf(firstStepOf(br)!)?.runWhen?.artifact} exists` : 'Always') : 'Goes straight on' }}</p>
            <UButton v-if="!ctx.readOnly.value" size="xs" variant="ghost" color="neutral" icon="i-lucide-x" :aria-label="`Remove path ${j + 1}`" @click="ctx.removeBranch({ seq, index: i }, j)" />
          </div>
          <BuildStackBlocks :blocks="br" :seq="[...seq, { block: i, branch: j }]" />
        </div>
      </div>
      <div v-if="!ctx.readOnly.value" class="flex flex-wrap items-center gap-3 t-small">
        <UButton size="xs" variant="soft" icon="i-lucide-plus" label="Add path" @click="ctx.addBranch({ seq, index: i })" />
        <label class="flex items-center gap-1.5"><input type="checkbox" :checked="b.rejoin" @change="(e) => ctx.setRejoin({ seq, index: i }, (e.target as HTMLInputElement).checked)"> Rejoin after paths</label>
      </div>
    </div>
  </template>

  <div v-if="!ctx.readOnly.value && !endsOpen" class="flex flex-col items-center">
    <ActionPicker :agents="ctx.agents.value" :allow-split="!nested" :allow-approval="false" @choose="(c) => ctx.apply(c, { seq, index: blocks.length })" />
  </div>
</template>
```

- [ ] **Step 6: Typecheck**

Run: `npx nuxt typecheck`
Expected: 0 errors. If a UButton `@click` assignment fails TS2322, wrap it in a block-bodied arrow, the same fix Plan 1 used.

- [ ] **Step 7: Commit**

```bash
git add app/utils/buildStack.ts app/components/WorkflowStackEditor.vue app/components/BuildStackBlocks.vue app/components/BuildStackCard.vue app/components/ActionPicker.vue
git commit -m "feat(workflows): build-mode stack editor with typed actions and paths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Step drawer and its fields

**Files:**
- Create: `app/components/StepDrawer.vue`, `app/components/StepConfigFields.vue`
- Source to move from (read it first, and match by content): `app/pages/workflows/[slug].vue`
  - the step settings modal's script, lines ~443-634: `agentOptions`, `monitorOptions`, `contextModeOptions`, `summarise`, and every `settings*` computed
  - `producesError`, lines ~665-681
  - the modal template, lines ~1171-1359

**Interfaces:**
- Consumes: `WorkflowStep`; `stepKind`; `ACTION_LABEL`; `ROLES` from `~~/shared/types/role`.
- Produces:
  - `<StepDrawer :step :agents :channels :parameter-names :read-only @patch="(patch: Partial<WorkflowStep>) => …" />`
    - `agents: { slug: string, name: string, description?: string }[]`
    - `channels: { id: string, name: string }[]`, with the shape `/api/channels` returns (check the fields the old modal's `<select>` used)
  - `<StepConfigFields :step :kind :channels :parameter-names :read-only @patch />`
  - `producesError(names: string[]): string | null`, moved to `app/utils/produces.ts`. The page's save guard uses it too.

- [ ] **Step 1: Move `producesError` to `app/utils/produces.ts`**

Cut the function out of `[slug].vue` word for word, with its doc comment, and export it. The page imports it from there in Task 5.

- [ ] **Step 2: Create `StepConfigFields.vue`**

This moves the modal's per-kind fields into one component. Rules:
- Each field reads from `props.step` and emits `patch` with the same key and clearing rules the old `settings*` computeds used. Keep their setters' behaviour exactly: empty clears the key, `routes` parses `value: slug` lines, `maxVisits` is clamped to 1-20, and `contextMode` of `'predecessors'` is written as `undefined`.
- Choose fields by `kind` (`stepKind(step)`), not by agent slug. That replaces the three `v-if="settingsStep.agentSlug === 'sdlc-…'"` checks.

Sections:
- **`agent`:**
  - Files this step must leave behind: `produces`, one per line, with the `producesError` message under the textarea
  - What this step is shown from upstream: `contextMode`
  - This step writes tests and code together: `testsUnlocked`, with its HelpTip
  - Max visits per run: `maxVisits`
  - Monitor agent: `monitorSlug`, from the same options as `monitorOptions`
  - Continue the previous step's session: `continuesSession`
- **`jira`:** transition, "Post the outcome comment", "Attach the run's evidence files", which are `jira.transition`, `jira.comment` and `jira.attach`. Keep `action` when patching.
- **`jira-create`:** a source artifact, `jira.source`, with the hint "The approved drafts file, e.g. approved-drafts.json". Keep `action: 'create'`.
- **`notify`:** channel select and message, `notify.channel` and `notify.message`. The message shows once a channel is chosen, as before.
- **`loop`:** the dispatcher block as it is today: `source` / `fromParameter` (either one), `itemParameter`, `join`, `routeBy` (only when there is a source), `routes`, and the fallback `slug`. The `fromParameter` select uses `parameterNames`.
- **All kinds,** at the bottom: "Run only when this file has content", which is `runWhen.artifact`.

- [ ] **Step 3: Create `StepDrawer.vue`**

```vue
<script setup lang="ts">
import type { WorkflowStep } from '~/types'
import { stepKind } from '~~/shared/utils/workflowStack'
import { ACTION_LABEL } from '~~/shared/utils/stackEdit'
import { ROLES, type Role } from '~~/shared/types/role'

/**
 * One step's settings, in two tabs: Setup (what the step is, which agent, its
 * approval) and Configure (the fields for its kind). A step's kind is fixed
 * once added: to change it, add the other kind and delete this one.
 */
const props = defineProps<{
  step: WorkflowStep
  agents: { slug: string, name: string, description?: string }[]
  channels: { id: string, name: string }[]
  parameterNames: string[]
  readOnly: boolean
}>()
const emit = defineEmits<{ patch: [Partial<WorkflowStep>] }>()
const tab = ref<'setup' | 'configure'>('setup')
watch(() => props.step.id, () => { tab.value = 'setup' })
const kind = computed(() => stepKind(props.step))
const agentOptions = computed(() => props.agents.map(a => ({ value: a.slug, label: a.name })))
</script>

<template>
  <div class="space-y-3">
    <div>
      <p class="t-label text-label">{{ ACTION_LABEL[kind] }}</p>
      <input
        :value="step.label" :disabled="readOnly" class="field-input w-full t-ui font-medium" aria-label="Step name"
        @change="(e) => emit('patch', { label: (e.target as HTMLInputElement).value.trim() || step.label })"
      >
    </div>
    <div class="flex gap-4 border-b" style="border-color: var(--border-subtle);" role="tablist">
      <button v-for="t in (['setup', 'configure'] as const)" :key="t" role="tab" :aria-selected="tab === t" class="t-small py-1.5 -mb-px focus-ring" :style="tab === t ? 'border-bottom: 2px solid var(--accent); color: var(--text-primary);' : 'color: var(--text-tertiary);'" @click="tab = t">
        {{ t === 'setup' ? 'Setup' : 'Configure' }}
      </button>
    </div>

    <div v-if="tab === 'setup'" class="space-y-3 t-small">
      <div v-if="kind === 'agent'" class="field-group">
        <label class="field-label">Agent</label>
        <USelectMenu :model-value="step.agentSlug" :items="agentOptions" value-key="value" :disabled="readOnly" class="w-full" @update:model-value="(v: string) => emit('patch', { agentSlug: v })" />
      </div>
      <p v-else class="text-label">Runs in the pipeline itself, with no model call.</p>
      <label class="flex items-center gap-2">
        <input type="checkbox" :checked="!!step.approval" :disabled="readOnly" @change="(e) => emit('patch', { approval: (e.target as HTMLInputElement).checked || undefined })">
        Ask for approval before this step runs
      </label>
      <div v-if="step.approval" class="field-group">
        <label class="field-label">Who approves</label>
        <select class="field-input" :value="step.gateRole ?? ''" :disabled="readOnly" @change="(e) => emit('patch', { gateRole: ((e.target as HTMLSelectElement).value || undefined) as Role | undefined })">
          <option value="">Anyone who can answer gates</option>
          <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
    </div>

    <StepConfigFields v-else :step="step" :kind="kind" :channels="channels" :parameter-names="parameterNames" :read-only="readOnly" @patch="(p) => emit('patch', p)" />
  </div>
</template>
```

If `USelectMenu` doesn't take `value-key` in this Nuxt UI version, use the component and props the old modal used for its agent picker (`USelectDropdown`, line ~1180). Match the old modal.

- [ ] **Step 4: Typecheck**

Run: `npx nuxt typecheck`. Expected: 0 errors. The drawer isn't mounted anywhere yet; Task 5 mounts it.

- [ ] **Step 5: Commit**

```bash
git add app/components/StepDrawer.vue app/components/StepConfigFields.vue app/utils/produces.ts
git commit -m "feat(workflows): step drawer with per-kind settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Trigger drawer and the Inputs editor

**Files:**
- Create: `app/components/WorkflowInputsEditor.vue`, `app/components/TriggerDrawer.vue`
- Source to move from: `[slug].vue`
  - the parameters modal script, lines ~636-663: `addParameter`, `removeParameter`, `parameterNameError`
  - the modal template, lines ~1102-1169
  - the group and notify-channel selects, lines ~830-862, with `groupHint`

**Interfaces:**
- Produces:
  - `<WorkflowInputsEditor v-model="parameters: WorkflowParameter[]" :read-only />`. Its heading reads "Workflow inputs", and it has the "Add input" button.
  - `<TriggerDrawer v-model:tab :workflow-slug :workflow-name :saved-parameters :schedulable v-model:parameters v-model:group v-model:notify-channel :groups :channels :read-only />`
    - `tab: 'triggers' | 'inputs' | 'settings'`
    - Tab buttons carry `data-testid="trigger-tab-triggers"`, `"trigger-tab-inputs"` and `"trigger-tab-settings"`.
  - A `triggerSummary(schedules, watches): string` helper in `app/utils/buildStack.ts`. The trigger card uses it. It reads, for example, "Jira watch SUP queue · 2 schedules", or "Run manually" when there are none.

- [ ] **Step 1: `WorkflowInputsEditor.vue`.** Move the modal body's markup and the three functions word for word. Change the component to take and emit `modelValue`, and make every add, remove and edit emit a new array. Keep `isValidParameterName` and `RESERVED_PARAM_PROJECT_DIR` from `~~/shared/utils/workflowParameters`.

- [ ] **Step 2: `TriggerDrawer.vue`.**
  - **Triggers tab:**
    - `<WorkflowSchedulePanel :workflow-slug :workflow-name :parameters="savedParameters" :schedulable />`, unchanged. It brings its own "Add schedule" and `schedule-card`s.
    - Below it, "Jira watches": `useWatches()`, filtered on the client to `watch.workflowSlug === workflowSlug`. Each row shows the name, the JQL cut to 80 characters, and enabled/disabled, and links to `/watches`.
    - A "Add Jira watch" link to `/watches`.
    - Call `useWatches().fetchAll()` on mount, and ignore failures, the same way the page fetches schedules today.
  - **Inputs tab:** `<WorkflowInputsEditor v-model="parameters" :read-only />`.
  - **Settings tab:**
    - A `<select>` with `<label>Concurrency group</label>` bound to `group`, and the old `groupHint` text under it.
    - The notification channel `<select>` bound to `notifyChannel`, with the old markup and options.

- [ ] **Step 3: `triggerSummary` in `app/utils/buildStack.ts`.**

```ts
export function triggerSummary(schedules: { name: string }[], watches: { name: string }[]): string {
  const parts = [
    ...watches.map(w => `Jira watch ${w.name}`),
    ...(schedules.length ? [`${schedules.length} ${schedules.length === 1 ? 'schedule' : 'schedules'}`] : []),
  ]
  return parts.length ? parts.join(' · ') : 'Run manually'
}
```

- [ ] **Step 4: Typecheck** (`npx nuxt typecheck`, 0 errors), then **commit**:

```bash
git add app/components/WorkflowInputsEditor.vue app/components/TriggerDrawer.vue app/utils/buildStack.ts
git commit -m "feat(workflows): trigger drawer with schedules, watches, inputs and settings

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The builder page on the stack

**Files:**
- Rewrite: `app/pages/workflows/[slug].vue`

**Interfaces:**
- Consumes: Tasks 1-4; `RunStack` (Plan 1); `useWorkflowRun(slug)`; `useRunActionToasts` from `app/composables/useRun.ts`; `useSchedules().forWorkflow`; `useWatches`; `WorkflowRunModal`; `ExternalChangeBanner`; `useUnsavedChanges`; `useExternalChange`; `useAutoRefresh`.

**What stays from the current page.** Keep each item's code, lifted word for word except for the listed edits:
- **Script lines ~14-61:** the setup, `readOnly`, `useWorkflowRun`, `useSchedules`, `runInitial`, and `applyQueryIntent`. Edit: `?tab=schedule` now sets `selected = { kind: 'trigger' }` and `drawerTab = 'triggers'`, and `?tab=inputs` sets the Inputs tab, instead of `activeTab`.
- `cloneRun`, `attachRun`, `closeRun` and the run-status computeds (~62-97). They now drive the Build/Run switch instead of the slideover.
- The workflow refs, dirty tracking, groups fetch, `applyWorkflow`, the `onMounted` loading, `useUnsavedChanges`, `useExternalChange`, `keepMine` and `useAutoRefresh` (~99-216).
- The channels fetch (~523-530).
- `save()`, `deleteWorkflow()`, `startRun()` and `parallelHint` (~683-758). Edits to `save()` are listed below.

**What goes:**
- Vue Flow: imports, `nodes`, `edges`, `defaultPosition`, `fitView`, `onConnect`, `onEdgeClick`, `onNodeDragStop` and `materializeEdges`. `fromStack` now writes explicit `next[]`.
- The derived rework edges.
- The palette, `filteredAgents`, `addStep`, `onDrop` and `removeStep`.
- The settings modal, the parameters modal and the mobile agent picker.
- The tabs strip, `activeTab`, the `WorkflowRunBar` block, the slideover and the "Workflow complete" banner. RunHeader shows status now.

**New state:**

```ts
import { toStack, type StackBlock } from '~~/shared/utils/workflowStack'
import { canSave } from '~~/shared/utils/stackEdit'
import { triggerSummary, type Selection } from '~/utils/buildStack'
import { producesError } from '~/utils/produces'

const blocks = ref<StackBlock[]>([])
/** Why the stack can't show this workflow, when it can't: the page is then read-only. */
const notDrawable = ref<string | null>(null)
const selected = ref<Selection>(null)
const drawerTab = ref<'triggers' | 'inputs' | 'settings'>('triggers')
const mode = ref<'build' | 'run'>('build')
const editable = computed(() => !readOnly.value && !notDrawable.value)

/** Called from applyWorkflow after the steps are set. */
function layOut() {
  const r = toStack(workflowSteps.value)
  if (r.ok) { blocks.value = r.blocks; notDrawable.value = null }
  else { blocks.value = workflowSteps.value.map(s => ({ kind: 'step' as const, stepId: s.id })); notDrawable.value = r.reason }
}
```

**Save edits.** Before the PUT:

```ts
const r = canSave(blocks.value, workflowSteps.value)
if (!r.ok) { toast.add({ title: 'This can’t be saved yet', description: r.reason, color: 'warning' }); return }
const bad = r.steps.find(s => producesError(s.produces ?? []))
if (bad) { toast.add({ title: `Fix the files list on ${bad.label}`, description: producesError(bad.produces ?? [])!, color: 'warning' }); return }
workflowSteps.value = r.steps
```

The payload then sends `steps: r.steps`. After a successful save, call `layOut()` so the layout reflects the file. Blocks are part of what "unsaved" means: add `JSON.stringify(blocks.value)` to whatever `isDirty` compares against its saved snapshot. Take the snapshot in `applyWorkflow`, after `layOut()`.

**Template, top to bottom:**
1. **Header.** Keep the back link, the editable name, and "Read-only" when it applies. Then:
   - the **Build | Run** switch, a `role="tablist"` with two buttons. "Run" is labelled `Run #${run.id.slice(0, 6)}` when there is a current run, and is disabled when there are no runs. Beside it, when in Run mode and `runs.length > 1`, a small select of recent runs that calls `attachRun(id)`.
   - the buttons **Inputs (N)** (selects the trigger with the Inputs tab), **Run** (opens `WorkflowRunModal`, disabled unless `canRun`), **Save** (hidden when read-only, disabled unless dirty) and **Delete**.
2. **The description bar.** Keep the existing one, with `parallelHint`.
3. **`ExternalChangeBanner`** as today, and, when `notDrawable`, a banner: "This workflow's shape can't be shown as a stack, so it opens read-only. {reason}".
4. **Body in build mode.** A two-column layout, `lg:grid-cols-[minmax(0,1fr)_22rem]`:
   - left: `<WorkflowStackEditor v-model:blocks="blocks" v-model:steps="workflowSteps" v-model:selected="selected" :read-only="!editable" :agents :trigger-summary />`
   - right, from `lg` up: an `aside` holding the drawer for the current selection:
     - trigger → `TriggerDrawer`
     - step → `StepDrawer`, whose `@patch` merges into that step in `workflowSteps`
     - nothing → the hint "Select the trigger or a step to change it."
   - Below `lg`, the same drawer content renders in `<USlideover side="bottom" :open="!!selected" @update:open="(v) => { if (!v) selected = null }">`. Read `USlideover`'s props in this Nuxt UI version; if `side` is named differently, use its bottom placement.
5. **Body in run mode.** `<RunStack v-if="run" :run :logs @… />`, wired to `useWorkflowRun`'s functions through `useRunActionToasts`:
   - continue → `onContinue`, respond → `onRespond`, reject → `onReject`, rework → `onRework`, note → `onNote`, stop → `onStop`, restart → `onRestart`
   - clone → `cloneRun()` (which prefills and opens `WorkflowRunModal`)

   If `useRunActionToasts`'s parameter type doesn't accept `useWorkflowRun`'s return value, widen that `Pick<…>` in `useRun.ts` to a structural type listing just the members it calls. Don't cast.
6. **`WorkflowRunModal`,** unchanged. After `startRun`, set `mode = 'run'`. A `?run=` or `?clone=` query also switches to Run mode.

**Agents for the editor and drawer:** `agents.value.map(a => ({ slug: a.slug, name: a.frontmatter.name || a.slug, description: summarise(a.frontmatter.description) }))`. Move `summarise` into this page's script if it lived in the removed modal code.

- [ ] **Step 1: Rewrite the page as described.** Keep each lifted block's comments.
- [ ] **Step 2: Typecheck.** Run `npx nuxt typecheck`; expect 0 errors.
- [ ] **Step 3: Check it in a browser.** Use a throwaway `/tmp` Playwright script against a seeded disposable `CLAUDE_DIR` that holds a Runbook-A-shaped workflow, a scan-shaped one, and one with a back edge (`next` pointing at an earlier step). Take screenshots into `/home/alepo/repos/agent-manager-run-stack-spec/.superpowers/sdd/<plan workspace>/shots/task-5/`. Assert:
  - **Runbook A** opens as a stack: one paths block with three branches that rejoin, and an approval card above its gated step.
  - **Editing:**
    - Add "Post to a channel" after the first step and pick a channel in Configure.
    - Add an agent step through the picker's agent search.
    - Drag the new agent step up by one.
    - Add an approval above the new agent step, choosing role `qa`.
    - Delete a step with two clicks.
    - **Save** is enabled, and Save succeeds.
    - Reload: the stack shows every edit.
    - Read the JSON file from the disposable `CLAUDE_DIR`: every step has explicit `next`, the notifier has `notify.channel` set, and the approval has `gateRole: 'qa'`.
  - **Scan workflow:** paths that don't rejoin, and each branch condition shows its `runWhen`. Editing a condition and saving writes that step's `runWhen`.
  - **Back-edge workflow:** opens read-only, with the banner reason and no "+" buttons.
  - **`?tab=schedule`** opens the trigger drawer on Triggers, with `schedule-card` visible when a schedule is seeded.
  - **"Inputs (N)"** opens the Inputs tab, and "Add input" works.
  - **Run:** the modal opens, Start switches to Run mode, and `RunStack` shows the run (seed a run record, or start one with a stub agent caller the way the smokes do).
  - **At 400px:** the drawer opens as a bottom sheet, and the body doesn't scroll sideways.
- [ ] **Step 4: Commit.**

```bash
git add app/pages/workflows/[slug].vue app/composables/useRun.ts
git commit -m "feat(workflows): the builder edits a stack instead of a canvas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Remove the old builder pieces, update the smokes, add a builder smoke

**Files:**
- Delete: `app/components/WorkflowNode.vue`, `app/components/WorkflowRunBar.vue`, `app/components/WorkflowRunPanel.vue`, `app/components/RunLiveCard.vue`
- Modify: `app/components/RunHeader.vue` and `app/components/RunGate.vue` doc comments, which mention WorkflowRunPanel. Say they are shared by RunStack.
- Modify: `e2e/schedules-and-parameters.smoke.mjs`, `e2e/concurrency-groups.smoke.mjs`, `e2e/workflow-run-panel.smoke.mjs`
- Create: `e2e/workflow-builder.smoke.mjs`

- [ ] **Step 1: Delete the four components.** `grep -rn "WorkflowNode\|WorkflowRunBar\|WorkflowRunPanel\|RunLiveCard" app/ e2e/ server/ shared/` must then show only comments you are about to reword. Leave `@vue-flow/*` and the `.vue-flow*` CSS alone, because `graph.vue` uses them.

- [ ] **Step 2: `e2e/schedules-and-parameters.smoke.mjs`.**
  - Replace the clicks on `workflow-tab-schedule` / `workflow-tab-canvas` with the trigger card (`[data-testid="trigger-card"]`) and `[data-testid="trigger-tab-triggers"]`.
  - `?tab=schedule` must still land with `schedule-card` visible.
  - "Inputs (2)" → "Workflow inputs" → "Add input" keep their labels.
  - Every changed assertion must still be able to fail.

- [ ] **Step 3: `e2e/concurrency-groups.smoke.mjs`.** Before `getByLabel('Concurrency group')`, open the trigger drawer's Settings tab: click `trigger-card`, then `trigger-tab-settings`. Section 3 (/runs) must stay green. Section 5 is a known baseline failure; it must fail the same way.

- [ ] **Step 4: `e2e/workflow-run-panel.smoke.mjs`.** Its builder assertions read rows from the deleted panel. Point them at run mode on `/workflows/<slug>?run=<id>`:
  - each seeded step is an `article[data-step="<stepId>"]` whose text has its label
  - its status dot's `aria-label` is the step status
  - `[data-testid="run-progress-count"]` still counts

  Keep its /runs assertions as they are. Its pre-existing failure ("Jira: In Progress" row never visible) should either go away because the rows now render, or its cause should be written into the report.

- [ ] **Step 5: `e2e/workflow-builder.smoke.mjs`.** Model it on `e2e/awaiting-review.smoke.mjs`'s harness: disposable `CLAUDE_DIR`, `AUTH_DISABLED`, its own dev server and Chromium. Seed a three-step linear workflow `a → b → c` and one agent. Then assert:
  1. Three step cards render.
  2. Split after `a`: "+" → "Split into paths". Add the agent into both branches and move `b` into branch 1 by dragging, or delete and re-add it. Save.
  3. The JSON file on disk has `a.next` with two targets, each branch step's `next` pointing at `c`, and `c.next` equal to `[]`.
  4. Reload: a `role="group"` paths block with two branches renders.
  5. Untick "Rejoin after paths" while `c` still follows. A toast says "Steps follow these paths, so they have to rejoin.", and the file is unchanged.

  Add it to the report's list of smokes.

- [ ] **Step 6: Run everything.**
  - `npx nuxt typecheck` → 0 errors
  - the full plain-node suite → only the known baseline FAILs
  - the smokes one at a time with `timeout 400`:
    - `schedules-and-parameters`, `concurrency-groups` (section 3 green, same section-5 failure), `workflow-run-panel`, `workflow-builder`, `awaiting-review` and `notifications` all pass. A single retry is allowed for the known cold-start flake.

- [ ] **Step 7: Commit.**

```bash
git add -A app/components e2e
git commit -m "chore(workflows): drop the canvas builder's components; smokes for the stack builder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`, the spec

- [ ] **Step 1: `CLAUDE.md`.**
  - Under **Pages**, change the `/workflows` line to: "`/workflows` - Workflow list; `/workflows/[slug]` builds a workflow as a stack of steps (Build) and shows its runs (Run)".
  - In the Run stack paragraph, add: "The builder (`/workflows/[slug]`) edits the same stack: `shared/utils/stackEdit.ts` holds the pure edits and `canSave`, which refuses anything `toStack` couldn't draw again; `WorkflowStackEditor` → `BuildStackBlocks` → `BuildStackCard`, with `ActionPicker` for the "+", `StepDrawer` and `TriggerDrawer` for settings."

- [ ] **Step 2: Spec §3 corrections.** Record what the build differs on, each as one plain sentence where it belongs:
  - **Build mode uses its own components.** The builder renders `WorkflowStackEditor` and `BuildStack*`, not `RunStack` in a build mode, because a run card and a build card do different jobs.
  - **A step's kind is fixed once added.** To change it, add the other kind and delete this one.
  - **An empty split is dropped on save.**
  - **Only one level of paths can be created** in the builder.
  - **The editor no longer draws the old canvas's guessed rework arrows.** Send-backs show on runs, from real run data.
  - **The Test tab** is Plan 3.

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md
git commit -m "docs: the stack builder

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
