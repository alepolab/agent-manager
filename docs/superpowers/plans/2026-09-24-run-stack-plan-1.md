# Run Stack (Plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every workflow run as a vertical stack of step cards, with the gate inside the card that waits on it and send-backs drawn as return arrows. Use it on `/runs`, `/runs/:id` and the notifications inbox.

**Architecture:** A pure layout module (`shared/utils/workflowStack.ts`) turns a workflow's `next[]` graph into series/parallel blocks. It has plain-node tests over every shipped template. `WorkflowRunPanel.vue` is split into two parts that don't change behaviour:
- `RunHeader.vue`: the run as a whole
- `RunGate.vue`: the open decision

A new `RunStack.vue` renders the header, the blocks, a card per step and the gate. It passes context to its recursive children through provide/inject. The runner starts recording two histories the stack draws: per-visit monitor checks, and agent send-backs.

**Tech Stack:** Nuxt 3, Vue 3 `<script setup>`, Nuxt UI v3, Tailwind v4. The node 24 test scripts import `.ts` directly.

**Spec:** `docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md`, sections 1, 2 and 5. Plan 2 covers section 3 (the builder) and removes `WorkflowRunPanel`, `WorkflowRunBar` and the canvas. Plan 3 covers section 4 (test runs).

## Global Constraints

- **No change to the workflow file format.** New fields go on run records only.
- **Imports.**
  - Value imports inside `shared/` and `server/` use the `.ts` extension, for example `from './workflowGraph.ts'`. Type-only imports may omit it.
  - App code imports shared modules as `~~/shared/...`.
- **Colours** come from CSS variables (`var(--...)`) and `RUN_STATUS_COLOR`. No literal hex values in components.
- **Tests** are plain node scripts: `node scripts/test-<name>.mjs`, with `node:assert/strict` and no framework. The full suite is `for t in scripts/test-*.mjs engineering/scripts/test-*.mjs; do node "$t" || break; done`.
- **UI changes** are verified in the running app with the agent-browser skill, not only by typecheck.
- **Keep every existing `data-testid`** that moves: `run-progress-count`, `run-parameters`, `run-usage-summary`, `child-run-count`, `child-runs`, `run-decision-panel`. The e2e smokes in `e2e/` select on them.
- **Keep these button labels exactly,** because the e2e smokes click them: "Approve and run", "Continue with a fresh allowance", "Continue", "Reply", "Reject run", "Send back (N left)".
- **Commits** are authored as `arishtjain-alepo <arishtj@alepo.com>` (already set in the repo config) and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Where to work:** worktree `/home/alepo/repos/agent-manager-run-stack-spec`, branch `docs/workflow-run-stack-spec`. Before Task 1, rename the branch with `git branch -m feat/run-stack`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `shared/types/run.ts` | modify | Add `StepCheck`, `SendBack`, `RunStep.checks`, `WorkflowRun.sendBacks` |
| `shared/utils/runHistory.ts` | create | `recordCheck`, `recordSendBack`: append-only run history |
| `server/utils/workflowRunner.ts` | modify | Call the two recorders where verdicts and agent reworks happen |
| `scripts/test-run-history.mjs` | create | Runner-level test of both histories |
| `shared/utils/workflowStack.ts` | create | `toStack`, `fromStack`, `stackForRun`, `sendBackArrows`, `stepKind` |
| `scripts/test-workflow-stack.mjs` | create | Layout tests over every shipped template, plus rejection cases |
| `app/components/RunGate.vue` | create | The open decision, extracted from `WorkflowRunPanel` |
| `app/components/RunHeader.vue` | create | The run-level summary and controls, extracted from `WorkflowRunPanel` |
| `app/components/WorkflowRunPanel.vue` | modify | Uses `RunHeader` and `RunGate`. It stays for the builder until Plan 2. |
| `app/utils/runStack.ts` | create | Injection key, context type, step-kind labels and icons |
| `app/components/RunStack.vue` | create | Header, layout, arrows, evidence slide-over, context provider |
| `app/components/RunStackBlocks.vue` | create | Recursive block renderer, including paths and the approval card |
| `app/components/RunStackCard.vue` | create | One step: collapsed row and expanded detail |
| `app/pages/runs/[id].vue` | modify | Renders `RunStack` full width |
| `app/pages/runs/index.vue` | modify | Two columns: run list and the selected run's `RunStack` |
| `app/components/NotificationRunDetail.vue` | modify | Renders `RunStack`; the "Full run" link carries `#step-<id>` |
| `CLAUDE.md`, the spec | modify | Document the components; record the two spec corrections |

---

### Task 1: Record per-visit checks and agent send-backs

**Files:**
- Modify: `shared/types/run.ts` (the `RunStep` interface at line 154, and `WorkflowRun`)
- Create: `shared/utils/runHistory.ts`
- Modify: `server/utils/workflowRunner.ts:733`, `:745`, and the rework restart branch near `:2068`
- Test: `scripts/test-run-history.mjs`

**Interfaces:**
- Produces:
  - `interface StepCheck { visit: number, verdict: 'CONTINUE' | 'RETRY' | 'ABORT', note: string, at: number }`
  - `interface SendBack { from: string, target: string, instruction: string, by: string, at: number }`
  - `RunStep.checks?: StepCheck[]`
  - `WorkflowRun.sendBacks?: SendBack[]`
  - `recordCheck(rec: RunStep, verdict: StepCheck['verdict'], note: string, at?: number): StepCheck`
  - `recordSendBack(run: WorkflowRun, s: Omit<SendBack, 'at'>, at?: number): SendBack`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-run-history.mjs`:

```js
/**
 * Self-check for the two histories the run stack draws from.
 *
 * RunStep kept only its LATEST monitor verdict, so a step that was sent back
 * by its monitor once and then passed showed a clean CONTINUE with nothing to
 * say it had ever been retried. And a send-back raised by an agent
 * (PIPELINE-REWORK) was only a log line: human send-backs are in
 * run.decisions, but that list is what people decided (PipelineBoard counts
 * and attributes it), so agent send-backs get their own record.
 *
 *   node scripts/test-run-history.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'run-history-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'run-history-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const { recordCheck, recordSendBack } = await import('../shared/utils/runHistory.ts')

const TIMEOUT = 5000
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
const save = w => writeFileSync(join(CLAUDE_DIR, 'workflows', `${w.slug}.json`), JSON.stringify(w, null, 2))

// ── 1. the recorders append, never replace ─────────────────────────────────
{
  const rec = { stepId: 's', visits: 1 }
  recordCheck(rec, 'RETRY', 'JPY rounding still wrong', 100)
  rec.visits = 2
  recordCheck(rec, 'CONTINUE', 'all six rows pass', 200)
  assert.deepEqual(rec.checks, [
    { visit: 1, verdict: 'RETRY', note: 'JPY rounding still wrong', at: 100 },
    { visit: 2, verdict: 'CONTINUE', note: 'all six rows pass', at: 200 },
  ])

  const run = { id: 'r' }
  recordSendBack(run, { from: 'c', target: 'a', instruction: 'redo', by: 'agent:agent-c' }, 300)
  recordSendBack(run, { from: 'c', target: 'b', instruction: 'again', by: 'agent:agent-c' }, 400)
  assert.equal(run.sendBacks.length, 2)
  assert.deepEqual(run.sendBacks[0], { from: 'c', target: 'a', instruction: 'redo', by: 'agent:agent-c', at: 300 })
}

// ── 2. a monitor RETRY then CONTINUE leaves two checks on the step ─────────
{
  const workflow = {
    slug: 'checks', name: 'Checks',
    steps: [
      { id: 'a', agentSlug: 'agent-a', label: 'Alpha', monitorSlug: 'watcher', next: [] },
    ],
  }
  save(workflow)
  let monitorCalls = 0
  runner.setAgentCaller(async (slug) => {
    if (slug !== 'watcher') return `output of ${slug}`
    monitorCalls++
    return monitorCalls === 1 ? 'Not yet.\nVERDICT: RETRY' : 'Good.\nVERDICT: CONTINUE'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  const checks = run.steps.find(s => s.stepId === 'a').checks
  assert.deepEqual(checks.map(c => [c.visit, c.verdict]), [[1, 'RETRY'], [2, 'CONTINUE']], 'one check per visit, in order')
  assert.ok(checks.every(c => typeof c.at === 'number' && c.note.length > 0))
}

// ── 3. an agent's PIPELINE-REWORK is recorded as a send-back ───────────────
{
  const workflow = {
    slug: 'sendback', name: 'Sendback',
    steps: [
      { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['c'] },
      { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
    ],
  }
  save(workflow)
  let reworked = false
  runner.setAgentCaller(async (slug) => {
    if (slug !== 'agent-c') return `output of ${slug}`
    if (reworked) return 'fine now'
    reworked = true
    return 'found a problem\nPIPELINE-REWORK: Alpha — handle the empty list'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  assert.equal(run.sendBacks?.length, 1, 'one send-back recorded')
  const [s] = run.sendBacks
  assert.equal(s.from, 'c')
  assert.equal(s.target, 'a')
  assert.equal(s.by, 'agent:agent-c')
  assert.match(s.instruction, /handle the empty list/)
  assert.equal((run.decisions ?? []).length, 0, 'an agent send-back is not a person\'s decision')
}

console.log('runHistory: all checks passed')
process.exit(0)
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/test-run-history.mjs`
Expected: FAIL with `Cannot find module '.../shared/utils/runHistory.ts'`.

- [ ] **Step 3: Add the types**

In `shared/types/run.ts`, above `export interface RunStep`, add:

```ts
/** One monitor verdict on one visit of a step. `monitorVerdict` on the step is the latest; this is all of them. */
export interface StepCheck {
  visit: number
  verdict: 'CONTINUE' | 'RETRY' | 'ABORT'
  note: string
  at: number
}

/**
 * A run sent back to an earlier step by an AGENT (PIPELINE-REWORK). A person's
 * send-back is a RunDecision instead: `decisions` is what people chose, and the
 * manager board counts and attributes it, so agent send-backs are kept apart.
 */
export interface SendBack {
  /** Step that raised it. */
  from: string
  /** Step the run went back to. */
  target: string
  instruction: string
  /** `agent:<slug>` */
  by: string
  at: number
}
```

Inside `RunStep`, after `monitorNote?: string`, add:

```ts
  /** Every monitor verdict this step received, oldest first. Kept across restarts. */
  checks?: StepCheck[]
```

Inside `WorkflowRun`, after `decisions?: RunDecision[]`, add:

```ts
  /** Agent-raised send-backs, oldest first. See SendBack. */
  sendBacks?: SendBack[]
```

(If `decisions` is declared under a different comment block, put `sendBacks` directly after it.)

- [ ] **Step 4: Write the recorders**

Create `shared/utils/runHistory.ts`:

```ts
import type { RunStep, SendBack, StepCheck, WorkflowRun } from '../types/run'

/**
 * Append-only history the run stack draws: every monitor verdict per visit,
 * and every agent-raised send-back. In `shared/` because the runner writes it
 * and the tests exercise it without a server.
 */

export function recordCheck(rec: RunStep, verdict: StepCheck['verdict'], note: string, at = Date.now()): StepCheck {
  const check: StepCheck = { visit: rec.visits, verdict, note, at }
  rec.checks = [...(rec.checks ?? []), check]
  return check
}

export function recordSendBack(run: WorkflowRun, s: Omit<SendBack, 'at'>, at = Date.now()): SendBack {
  const entry: SendBack = { ...s, at }
  run.sendBacks = [...(run.sendBacks ?? []), entry]
  return entry
}
```

- [ ] **Step 5: Call them from the runner**

In `server/utils/workflowRunner.ts`, add next to the other shared imports (around line 36):

```ts
import { recordCheck, recordSendBack } from '../../shared/utils/runHistory.ts'
```

At line 733, directly after `Object.assign(rec, { monitorVerdict: verdict, monitorNote: review })`:

```ts
    recordCheck(rec, verdict, review)
```

At line 745, directly after `Object.assign(rec, { monitorVerdict: 'CONTINUE', monitorNote })`:

```ts
    recordCheck(rec, 'CONTINUE', monitorNote)
```

Leave the resets at `:828` and `:3087` alone. They clear `monitorVerdict` and `monitorNote` for the new visit, and `checks` has to survive them.

In the `if (l.rework)` block, find the restart branch that starts `run.currentStepIds = []` directly before `return restartRun(...)`. Insert this before its `await publish(run)`:

```ts
    // Before publish: restartRun re-reads the run from disk.
    recordSendBack(run, { from: w.from, target: w.target, instruction: w.instruction, by: `agent:${raiser?.agentSlug ?? w.from}` })
```

Don't add it to the `spent > REWORK_LIMIT` branch. That branch pauses the run instead of sending it back, and whatever the person decides there is recorded as a decision.

`publish` is expected to persist the run. If Step 6 shows `sendBacks` missing after the restart, add `await saveRun(run)` right after the `recordSendBack` call.

- [ ] **Step 6: Run the test and confirm it passes**

Run: `node scripts/test-run-history.mjs`
Expected: `runHistory: all checks passed`

- [ ] **Step 7: Run the neighbouring runner tests**

Run: `node scripts/test-workflow-runner.mjs && node scripts/test-rework-target-matching.mjs && node scripts/test-run-decisions.mjs`
Expected: each prints its "all checks passed" line.

- [ ] **Step 8: Commit**

```bash
git add shared/types/run.ts shared/utils/runHistory.ts server/utils/workflowRunner.ts scripts/test-run-history.mjs
git commit -m "feat(runs): record every monitor check and every agent send-back

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stack layout module

**Files:**
- Create: `shared/utils/workflowStack.ts`
- Test: `scripts/test-workflow-stack.mjs`

**Interfaces:**
- Consumes: `buildGraph(nodes: GraphNode[]): WorkflowGraph` from `shared/utils/workflowGraph.ts`, which provides `succ`, `forwardPreds`, `backEdges` and `entries`. `SendBack` comes from Task 1.
- Produces:
  - `type StackBlock = { kind: 'step', stepId: string } | { kind: 'paths', branches: StackBlock[][], rejoin: boolean }`
  - `type StackResult = { ok: true, blocks: StackBlock[] } | { ok: false, reason: string }`
  - `toStack(steps: StackNode[]): StackResult`, where `StackNode = GraphNode & { label?: string }`
  - `fromStack<T extends GraphNode>(blocks: StackBlock[], steps: T[]): T[]`
  - `stackForRun(workflowSteps: StackNode[] | null | undefined, runStepIds: string[]): { blocks: StackBlock[], note?: string }`
  - `stepIdsOf(blocks: StackBlock[]): string[]`
  - `type StepKind = 'agent' | 'jira' | 'jira-create' | 'notify' | 'loop'` and `stepKind(step?): StepKind`
  - `interface SendBackArrow { from: string, to: string, by: string, note: string, at: number }` and `sendBackArrows(run): SendBackArrow[]`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-workflow-stack.mjs`:

```js
/**
 * Self-check for shared/utils/workflowStack.ts: the workflow graph as a
 * vertical stack of steps and paths.
 *
 * The rule these protect: every workflow the team ships converts, converts
 * back to the same graph, and a graph the stack cannot draw is refused with a
 * reason rather than reshaped.
 *
 *   node scripts/test-workflow-stack.mjs
 */
import assert from 'node:assert/strict'

const { toStack, fromStack, stackForRun, stepIdsOf, sendBackArrows, stepKind } = await import('../shared/utils/workflowStack.ts')
const { buildGraph } = await import('../shared/utils/workflowGraph.ts')
const { workflowTemplates, RUNBOOK_FILES, materializeTemplateSteps } = await import('../app/utils/workflowTemplates.ts')

/** Successors as sorted lists, so implicit and explicit `next` compare equal. */
const succOf = steps => Object.fromEntries(Object.entries(buildGraph(steps).succ).map(([k, v]) => [k, [...v].sort()]))
const step = (id, next, extra = {}) => ({ id, label: id.toUpperCase(), ...(next ? { next } : {}), ...extra })

// ── 1. every shipped workflow converts, and round-trips ────────────────────
const shipped = workflowTemplates.filter(t => RUNBOOK_FILES[t.id])
assert.ok(shipped.length >= 11, `expected the 11 shipped workflows, got ${shipped.length}`)
for (const t of shipped) {
  const slugs = Object.fromEntries(t.steps.map(s => [s.agentTemplateId, s.agentTemplateId]))
  const steps = materializeTemplateSteps(t, slugs)
  const r = toStack(steps)
  assert.ok(r.ok, `${t.id} converts: ${r.ok ? '' : r.reason}`)
  const ids = stepIdsOf(r.blocks)
  assert.equal(ids.length, steps.length, `${t.id}: every step appears once`)
  assert.equal(new Set(ids).size, steps.length, `${t.id}: no step appears twice`)
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps), `${t.id}: fromStack gives back the same graph`)
}

// ── 2. the two shapes the team uses ────────────────────────────────────────
{
  const runbookA = workflowTemplates.find(t => t.id === 'runbook-a-jira-to-diff')
  const steps = materializeTemplateSteps(runbookA, Object.fromEntries(runbookA.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const r = toStack(steps)
  const paths = r.blocks.filter(b => b.kind === 'paths')
  assert.equal(paths.length, 1, 'Runbook A splits once')
  assert.equal(paths[0].branches.length, 3, 'into three parallel steps')
  assert.equal(paths[0].rejoin, true, 'which rejoin')

  const scan = workflowTemplates.find(t => t.id === 'scan-security-to-dispatch')
  const s2 = materializeTemplateSteps(scan, Object.fromEntries(scan.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  const r2 = toStack(s2)
  const last = r2.blocks.at(-1)
  assert.equal(last.kind, 'paths', 'a scan ends in paths')
  assert.equal(last.rejoin, false, 'whose branches end separately')
}

// ── 3. simple shapes ───────────────────────────────────────────────────────
assert.deepEqual(toStack([]), { ok: true, blocks: [] })
assert.deepEqual(toStack([step('a'), step('b'), step('c')]).blocks.map(b => b.stepId), ['a', 'b', 'c'], 'no next = array order')
{
  // a -> [b, c]; b -> d; c -> d  (diamond)
  const r = toStack([step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])])
  assert.ok(r.ok)
  assert.deepEqual(r.blocks, [
    { kind: 'step', stepId: 'a' },
    { kind: 'paths', rejoin: true, branches: [[{ kind: 'step', stepId: 'b' }], [{ kind: 'step', stepId: 'c' }]] },
    { kind: 'step', stepId: 'd' },
  ])
}
{
  // a -> [b, d]; b -> d : one branch is empty (goes straight on)
  const steps = [step('a', ['b', 'd']), step('b', ['d']), step('d', [])]
  const r = toStack(steps)
  assert.ok(r.ok)
  assert.deepEqual(r.blocks[1].branches, [[{ kind: 'step', stepId: 'b' }], []])
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps))
}
{
  // nested paths meeting at the outer join: a -> [b, c]; b -> [d, e]; d, e, c -> f
  const steps = [step('a', ['b', 'c']), step('b', ['d', 'e']), step('c', ['f']), step('d', ['f']), step('e', ['f']), step('f', [])]
  const r = toStack(steps)
  assert.ok(r.ok, r.reason)
  assert.equal(r.blocks[1].branches[0][1].kind, 'paths', 'the inner split sits inside the first branch')
  assert.deepEqual(succOf(fromStack(r.blocks, steps)), succOf(steps))
}

// ── 4. refused, with a reason ──────────────────────────────────────────────
{
  const back = toStack([step('a', ['b']), step('b', ['a'])])
  assert.equal(back.ok, false)
  assert.match(back.reason, /back to an earlier step/)

  const two = toStack([step('a', []), step('b', [])])
  assert.equal(two.ok, false)
  assert.match(two.reason, /2 first steps/)

  // a -> [b, c]; b -> [d, e]; c -> e; d -> f; e -> f : e joins steps from two branches
  const cross = toStack([step('a', ['b', 'c']), step('b', ['d', 'e']), step('c', ['e']), step('d', ['f']), step('e', ['f']), step('f', [])])
  assert.equal(cross.ok, false)
  assert.match(cross.reason, /E/, 'the reason names the step by label')
}

// ── 5. fromStack refuses a step after paths that do not rejoin ─────────────
assert.throws(
  () => fromStack([
    { kind: 'step', stepId: 'a' },
    { kind: 'paths', rejoin: false, branches: [[{ kind: 'step', stepId: 'b' }], [{ kind: 'step', stepId: 'c' }]] },
    { kind: 'step', stepId: 'd' },
  ], [step('a'), step('b'), step('c'), step('d')]),
  /after paths that do not rejoin/,
)

// ── 6. a run whose workflow changed is shown in run order ──────────────────
{
  const wf = [step('a', ['b', 'c']), step('b', ['d']), step('c', ['d']), step('d', [])]
  assert.equal(stackForRun(wf, ['a', 'b', 'c', 'd']).note, undefined)
  assert.equal(stackForRun(wf, ['a', 'b', 'c', 'd']).blocks[1].kind, 'paths')
  const changed = stackForRun(wf, ['a', 'x'])
  assert.deepEqual(changed.blocks, [{ kind: 'step', stepId: 'a' }, { kind: 'step', stepId: 'x' }])
  assert.match(changed.note, /changed since this run/)
  assert.match(stackForRun(null, ['a']).note, /no longer exists/)
}

// ── 7. send-back arrows merge people and agents, oldest first ──────────────
{
  const arrows = sendBackArrows({
    decisions: [
      { stepId: 'gate', verdict: 'approved', by: 'amy', at: 1, label: 'Gate', waitedMs: 0 },
      { stepId: 'gate', verdict: 'sent-back', target: 'fix', by: 'amy', note: 'tighten', at: 30, label: 'Gate', waitedMs: 0 },
    ],
    sendBacks: [{ from: 'verify', target: 'fix', instruction: 'JPY', by: 'agent:sdlc-verifier', at: 10 }],
  })
  assert.deepEqual(arrows, [
    { from: 'verify', to: 'fix', by: 'agent:sdlc-verifier', note: 'JPY', at: 10 },
    { from: 'gate', to: 'fix', by: 'amy', note: 'tighten', at: 30 },
  ])
}

// ── 8. step kinds ──────────────────────────────────────────────────────────
assert.equal(stepKind(undefined), 'agent')
assert.equal(stepKind({ agentSlug: 'x' }), 'agent')
assert.equal(stepKind({ jira: { transition: 'In Review' } }), 'jira')
assert.equal(stepKind({ jira: { action: 'create', source: 'a.json' } }), 'jira-create')
assert.equal(stepKind({ notify: { channel: 'c' } }), 'notify')
assert.equal(stepKind({ triggerWorkflow: { source: 'x' } }), 'loop')

console.log('workflowStack: all checks passed')
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node scripts/test-workflow-stack.mjs`
Expected: FAIL with `Cannot find module '.../shared/utils/workflowStack.ts'`.

- [ ] **Step 3: Write the module**

Create `shared/utils/workflowStack.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `node scripts/test-workflow-stack.mjs`
Expected: `workflowStack: all checks passed`

If section 1 fails for a template, print the reason. Every shipped workflow is series/parallel, so a failure is a bug in `toStack`, not in the template.

- [ ] **Step 5: Run the graph tests too**

Run: `node scripts/test-workflow-graph.mjs && node scripts/test-workflow-templates.mjs`
Expected: both pass. This module doesn't change them; the check guards against an accidental edit.

- [ ] **Step 6: Commit**

```bash
git add shared/utils/workflowStack.ts scripts/test-workflow-stack.mjs
git commit -m "feat(workflows): lay a workflow out as a stack of steps and paths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Extract `RunGate` and `RunHeader` from `WorkflowRunPanel`

This task changes structure only. `WorkflowRunPanel` renders the two new components and should look and behave exactly as before. The e2e smokes prove that.

**Files:**
- Create: `app/components/RunGate.vue`, `app/components/RunHeader.vue`
- Modify: `app/components/WorkflowRunPanel.vue`

**Interfaces:**
- Produces:
  - `<RunGate :run>` emits `respond(reply)`, `continue(note?)`, `reject(note)`, `rework(stepId, note)`. It renders nothing unless `run.question` is set or `run.status === 'awaiting_review'`.
  - `<RunHeader :run>` emits `note(text)`, `continue()` (resume an interrupted run), `stop()`, `clone()`.

- [ ] **Step 1: Create `RunGate.vue`**

```vue
<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { needsJustification } from '~~/shared/utils/oversight'
import { gateIsMine } from '~~/shared/utils/notifications'

/**
 * A run's open decision: the question, whose it is, the evidence being
 * approved, and the answers. Moved out of WorkflowRunPanel unchanged so the run
 * stack can render it inside the card of the step that is waiting.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ respond: [reply: string], continue: [note?: string], reject: [note: string], rework: [stepId: string, note: string] }>()

const { can, role } = useUser()
/** Mirrors requireGateRole on the server, as a courtesy: the server is what refuses. */
const gateOwner = computed(() => props.run.question?.role)
const mineToAnswer = computed(() => gateIsMine(gateOwner.value, role.value))
const mayAnswer = computed(() => can('answerGate') && mineToAnswer.value)
const mustJustify = computed(() => needsJustification(props.run.blastRadius))
/** Gated on an artifact's entries: RunDecisionPanel owns both the question and the resume. */
const reviewing = computed(() => props.run.status === 'awaiting_review')
const isReply = computed(() => props.run.status === 'paused' && props.run.question?.kind === 'question')
const shown = computed(() => !!props.run.question || reviewing.value)

const note = ref('')
const canApprove = computed(() => !mustJustify.value || !!note.value.trim())
const placeholder = computed(() => (isReply.value
  ? 'Your answer to the agent'
  : 'Optional note for the step about to run, e.g. target the SaskTel branch policy'))

/** Where a send-back goes. The reviewer picks; the run never guesses. Candidates are steps that have run. */
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)
const reworkTarget = ref('')
const reworkCandidates = computed(() => props.run.steps.filter(s => stepSettled(s) && s.stepId !== props.run.question?.stepId))
const reworksLeft = computed(() => 2 - (props.run.reworks ?? 0))
watch(() => props.run.id, () => { reworkTarget.value = ''; note.value = '' })

function send(kind: 'respond' | 'continue' | 'reject' | 'rework') {
  const text = note.value.trim()
  if (kind === 'rework') emit('rework', reworkTarget.value, text)
  else if (kind === 'reject') emit('reject', text)
  else if (kind === 'respond') emit('respond', text)
  else emit('continue', text || undefined)
  note.value = ''
  reworkTarget.value = ''
}

/** How long this gate has waited on a person, ticking. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })
const waitingLabel = computed(() => {
  const asked = props.run.question?.askedAt
  if (!asked) return 'for a decision'
  const secs = Math.max(0, Math.round((now.value - asked) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
})
const askingLabel = computed(() => `${props.run.steps.find(s => s.stepId === props.run.question?.stepId)?.label ?? 'A step'} is asking you`)
</script>

<template>
  <div v-if="shown" class="space-y-3" data-testid="run-gate">
    <!-- PASTE: WorkflowRunPanel.vue lines 295-318 (the question banner) verbatim,
         with `run?.question?.stepId` written as `run.question?.stepId`. -->
    <!-- PASTE: WorkflowRunPanel.vue lines 323-334 (RunDecisionPanel /
         RunVerdictCard / fallback banner) verbatim. -->
    <textarea
      v-if="!reviewing && mayAnswer && run.status === 'paused'"
      v-model="note"
      rows="2"
      class="field-input w-full resize-none t-small"
      :placeholder="placeholder"
      :aria-label="placeholder"
      @keydown.meta.enter="isReply ? send('respond') : send('continue')"
    />
    <div class="flex flex-wrap gap-2">
      <!-- PASTE: WorkflowRunPanel.vue lines 526-559 verbatim, with these edits:
           - `noteMode === 'reply'` becomes `isReply`
           - `note.trim()` stays (the local `note` ref above)
           - no other change; the labels are what the e2e smokes click -->
      <p v-if="!mayAnswer && run.status === 'paused'" class="t-small text-label self-center">This run is waiting on a decision from a developer.</p>
    </div>
  </div>
</template>
```

The PASTE markers mean: copy those exact line ranges from the current `WorkflowRunPanel.vue` into the marked spot, and delete the marker comment. The ranges are exact as of commit `8647f79`. Read the panel first and match each range by its content (the `role="alert"` banner, `<RunDecisionPanel`, the Reply/Approve/Send back/Reject buttons), not by line number alone.

- [ ] **Step 2: Create `RunHeader.vue`**

```vue
<script setup lang="ts">
import { isLiveStatus, type WorkflowRun, type RunCostSummary } from '~~/shared/types/run'
import { RUN_STATUS_COLOR as STATUS_COLOR, SETTLED_STATUSES, runElapsedLabel, RUN_DURATION_HINT, runStatusLabel } from '~/utils/runStatus'

/**
 * A run as a whole: what it is, how far it got, what it was given, what it
 * produced and cost, and the controls that act on all of it. Moved out of
 * WorkflowRunPanel so the panel and the run stack share one header.
 */
const props = defineProps<{ run: WorkflowRun }>()
const emit = defineEmits<{ note: [text: string], continue: [], stop: [], clone: [] }>()

const { can } = useUser()
const mayDrive = computed(() => can('runEngine'))
const settledRun = computed(() => !isLiveStatus(props.run.status))
const anyRunning = computed(() => props.run.steps.some(s => s.status === 'running'))

/** Steering a running run: the note reaches the agent working now, or the next step to start. */
const steer = ref('')
const sent = ref<string | null>(null)
const steerPlaceholder = computed(() => (anyRunning.value
  ? 'Instruction for the agent working now, e.g. the plugin lives under modules/administrator'
  : 'Send a note to whichever step starts next, e.g. the plugin lives under modules/administrator'))
function sendNote() {
  const text = steer.value.trim()
  if (!text) return
  emit('note', text)
  sent.value = text
  steer.value = ''
}

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { if (clock) clearInterval(clock) })

const statedParameters = computed(() => Object.entries(props.run.parameters ?? {}))
const progress = computed(() => ({
  done: props.run.steps.filter(s => SETTLED_STATUSES.has(s.status)).length,
  total: props.run.steps.length,
}))
const preflightNotable = computed(() => (props.run.preflight?.checks ?? []).filter(c => c.level === 'fail' || c.level === 'warn'))

// PASTE: WorkflowRunPanel.vue lines 113-129 (intake, prLinks, loadFacts and its
// watch) verbatim, with every `props.run?.` written as `props.run.` and the
// `if (!props.run)` guard removed.

// PASTE: WorkflowRunPanel.vue lines 200-210 (cost, costError and the watch)
// verbatim, with `() => props.run?.id` written as `() => props.run.id`.
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <span class="t-small font-mono uppercase" :style="{ color: STATUS_COLOR[run.status] }">{{ runStatusLabel(run.status) }}</span>
      <span class="t-small text-label">{{ run.workflowName }}</span>
      <span class="t-small text-label ml-auto font-mono tabular-nums" data-testid="run-progress-count">{{ progress.done }} / {{ progress.total }}</span>
      <span class="t-small text-label" :title="RUN_DURATION_HINT">{{ runElapsedLabel(run, now) }}</span>
    </div>
    <RunProgressBar :steps="run.steps" :aria-label="`${progress.done} of ${progress.total} steps settled`" />

    <!-- PASTE: WorkflowRunPanel.vue lines 244-294 verbatim (parameters,
         interrupted notice, preflight, PR links, intake questions). In the
         intake block, replace the sentence "Answer in the note below and restart
         the step that needs the answer." with "Answer it when you replay the step
         that needs it." -->

    <!-- PASTE: WorkflowRunPanel.vue lines 339-349 verbatim (earlier decisions). -->

    <!-- PASTE: WorkflowRunPanel.vue lines 391-407 verbatim (usage summary). -->

    <p v-if="sent && run.status === 'running'" class="t-small text-label">Queued for the next step: "{{ sent }}"</p>
    <textarea
      v-if="mayDrive && run.status === 'running'"
      v-model="steer" rows="2" class="field-input w-full resize-none t-small"
      :placeholder="steerPlaceholder" :aria-label="steerPlaceholder"
      @keydown.meta.enter="sendNote"
    />
    <div class="flex flex-wrap gap-2">
      <UButton v-if="mayDrive && run.status === 'running'" size="xs" variant="soft" icon="i-lucide-message-square" :label="anyRunning ? 'Send to running agent' : 'Send note to next step'" :disabled="!steer.trim()" @click="sendNote" />
      <UButton v-if="mayDrive && run.status === 'interrupted'" size="xs" icon="i-lucide-play" label="Resume" @click="emit('continue')" />
      <UButton v-if="mayDrive && isLiveStatus(run.status)" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
      <UButton v-if="mayDrive && settledRun" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
    </div>
  </div>
</template>
```

- [ ] **Step 3: Slim `WorkflowRunPanel.vue` down to use them**

Edit `app/components/WorkflowRunPanel.vue` as follows. The script keeps `props`, `emit`, `mayDrive`, `stepSettled`, `settledRun`, `note` (now only the restart note), `artifacts`, `openFile`, `fileText`, `loadArtifacts`, `showFile`, `now` and its clock, `elapsed`, `expanded`, `liveFor`, `latest`, `logPre` and its watch.

Delete from the script:
- `gateOwner`, `mineToAnswer`, `mayAnswer`, `mustJustify`, `canApprove`, `reviewing`
- `anyRunning`, `noteMode`, `notePlaceholder`, `sent`, `send`
- `reworkTarget`, `reworkCandidates`, `reworksLeft` and its watch
- `intake`, `prLinks`, `preflightNotable`, `loadFacts` and its watch
- `waitingLabel`, `settled`, `statedParameters`, `progress`, `cost`, `costError` and its watch
- the imports that are now unused (`needsJustification`, `oversightReason`, `RunCostSummary`, `SETTLED_STATUSES`)

In the template, keep the first row's back button and "Full page" link. Replace everything from the status `<span>` (line 228) through line 408 with:

```vue
      </div>
      <RunHeader :run="run" @note="(t) => emit('note', t)" @continue="emit('continue')" @stop="emit('stop')" @clone="emit('clone')" />
      <RunGate
        :run="run"
        @respond="(r) => emit('respond', r)" @continue="(n) => emit('continue', n)"
        @reject="(n) => emit('reject', n)" @rework="(s, n) => emit('rework', s, n)"
      />
      <details v-if="mayDrive && settledRun" class="t-small rounded-lg p-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <summary class="cursor-pointer focus-ring" style="color: var(--text-primary);">Run part of this again</summary>
        <p class="text-label mt-1">Pick a step below and press its <span class="font-mono">↻</span> to run it again from there. Anything typed here is handed to that step as an instruction.</p>
        <textarea v-model="note" rows="2" class="field-input w-full resize-none t-small mt-2" placeholder="Optional note for the step you restart, e.g. verify from inside the container only" aria-label="Note for the step you restart" />
      </details>
```

Keep the step rows (409-505), the evidence files (511-523) and the previous-runs list (570-584) as they are. Delete the old button row (525-567). Its buttons now live in `RunGate` and `RunHeader`.

The closing `</div>` of the first row moves up so that `RunHeader` sits below the back/full-page row, not inside it.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no new errors in `RunGate.vue`, `RunHeader.vue` or `WorkflowRunPanel.vue`. Compare with `git stash; bun run typecheck; git stash pop` if the baseline has errors.

- [ ] **Step 5: Verify in the running app**

Start the dev server with `bun run dev` on port 3030. Use the agent-browser skill to check the following. Take a screenshot of each state.
- A workflow's Run details slideover and `/runs/:id` for a paused approval run. You see the question banner, the verdict card, Approve / Send back / Reject, and "Waiting 3m".
- A running run. You see the steer box and "Send to running agent", and Stop.
- A finished run. You see the PR link if it has one, the token usage, Clone run, and "Run part of this again".

Then run the smokes that cover these screens, following the instructions in each file's header comment:
```bash
node e2e/workflow-run-panel.smoke.mjs && node e2e/awaiting-review.smoke.mjs && node e2e/notifications.smoke.mjs
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/components/RunGate.vue app/components/RunHeader.vue app/components/WorkflowRunPanel.vue
git commit -m "refactor(runs): split the run panel into RunHeader and RunGate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `RunStack`, `RunStackBlocks` and `RunStackCard`

**Files:**
- Create: `app/utils/runStack.ts`, `app/components/RunStack.vue`, `app/components/RunStackBlocks.vue`, `app/components/RunStackCard.vue`

**Interfaces:**
- Consumes:
  - `stackForRun`, `stepKind`, `sendBackArrows`, `StackBlock`, `StepKind` (Task 2)
  - `RunHeader`, `RunGate` (Task 3)
  - `StepCheck` (Task 1)
  - `buildGraph`, `ancestorsOf` from `~~/shared/utils/workflowGraph`
  - `GET /api/workflows/:slug` returns a `Workflow` with `steps: WorkflowStep[]`
  - `GET /api/runs` returns `WorkflowRun[]`
- Produces: `<RunStack :run :logs>`, which emits `continue(note?)`, `respond(reply)`, `reject(note)`, `rework(stepId, note)`, `note(text)`, `stop()`, `restart(stepId, note?)` and `clone()`. These are the same event names and payloads as `WorkflowRunPanel`, so callers can swap one for the other.

- [ ] **Step 1: Shared context and labels (`app/utils/runStack.ts`)**

```ts
import type { InjectionKey, Ref } from 'vue'
import type { RunStep, WorkflowRun } from '~~/shared/types/run'
import type { WorkflowStep } from '~/types'
import type { SendBackArrow, StepKind } from '~~/shared/utils/workflowStack'

/** What every card in one run stack needs, provided once by RunStack. */
export interface RunStackContext {
  run: Ref<WorkflowRun>
  stepOf: (id: string) => RunStep | undefined
  workflowStepOf: (id: string) => WorkflowStep | undefined
  kindOf: (id: string) => StepKind
  /** Labels of the steps whose output this step reads, per its contextMode. */
  readsOf: (id: string) => string[]
  logsOf: (id: string) => string[]
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  /** Send-backs that landed on this step, for the marker above its card. */
  arrivalsOf: (id: string) => (SendBackArrow & { n: number })[]
  /** Child runs by status, for a loop step. */
  childSummary: (id: string) => string
  gate: {
    respond: (reply: string) => void
    continue: (note?: string) => void
    reject: (note: string) => void
    rework: (stepId: string, note: string) => void
  }
  restart: (stepId: string, note?: string) => void
  openEvidence: () => void
}

export const RUN_STACK_KEY: InjectionKey<RunStackContext> = Symbol('run-stack')

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  'agent': 'Agent',
  'jira': 'Update Jira ticket',
  'jira-create': 'Create Jira tickets',
  'notify': 'Post to a channel',
  'loop': 'Loop over items',
}

export const STEP_KIND_ICON: Record<StepKind, string> = {
  'agent': 'i-lucide-bot',
  'jira': 'i-lucide-ticket',
  'jira-create': 'i-lucide-ticket-plus',
  'notify': 'i-lucide-send',
  'loop': 'i-lucide-repeat',
}
```

- [ ] **Step 2: `RunStackCard.vue`**

```vue
<script setup lang="ts">
import { RUN_STATUS_COLOR as STATUS_COLOR } from '~/utils/runStatus'
import { RUN_STACK_KEY, STEP_KIND_ICON, STEP_KIND_LABEL } from '~/utils/runStack'

/** One step of a run. Collapsed: what it is and how it went. Expanded: what it read, made, was told and said. */
const props = defineProps<{ stepId: string }>()
const ctx = inject(RUN_STACK_KEY)!
const { can } = useUser()
const mayDrive = computed(() => can('runEngine'))

const step = computed(() => ctx.stepOf(props.stepId)!)
const wf = computed(() => ctx.workflowStepOf(props.stepId))
const kind = computed(() => ctx.kindOf(props.stepId))
const open = computed(() => ctx.isOpen(props.stepId))
const run = ctx.run
const settledRun = computed(() => !isLiveStatus(run.value.status))
const settled = computed(() => ['completed', 'failed', 'skipped'].includes(step.value.status))
/** Question gates render in the card; approval gates render in the approval card above it (RunStackBlocks). */
const askingHere = computed(() => run.value.question?.stepId === props.stepId && run.value.question.kind === 'question')

const elapsed = computed(() => {
  const s = step.value
  if (!s.startedAt) return ''
  const secs = Math.round(((s.completedAt ?? Date.now()) - s.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
})
const tokens = computed(() => {
  const u = step.value.usage
  return u ? (u.input_tokens + u.output_tokens).toLocaleString() : ''
})
const usd = computed(() => (step.value.usage?.usd != null ? `$${step.value.usage.usd.toFixed(2)}` : ''))
const logs = computed(() => ctx.logsOf(props.stepId))
const latest = computed(() => logs.value.at(-1)?.slice(9) ?? '')
const arrivals = computed(() => ctx.arrivalsOf(props.stepId))

/** Replay asks for an optional instruction before it restarts anything. */
const replaying = ref(false)
const replayNote = ref('')
function replay() {
  ctx.restart(props.stepId, replayNote.value.trim() || undefined)
  replaying.value = false
  replayNote.value = ''
}
</script>

<template>
  <div class="w-full space-y-1">
    <p
      v-for="a in arrivals" :key="a.at"
      class="t-small flex items-center gap-1" style="color: var(--warning);" :data-sendback-to="stepId"
    >
      <UIcon name="i-lucide-corner-left-up" class="size-3.5 shrink-0" />
      Sent back here ({{ a.n }}) by {{ a.by.startsWith('agent:') ? a.by.slice(6) : a.by }} from {{ ctx.stepOf(a.from)?.label ?? a.from }}<template v-if="a.note">: {{ a.note }}</template>
    </p>
    <article
      :id="`step-${stepId}`" :data-step="stepId"
      class="w-full rounded-lg overflow-hidden"
      :style="{
        background: 'var(--surface-raised)',
        border: `1px solid ${step.status === 'running' ? STATUS_COLOR.running : 'var(--border-subtle)'}`,
        opacity: step.status === 'pending' || step.status === 'skipped' ? 0.7 : 1,
      }"
    >
      <button
        class="w-full grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left focus-ring"
        :aria-expanded="open" @click="ctx.toggle(stepId)"
      >
        <span class="w-2.5 h-2.5 rounded-full" :class="{ 'animate-pulse': step.status === 'running' }" :style="{ background: STATUS_COLOR[step.status] }" role="img" :aria-label="step.status" :title="step.status" />
        <span class="min-w-0">
          <span class="flex items-center gap-2">
            <span class="t-ui font-medium truncate" style="color: var(--text-primary);">{{ step.label }}</span>
            <span v-if="step.visits > 1" class="t-small text-label" :title="`This step ran ${step.visits} times`">×{{ step.visits }}</span>
            <span
              v-if="step.monitorVerdict && step.monitorVerdict !== 'CONTINUE'" class="t-small font-mono"
              :style="{ color: step.monitorVerdict === 'ABORT' ? STATUS_COLOR.failed : 'var(--warning)' }"
            >{{ step.monitorVerdict }}</span>
          </span>
          <span class="flex items-center gap-1.5 t-small text-label truncate">
            <UIcon :name="STEP_KIND_ICON[kind]" class="size-3.5 shrink-0" />
            {{ STEP_KIND_LABEL[kind] }}<template v-if="kind === 'agent'"> · {{ step.agentSlug }}</template>
            <template v-if="wf?.monitorSlug"> · Check</template>
            <template v-if="step.status === 'skipped' && step.skipReason"> · skipped: {{ step.skipReason }}</template>
            <template v-if="step.childRunIds?.length"> · <span data-testid="child-run-count">{{ ctx.childSummary(stepId) }}</span></template>
          </span>
        </span>
        <span class="t-small font-mono text-label tabular-nums text-right whitespace-nowrap">
          {{ elapsed }}<template v-if="tokens"><br>{{ tokens }} tok{{ usd ? ` · ${usd}` : '' }}</template>
        </span>
      </button>
      <div v-if="step.status === 'running' && latest && !open" class="px-3 pb-2 t-small font-mono truncate text-label" :title="latest">{{ latest }}</div>

      <div v-if="open" class="px-3 pb-3 pt-2 space-y-3" style="border-top: 1px solid var(--border-subtle);">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <p class="t-label text-label mb-1">Reads</p>
            <p v-if="!ctx.readsOf(stepId).length" class="t-small text-label">The run's prompt and inputs</p>
            <ul class="space-y-0.5"><li v-for="r in ctx.readsOf(stepId)" :key="r" class="t-small font-mono">{{ r }}</li></ul>
          </div>
          <div>
            <p class="t-label text-label mb-1">Produces</p>
            <p v-if="!wf?.produces?.length" class="t-small text-label">No declared files</p>
            <ul class="space-y-0.5"><li v-for="f in wf?.produces ?? []" :key="f" class="t-small font-mono">{{ f }}</li></ul>
          </div>
        </div>

        <div v-if="step.checks?.length" class="space-y-1">
          <p class="t-label text-label">Checks</p>
          <details v-for="c in step.checks" :key="c.at" class="t-small rounded p-2" style="background: var(--surface-base);">
            <summary class="cursor-pointer focus-ring">
              Visit {{ c.visit }} ·
              <span class="font-mono" :style="{ color: c.verdict === 'CONTINUE' ? STATUS_COLOR.completed : c.verdict === 'ABORT' ? STATUS_COLOR.failed : 'var(--warning)' }">{{ c.verdict }}</span>
            </summary>
            <pre class="whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{{ c.note }}</pre>
          </details>
        </div>

        <p v-if="step.error" class="t-small" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>

        <div v-if="step.childRunIds?.length" class="space-y-0.5" data-testid="child-runs">
          <p class="t-small text-label">The runs this step started<template v-if="step.status === 'waiting'">, which it is waiting for</template></p>
          <NuxtLink :to="`/runs?parent=${run.id}`" class="t-small underline focus-ring">See all {{ step.childRunIds.length }} in Runs</NuxtLink>
        </div>

        <div v-if="logs.length" class="max-h-72 overflow-auto rounded p-2" style="background: var(--surface-base); border: 1px solid var(--border-subtle);"><LogLines :lines="logs" /></div>
        <pre v-else-if="step.output" class="t-small whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
        <p v-else class="t-small text-label">No output yet.</p>

        <div class="flex flex-wrap gap-2">
          <UButton v-if="mayDrive && settledRun && settled && !replaying" size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Replay from here" @click="replaying = true" />
          <UButton v-if="mayDrive && step.sessionId && step.sessionProject" size="xs" variant="soft" icon="i-lucide-message-circle" label="Ask this agent" :to="`/cli/project/${step.sessionProject}/session/${step.sessionId}`" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-folder-open" label="Evidence" @click="ctx.openEvidence()" />
        </div>
        <div v-if="replaying" class="space-y-2">
          <textarea v-model="replayNote" rows="2" class="field-input w-full resize-none t-small" placeholder="Optional instruction for this step, e.g. verify from inside the container only" aria-label="Instruction for the replayed step" />
          <div class="flex gap-2">
            <UButton size="xs" icon="i-lucide-rotate-ccw" :label="`Replay from ${step.label}`" @click="replay" />
            <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="replaying = false" />
          </div>
        </div>
      </div>

      <div v-if="askingHere" class="px-3 pb-3">
        <RunGate :run="run" @respond="ctx.gate.respond" @continue="ctx.gate.continue" @reject="ctx.gate.reject" @rework="ctx.gate.rework" />
      </div>
    </article>
  </div>
</template>
```

Add `import { isLiveStatus } from '~~/shared/types/run'` to the script.

- [ ] **Step 3: `RunStackBlocks.vue` (recursive)**

```vue
<script setup lang="ts">
import type { StackBlock } from '~~/shared/utils/workflowStack'
import { RUN_STACK_KEY } from '~/utils/runStack'

/** Renders one level of the stack; paths render their branches with this same component. */
defineProps<{ blocks: StackBlock[] }>()
const ctx = inject(RUN_STACK_KEY)!
const run = ctx.run

/** A branch's condition is its first step's runWhen. */
function conditionOf(branch: StackBlock[]): string {
  const first = branch[0]
  if (!first) return 'Goes straight on'
  if (first.kind !== 'step') return 'Always'
  const when = ctx.workflowStepOf(first.stepId)?.runWhen?.artifact
  return when ? `If ${when} exists` : 'Always'
}
const approvalHere = (id: string) => run.value.question?.stepId === id && run.value.question.kind === 'approval'
</script>

<template>
  <template v-for="(b, i) in blocks" :key="b.kind === 'step' ? b.stepId : `paths-${i}`">
    <div v-if="i > 0" class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />

    <template v-if="b.kind === 'step'">
      <template v-if="ctx.workflowStepOf(b.stepId)?.approval">
        <section
          class="w-full rounded-lg px-3 py-2 space-y-2"
          :style="{ background: approvalHere(b.stepId) ? 'var(--accent-muted)' : 'var(--surface-raised)', border: `1px ${approvalHere(b.stepId) ? 'solid var(--warning)' : 'dashed var(--border-default)'}` }"
          :aria-label="`Approval before ${ctx.stepOf(b.stepId)?.label}`"
        >
          <p class="t-small flex items-center gap-1.5" style="color: var(--text-secondary);">
            <UIcon name="i-lucide-hand" class="size-3.5" />
            Approval by {{ ctx.workflowStepOf(b.stepId)?.gateRole ?? 'anyone' }} · can send the work back to any earlier step, up to 2 times
          </p>
          <RunGate
            v-if="approvalHere(b.stepId)" :run="run"
            @respond="ctx.gate.respond" @continue="ctx.gate.continue" @reject="ctx.gate.reject" @rework="ctx.gate.rework"
          />
        </section>
        <div class="w-0.5 h-5 mx-auto" style="background: var(--border-default);" aria-hidden="true" />
      </template>
      <RunStackCard :step-id="b.stepId" />
    </template>

    <div
      v-else class="w-full grid gap-3 rounded-xl p-3"
      :style="{ gridTemplateColumns: `repeat(${b.branches.length}, minmax(0, 1fr))`, border: '1px dashed var(--border-default)' }"
      role="group" :aria-label="b.rejoin ? 'Paths that run in parallel and rejoin' : 'Paths that each end separately'"
    >
      <div v-for="(br, j) in b.branches" :key="j" class="flex flex-col items-stretch gap-1 min-w-0">
        <p class="t-small font-mono text-label truncate">{{ conditionOf(br) }}</p>
        <RunStackBlocks :blocks="br" />
      </div>
    </div>
  </template>
</template>
```

On narrow screens paths stack vertically. Add `class="max-sm:!grid-cols-1"` to the paths `div`. The inline `gridTemplateColumns` needs the `!` to be overridden.

- [ ] **Step 4: `RunStack.vue`**

```vue
<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import type { Workflow } from '~/types'
import { buildGraph, ancestorsOf } from '~~/shared/utils/workflowGraph'
import { sendBackArrows, stackForRun, stepKind } from '~~/shared/utils/workflowStack'
import { RUN_STACK_KEY } from '~/utils/runStack'
import { isLiveStatus } from '~~/shared/types/run'

/**
 * A run as a vertical stack of its steps, laid out like its workflow: the
 * header, then every step as a card, parallel steps side by side, the open
 * decision inside the card that waits on it, and send-backs marked where they
 * landed. Same events as WorkflowRunPanel, so either can sit behind a run.
 */
const props = defineProps<{ run: WorkflowRun, logs?: Record<string, string[]> }>()
const emit = defineEmits<{
  continue: [note?: string], respond: [reply: string], reject: [note: string], rework: [stepId: string, note: string],
  note: [text: string], stop: [], restart: [stepId: string, note?: string], clone: [],
}>()

const workflow = ref<Workflow | null>(null)
watch(() => props.run.workflowSlug, async (slug) => {
  try { workflow.value = await $fetch<Workflow>(`/api/workflows/${slug}`) }
  catch { workflow.value = null }
}, { immediate: true })

const layout = computed(() => stackForRun(workflow.value?.steps, props.run.steps.map(s => s.stepId)))
const stepById = computed(() => new Map(props.run.steps.map(s => [s.stepId, s])))
const wfById = computed(() => new Map((workflow.value?.steps ?? []).map(s => [s.id, s])))
const graph = computed(() => (workflow.value ? buildGraph(workflow.value.steps) : null))

function readsOf(id: string): string[] {
  const g = graph.value
  if (!g || !g.forwardPreds[id]) return []
  const ids = wfById.value.get(id)?.contextMode === 'ancestors' ? ancestorsOf(g, id) : g.forwardPreds[id]!
  return ids.map(p => stepById.value.get(p)?.label ?? p)
}

const openIds = ref(new Set<string>())
const toggle = (id: string) => {
  const next = new Set(openIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openIds.value = next
}

const arrows = computed(() => sendBackArrows(props.run).map((a, i) => ({ ...a, n: i + 1 })))

/** Child runs are only fetched when some step started any. */
const children = ref<WorkflowRun[]>([])
watch(() => props.run.steps.some(s => s.childRunIds?.length), async (has) => {
  if (!has) return
  try { children.value = await $fetch<WorkflowRun[]>('/api/runs') }
  catch { children.value = [] }
}, { immediate: true })
function childSummary(id: string): string {
  const ids = stepById.value.get(id)?.childRunIds ?? []
  const mine = children.value.filter(r => ids.includes(r.id))
  if (!mine.length) return `${ids.length} ${ids.length === 1 ? 'child run' : 'child runs'}`
  const done = mine.filter(r => r.status === 'completed').length
  const waiting = mine.filter(r => isWaitingOnAPerson(r.status)).length
  const failed = mine.filter(r => r.status === 'failed').length
  return [`${ids.length} children`, done && `${done} done`, waiting && `${waiting} waiting`, failed && `${failed} failed`].filter(Boolean).join(', ')
}

const evidenceOpen = ref(false)

provide(RUN_STACK_KEY, {
  run: toRef(props, 'run'),
  stepOf: id => stepById.value.get(id),
  workflowStepOf: id => wfById.value.get(id),
  kindOf: id => stepKind(wfById.value.get(id)),
  readsOf,
  logsOf: id => props.logs?.[id] ?? [],
  isOpen: id => openIds.value.has(id),
  toggle,
  arrivalsOf: id => arrows.value.filter(a => a.to === id),
  childSummary,
  gate: {
    respond: r => emit('respond', r),
    continue: n => emit('continue', n),
    reject: n => emit('reject', n),
    rework: (s, n) => emit('rework', s, n),
  },
  restart: (s, n) => emit('restart', s, n),
  openEvidence: () => { evidenceOpen.value = true },
})

/** `#step-<id>` opens that card and scrolls to it: the inbox links here. The gate's card opens by itself. */
const route = useRoute()
onMounted(async () => {
  const fromHash = route.hash.startsWith('#step-') ? route.hash.slice(6) : null
  const target = fromHash ?? props.run.question?.stepId
  if (!target) return
  if (props.run.question?.kind !== 'approval' || fromHash) toggle(target)
  await nextTick()
  document.getElementById(`step-${target}`)?.scrollIntoView({ block: 'center' })
})
</script>

<template>
  <div class="space-y-4">
    <RunHeader :run="run" @note="(t) => emit('note', t)" @continue="emit('continue')" @stop="emit('stop')" @clone="emit('clone')" />
    <p v-if="layout.note" class="t-small text-label">{{ layout.note }}</p>
    <!-- Gated on an artifact's entries with no step to hang the decision on. -->
    <RunGate
      v-if="run.status === 'awaiting_review' && !run.question" :run="run"
      @respond="(r) => emit('respond', r)" @continue="(n) => emit('continue', n)" @reject="(n) => emit('reject', n)" @rework="(s, n) => emit('rework', s, n)"
    />
    <div class="max-w-2xl mx-auto flex flex-col items-center">
      <div class="w-full rounded-lg px-3 py-2 t-small flex items-center gap-2" style="background: var(--surface-raised); border: 1px solid var(--border-subtle);">
        <UIcon :name="run.watch && run.watch !== 'direct-invocation' ? 'i-lucide-radar' : 'i-lucide-play'" class="size-4 shrink-0" style="color: var(--warning);" />
        <span class="truncate">
          <span class="text-label">Started </span>
          <template v-if="run.ticketKey">from <span class="font-mono">{{ run.ticketKey }}</span></template>
          <template v-else>manually</template>
          <template v-if="run.startedBy"> by {{ run.startedBy }}</template>
          · {{ new Date(run.startedAt).toLocaleString() }}
        </span>
      </div>
      <div class="w-0.5 h-5" style="background: var(--border-default);" aria-hidden="true" />
      <RunStackBlocks :blocks="layout.blocks" />
    </div>
    <USlideover v-model:open="evidenceOpen" title="Evidence" :ui="{ content: 'max-w-3xl' }">
      <template #body><RunArtifacts :run-id="run.id" :live="isLiveStatus(run.status)" /></template>
    </USlideover>
  </div>
</template>
```

Add `isWaitingOnAPerson` to the `~~/shared/types/run` import.

The return arrow is drawn as a text marker above the target card ("Sent back here (n) by … from …"). It says who, where from, why and which number. A drawn line in the margin would add no information, so it isn't built.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors in the four new files.

- [ ] **Step 6: Commit**

```bash
git add app/utils/runStack.ts app/components/RunStack.vue app/components/RunStackBlocks.vue app/components/RunStackCard.vue
git commit -m "feat(runs): RunStack renders a run as its workflow's stack of steps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/runs/:id` and the inbox use `RunStack`

**Files:**
- Modify: `app/pages/runs/[id].vue:47-56`
- Modify: `app/components/NotificationRunDetail.vue:66-71` and the "Full run and evidence" button

- [ ] **Step 1: Replace the two-column grid in `runs/[id].vue`**

Replace the `<div v-else-if="run" class="flex-1 min-h-0 grid ...">…</div>` block with:

```vue
    <div v-else-if="run" class="flex-1 min-h-0 overflow-y-auto page page--wide">
      <RunStack
        :run="run" :logs="logs"
        @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
        @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
      />
    </div>
```

`RunArtifacts` now opens from each card's Evidence button, so the `live` computed has no user left. Delete it and its `isLiveStatus` import.

- [ ] **Step 2: Swap the panel in `NotificationRunDetail.vue`**

Replace the `<WorkflowRunPanel … />` element with:

```vue
    <RunStack
      :run="run" :logs="logs"
      @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
      @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${run.id}`)"
    />
```

Change the button's `:to` to `` `/runs/${run.id}${run.question ? `#step-${run.question.stepId}` : ''}` ``.

Update the component's doc comment so it refers to `RunStack` instead of `WorkflowRunPanel`.

- [ ] **Step 3: Verify in the running app**

With agent-browser, and a screenshot of each:
- **Runbook A paused at its tech-lead approval.**
  - `/runs/:id` shows a straight line, three steps side by side, and the approval card with the verdict card and buttons.
  - The page scrolls to the approval card.
  - Approve works.
- **Send back to "Implement the fix" with a note.** After the restart, a "Sent back here (1) by <you> from …" marker sits above that card.
- **A scan run.** The paths end separately. The loop step reads, for example, "4 children, 3 done, 1 waiting". "See all 4 in Runs" opens `/runs?parent=<id>` (filtering comes in Task 6).
- **A monitored step that retried.** Expanding it shows "Visit 1 · RETRY" and "Visit 2 · CONTINUE".
- **The inbox.** Open a gate in `/notifications`. The stack shows with the gate open, and "Full run and evidence" lands on `/runs/:id#step-…` scrolled to it.
- **400px width.** Paths stack vertically, and the body doesn't scroll sideways.

Run: `node e2e/awaiting-review.smoke.mjs && node e2e/notifications.smoke.mjs`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add app/pages/runs/[id].vue app/components/NotificationRunDetail.vue
git commit -m "feat(runs): the run page and the inbox show the run stack

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `/runs` as list plus detail

**Files:**
- Modify: `app/pages/runs/index.vue`

**Interfaces:**
- Consumes: `<RunStack>` (Task 4), `useRun(id)` and `useRunActionToasts` from `app/composables/useRun.ts`, and `gateIsMine` from `~~/shared/utils/notifications`.
- Produces: the URL query keeps `q` and `mine` and adds `view` (`waiting | running | failed`), `parent` and `open` (the selected run id). The `status` query is dropped.

- [ ] **Step 1: Create a small detail component inside the page's folder**

Create `app/components/RunDetailPane.vue`:

```vue
<script setup lang="ts">
/** The selected run on /runs: the same stack as /runs/:id, keyed by id so switching runs re-subscribes. */
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ changed: [] }>()
const runApi = useRun(props.id)
const { run, logs, error, load, continueRun, stop, respond } = runApi
const { onReject, onRework, onNote, onRestart } = useRunActionToasts(runApi)
onMounted(load)
watch(() => run.value?.status, (s, was) => { if (was && s !== was) emit('changed') })
</script>

<template>
  <p v-if="error" class="t-ui text-label">{{ error }}</p>
  <RunStack
    v-else-if="run" :run="run" :logs="logs"
    @continue="(n) => continueRun(n)" @respond="respond" @reject="onReject" @rework="onRework"
    @note="onNote" @stop="stop" @restart="onRestart" @clone="navigateTo(`/workflows/${run.workflowSlug}?clone=${id}`)"
  />
  <SkeletonCard v-else />
</template>
```

- [ ] **Step 2: Rework the script of `runs/index.vue`**

Keep:
- `refresh` and the polling
- `live`, `now` and its clock
- `groups` and `loadFor`
- `del`, `confirmingDelete`
- `failedShown`, `deleteFailed` and the bulk refs
- `mine` and `filter`

Remove:
- `status`, `STATUSES`, `restartPoint`, `canRestart`, `canStop`
- `stop`, `confirmingStop`, `act`, `busy`, and `RUN_DURATION_HINT` if it becomes unused

Restart and stop now live on the run's cards and header.

Add:

```ts
import { gateIsMine } from '~~/shared/utils/notifications'
import { isWaitingOnAPerson } from '~~/shared/types/run'

const { role } = useUser()
const view = computed({
  get: () => (typeof route.query.view === 'string' ? route.query.view : ''),
  set: v => router.replace({ query: { ...route.query, view: v || undefined } }),
})
const parent = computed(() => (typeof route.query.parent === 'string' ? route.query.parent : ''))
const openId = computed({
  get: () => (typeof route.query.open === 'string' ? route.query.open : ''),
  set: v => router.replace({ query: { ...route.query, open: v || undefined } }),
})

const waitingOnMe = (r: WorkflowRun) => isWaitingOnAPerson(r.status) && gateIsMine(r.question?.role, role.value)
const VIEWS = [
  { value: '', label: 'All' },
  { value: 'waiting', label: 'Waiting on me' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
] as const
const inView = (r: WorkflowRun) =>
  view.value === 'waiting' ? waitingOnMe(r)
  : view.value === 'running' ? isLiveStatus(r.status)
  : view.value === 'failed' ? r.status === 'failed'
  : true
const countOf = (v: string) => runs.value.filter(r => (v === 'waiting' ? waitingOnMe(r) : v === 'running' ? isLiveStatus(r.status) : v === 'failed' ? r.status === 'failed' : true)).length

const shown = computed(() => runs.value.filter(r =>
  (!filter.value || [r.workflowName, r.initialPrompt.split('\n')[0] ?? '', r.startedBy ?? '', r.product?.name ?? '', r.ticketKey ?? ''].some(v => v.toLowerCase().includes(filter.value.toLowerCase())))
  && (!mine.value || r.startedBy === me.value?.login)
  && (!parent.value || r.parentRunId === parent.value)
  && inView(r)))

/** Wide screens open the run beside the list; narrow ones go to its page. */
function select(r: WorkflowRun) {
  if (window.matchMedia('(min-width: 1024px)').matches) openId.value = r.id
  else navigateTo(`/runs/${r.id}`)
}
watch(shown, (list) => {
  if (!openId.value && list[0] && window.matchMedia('(min-width: 1024px)').matches) openId.value = list[0].id
}, { immediate: false })

const title = (r: WorkflowRun) => {
  const first = (r.initialPrompt.split('\n')[0] ?? '').slice(0, 80)
  return r.ticketKey && !first.startsWith(r.ticketKey) ? `${r.ticketKey} · ${first}` : first || r.workflowName
}
/** What a live row is doing right now: the running step, its last tool, how long ago. */
function liveLine(r: WorkflowRun): string {
  if (r.status === 'queued') {
    const g = loadFor(r)
    return g ? `Queued behind ${g.name}: ${g.inFlight} of ${g.maxConcurrent} running` : 'Queued'
  }
  const s = r.steps.find(x => x.status === 'running')
  if (!s) return ''
  const ago = s.lastActivityAt ? `${Math.max(0, Math.round((now.value - s.lastActivityAt) / 1000))}s ago` : ''
  return [s.label, s.lastTool, ago].filter(Boolean).join(' · ')
}
```

`RunLiveCard` is no longer rendered here. `liveLine` takes over its content. Leave the component file in place, because Plan 2 checks its other users.

- [ ] **Step 3: Replace the template body**

Replace everything inside `<div class="page space-y-4">` with:

```vue
      <div class="flex flex-wrap gap-2 items-center">
        <button
          v-for="v in VIEWS" :key="v.value"
          class="t-small rounded-full px-3 py-1 focus-ring"
          :style="view === v.value ? 'background: var(--accent-muted); color: var(--text-accent); font-weight: 600;' : 'background: var(--surface-inset); color: var(--text-secondary);'"
          :aria-pressed="view === v.value" @click="view = v.value"
        >{{ v.label }} <span class="tabular-nums">{{ countOf(v.value) }}</span></button>
        <input v-model="filter" placeholder="Filter by ticket, workflow, product or person..." class="field-search max-w-xs" aria-label="Filter runs" />
        <label class="t-small text-label flex items-center gap-1.5"><input v-model="mine" type="checkbox"> Started by me</label>
        <UButton v-if="parent" size="xs" variant="soft" icon="i-lucide-x" :label="`Children of ${parent.slice(0, 8)}`" @click="router.replace({ query: { ...route.query, parent: undefined } })" />
        <UButton
          v-if="failedShown.length" size="xs" class="ml-auto"
          :variant="confirmingBulk ? 'solid' : 'soft'" :color="confirmingBulk ? 'error' : 'neutral'"
          icon="i-lucide-trash-2" :loading="bulkDeleting"
          :label="confirmingBulk ? `Delete ${failedShown.length} failed — confirm` : `Delete ${failedShown.length} failed`"
          @click="deleteFailed"
        />
      </div>

      <!-- PASTE: the existing loadError / !loaded / !runs.length / !shown.length
           blocks (lines 237-255) verbatim. -->

      <div v-else class="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)] items-start">
        <ul class="rounded-xl overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto" style="border: 1px solid var(--border-subtle);" aria-live="polite">
          <li v-for="r in shown" :key="r.id" style="border-top: 1px solid var(--border-subtle);" class="first:border-t-0">
            <button
              class="w-full text-left px-3 py-2.5 space-y-1 focus-ring"
              :style="openId === r.id ? 'background: var(--surface-hover); box-shadow: inset 3px 0 0 var(--accent);' : ''"
              :aria-current="openId === r.id" @click="select(r)"
            >
              <span class="flex items-center gap-2">
                <span class="t-ui font-medium truncate flex-1" style="color: var(--text-primary);" :title="r.initialPrompt">{{ title(r) }}</span>
                <span class="t-small font-mono shrink-0" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ waitingOnMe(r) ? 'Yours' : runStatusLabel(r.status) }}</span>
              </span>
              <span class="block t-small font-mono text-label truncate">{{ r.workflowName }} · {{ duration(r) }}{{ r.startedBy ? ` · ${r.startedBy}` : '' }}</span>
              <span v-if="liveLine(r)" class="block t-small font-mono truncate" style="color: var(--info);">{{ liveLine(r) }}</span>
              <RunProgressBar :steps="r.steps" />
            </button>
          </li>
        </ul>
        <section class="hidden lg:block min-w-0">
          <template v-if="openId">
            <div class="flex justify-end gap-2 mb-2">
              <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-external-link" label="Open run page" :to="`/runs/${openId}`" />
              <UButton
                v-if="shown.find(r => r.id === openId) && canDelete(shown.find(r => r.id === openId)!)"
                size="xs" variant="ghost" :color="confirmingDelete === openId ? 'error' : 'neutral'"
                :icon="confirmingDelete === openId ? undefined : 'i-lucide-trash-2'"
                :label="confirmingDelete === openId ? 'Confirm delete' : 'Delete'"
                @click="del(shown.find(r => r.id === openId)!)"
              />
            </div>
            <RunDetailPane :id="openId" :key="openId" @changed="refresh" />
          </template>
          <p v-else class="t-ui text-label">Select a run.</p>
        </section>
      </div>
```

After `del` deletes the open run, clear the selection. Inside `del`, after `await refresh()`, add `if (openId.value === r.id) openId.value = ''`.

Update the page intro line to: "Every workflow run, newest first. Select one to see its steps, or filter to what is waiting on you."

- [ ] **Step 4: Typecheck, then verify in the running app**

Run: `bun run typecheck`, which should show no errors in `runs/index.vue` or `RunDetailPane.vue`.

With agent-browser, and a screenshot of each:
- At 1280px: selecting rows changes the right pane, and the URL `?open=` updates.
- "Waiting on me" shows only gates your role owns.
- A loop step's "See all N in Runs" lands filtered with the "Children of …" chip. Removing the chip clears the filter.
- "Delete N failed" still works.
- At 400px: only the list shows, and a row opens `/runs/:id`.

Run: `node e2e/workflow-run-panel.smoke.mjs`
Expected: pass. If it asserts the old table's columns on `/runs`, update those selectors to the new row markup in the same commit. The run history rows it checks (`run-history-row`) belong to the builder, which Plan 1 doesn't change.

- [ ] **Step 5: Commit**

```bash
git add app/pages/runs/index.vue app/components/RunDetailPane.vue e2e/
git commit -m "feat(runs): runs page lists runs beside the selected run's stack

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Documentation and spec corrections

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md`

- [ ] **Step 1: Correct the spec where the code disagreed with it**

In the spec's Non-goals list, replace "`RunStep.headAtStart`, and agent entries in `decisions`" with "`RunStep.headAtStart`, `RunStep.checks` and `WorkflowRun.sendBacks`".

Under "Agent send-backs get recorded", replace the paragraph that appends a `RunDecision` with:

> Where the runner applies a rework, it appends a `SendBack { from, target, instruction, by: 'agent:<slug>', at }` to `run.sendBacks`. Agent send-backs don't go into `run.decisions`, because `PipelineBoard` lists, counts and attributes that array as decisions people made. `sendBackArrows(run)` merges both sources for the stack.

Under the Expanded bullet for Check, add: "Read from `RunStep.checks`, which the runner appends on every monitor verdict. Before this, a step kept only its latest verdict."

Under the send-back arrows, add: "Drawn as a marker above the target card that says who sent the work back, from which step, why, and which number it is. No line is drawn in the margin."

- [ ] **Step 2: Document the components in `CLAUDE.md`**

Under **Pages**, change the `/runs` line to:

```
- `/runs` - Runs list with the selected run's stack beside it; `/runs/:id` the same stack full page
```

Under **Composables**, don't change anything. After the "Studio Chat System" section, add:

```markdown
**Run stack** (`/runs`, `/runs/:id`, the notifications inbox):
A run is drawn as its workflow's stack of steps. `shared/utils/workflowStack.ts` turns `next[]` into series/parallel blocks (`toStack`, `fromStack`, `stackForRun`) and refuses graphs it cannot draw. `RunStack.vue` renders `RunHeader` (the run as a whole), `RunStackBlocks` (recursive: steps, paths, approval cards) and `RunStackCard` (one step), and puts `RunGate` (the open decision) inside the card that waits on it. Per-visit monitor verdicts are `RunStep.checks`; agent send-backs are `WorkflowRun.sendBacks` (human ones stay in `decisions`).
```

- [ ] **Step 3: Run the full test suite**

Run: `for t in scripts/test-*.mjs engineering/scripts/test-*.mjs; do node "$t" || break; done`
Expected: every script prints its pass line, and the loop doesn't break.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md
git commit -m "docs: run stack components, and the spec's two corrections

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## What Plans 2 and 3 pick up

- **Plan 2 (builder):**
  - `RunStack` gains a build mode.
  - The workflow page moves to the stack plus drawer, with the trigger card, the action picker and paths editing.
  - `WorkflowRunPanel`, `WorkflowRunBar`, `WorkflowNode`, the canvas and possibly `@vue-flow/*` are removed.
  - `RunLiveCard` is checked for remaining users.
- **Plan 3 (test runs):**
  - `POST /api/runs/:id/test`, `startTestRun`, `stopAfter`, `headAtStart`, dry-run runner steps, `origin: 'test'` exclusions, and the "Tests" chip on `/runs`.
