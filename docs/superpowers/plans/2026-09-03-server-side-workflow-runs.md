# Server-Side Workflow Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workflow run a server-owned, persisted object so it survives leaving the page, and show live per-agent status when the workflow is opened.

**Architecture:** The DAG scheduler moves to `shared/` so both sides use one copy. A run becomes a JSON record under `~/.claude/workflow-runs/`, driven by a server-side runner and streamed to the browser over SSE. The client composable that used to *drive* runs is deleted and replaced by one that *subscribes*.

**Tech Stack:** Nuxt 3.16 (`compatibilityVersion: 4`), Nitro server routes, `@anthropic-ai/claude-agent-sdk`, Node 24. No test framework — plain `node:assert/strict` scripts under `scripts/`, run with `node scripts/<name>.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-03-server-side-workflow-runs-design.md`

## Global Constraints

- **`bun` is NOT installed.** Use `npm`. `npm run typecheck` is broken pre-existing; typecheck with:
  `node .superpowers/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit` — create that pinned install if absent with `npm install --no-save typescript@5.9.3 vue-tsc@3.3.11` in a scratch dir. Exactly one pre-existing error is expected and is NOT yours: `scripts/test-workflow-graph.mjs(54,1): error TS1005: '=>' expected.`
- **Port 3030 is a running production container.** Never use or stop it. Use `npx nuxt dev --port 3031` and stop it when done.
- **Never write model names as string literals** — use `MODEL` constants from `~/utils/models` (frontend) or `MODEL_ALIAS_KEY` (server).
- **Persistence root is `CLAUDE_DIR`**, resolved via `server/utils/claudeDir.ts`'s `resolveClaudePath` — never a hardcoded `~/.claude`.
- Test convention: plain `node:assert/strict` in `scripts/`, no framework, following `scripts/test-workflow-graph.mjs`.
- Backward compatibility: the three legacy workflow templates and all existing workflows must still run.

---

### Task 1: Move the scheduler to `shared/`

The server needs the exact DAG logic the client has, and this repo's `CLAUDE.md` forbids importing `app/utils` server-side. Duplicating a scheduler guarantees drift. Nuxt resolves a `shared/` directory in this version.

**Files:**
- Create: `shared/utils/workflowGraph.ts` (moved from `app/utils/workflowGraph.ts`)
- Delete: `app/utils/workflowGraph.ts`
- Modify: `app/composables/useWorkflowExecution.ts` (import path)
- Modify: `scripts/test-workflow-graph.mjs` (import path only)

**Interfaces:**
- Consumes: nothing.
- Produces: `shared/utils/workflowGraph.ts` exporting exactly what it exported before — `buildGraph`, `initRunState`, `readyNodes`, `markRunning`, `markCompleted`, `markFailed`, `skipPending`, `isFinished`, `armNode`, `canRevisit`, `joinInputs`, `parseVerdict`, `monitorPrompt`, `edgeKey`, `MAX_CONCURRENCY`, and the types `WorkflowGraph`, `RunState`.

- [ ] **Step 1: Prove the server can import from `shared/` BEFORE moving anything**

Note for later tasks: runtime imports of `shared/` from `server/` use a **relative**
path (`../../shared/utils/workflowGraph`), because the plain-node test scripts import
those server files directly and cannot resolve Nuxt aliases. Type-only imports may use
the alias freely — Node erases them.

This is the assumption the whole plan rests on. If it fails, STOP and report — do not fall back to a duplicate.

```bash
mkdir -p shared/utils
cat > shared/utils/__probe.ts <<'EOF'
export const PROBE = 'shared-import-works'
EOF
mkdir -p server/api/__probe
cat > server/api/__probe/index.get.ts <<'EOF'
import { PROBE } from '~~/shared/utils/__probe'
export default defineEventHandler(() => ({ probe: PROBE }))
EOF
```

Run `npx nuxt dev --port 3031` in the background, wait for it to boot, then:
`curl -s localhost:3031/api/__probe`
Expected: `{"probe":"shared-import-works"}`

If the `~~/shared/...` specifier fails, try `#shared/utils/__probe`. Record in your report which specifier actually worked — later tasks must use the same one.

- [ ] **Step 2: Remove the probe**

```bash
rm -rf server/api/__probe shared/utils/__probe.ts
```
Stop the dev server.

- [ ] **Step 3: Move the file**

```bash
git mv app/utils/workflowGraph.ts shared/utils/workflowGraph.ts
```
Change nothing inside it. The whole point of this task is that behaviour is identical.

- [ ] **Step 4: Update the two importers**

In `scripts/test-workflow-graph.mjs`, change `from '../app/utils/workflowGraph.ts'` to `from '../shared/utils/workflowGraph.ts'`.

In `app/composables/useWorkflowExecution.ts`, change `from '~/utils/workflowGraph'` to the specifier that worked in Step 1 (`~~/shared/utils/workflowGraph` or `#shared/utils/workflowGraph`).

- [ ] **Step 5: Run the existing test unchanged — this is the proof**

Run: `node scripts/test-workflow-graph.mjs`
Expected: `workflowGraph: all checks passed`

If it fails, the move altered behaviour. Fix the move, not the test.

- [ ] **Step 6: Typecheck and confirm nothing else referenced the old path**

```bash
grep -rn "utils/workflowGraph" app/ server/ scripts/ shared/ --include=*.ts --include=*.vue --include=*.mjs
```
Every hit must point at `shared/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move the workflow scheduler to shared/ so the server can use it"
```

---

### Task 2: Run types and the run store

**Files:**
- Create: `shared/types/run.ts`
- Create: `server/utils/workflowRunStore.ts`
- Test: `scripts/test-workflow-run-store.mjs`

**Interfaces:**
- Consumes: `resolveClaudePath` from `server/utils/claudeDir.ts`.
- Produces:
  - Types `RunStatus`, `RunStep`, `WorkflowRun` (shapes below, verbatim).
  - `createRun(input: NewRunInput): Promise<WorkflowRun>`
  - `getRun(id: string): Promise<WorkflowRun | null>` — applies the `interrupted` computation
  - `saveRun(run: WorkflowRun): Promise<void>`
  - `listRuns(workflowSlug?: string): Promise<WorkflowRun[]>` — newest first
  - `findActiveRun(workflowSlug: string): Promise<WorkflowRun | null>`
  - `RUNS_DIR_NAME = 'workflow-runs'`

- [ ] **Step 1: Write the types**

Create `shared/types/run.ts`:

```ts
export type RunStatus =
  | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type RunStepStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface RunStep {
  stepId: string
  label: string
  /** The agent behind this step. The operator's real question is "which agent, and how is it doing". */
  agentSlug: string
  status: RunStepStatus
  input: string
  output: string
  error?: string
  startedAt?: number
  completedAt?: number
  visits: number
  monitorVerdict?: 'CONTINUE' | 'RETRY' | 'ABORT'
  monitorNote?: string
}

export interface WorkflowRun {
  id: string
  workflowSlug: string
  workflowName: string
  status: RunStatus
  autoRun: boolean
  initialPrompt: string
  projectDir?: string
  steps: RunStep[]
  currentStepIds: string[]
  nextStepIds: string[]
  startedAt: number
  endedAt?: number
  error?: string
  /** The process that owns this run. A live status from a dead pid is a lie. */
  pid: number
}

export interface NewRunInput {
  workflowSlug: string
  workflowName: string
  autoRun: boolean
  initialPrompt: string
  projectDir?: string
  steps: { stepId: string, label: string, agentSlug: string }[]
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test-workflow-run-store.mjs`:

```js
/**
 * Self-check for server/utils/workflowRunStore.ts. Plain asserts, no framework.
 * Uses a temp CLAUDE_DIR so it never touches the real ~/.claude.
 *
 *   node scripts/test-workflow-run-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runstore-'))

const store = await import('../server/utils/workflowRunStore.ts')

const sampleSteps = [
  { stepId: 's1', label: 'Intake', agentSlug: 'sdlc-ticket-intake' },
  { stepId: 's2', label: 'Fix', agentSlug: 'sdlc-fix-implementer' },
]

// ── 1. A new run starts pending, owned by this process ────────────────────
const run = await store.createRun({
  workflowSlug: 'demo', workflowName: 'Demo', autoRun: false,
  initialPrompt: 'do the thing', steps: sampleSteps,
})
assert.ok(run.id, 'run gets an id')
assert.equal(run.status, 'running')
assert.equal(run.pid, process.pid)
assert.equal(run.steps.length, 2)
assert.equal(run.steps[0].status, 'pending')
assert.equal(run.steps[0].agentSlug, 'sdlc-ticket-intake', 'the agent is carried on the step')
assert.equal(run.steps[0].visits, 0)

// ── 2. It round-trips through disk ────────────────────────────────────────
const loaded = await store.getRun(run.id)
assert.deepEqual(loaded.steps.map(s => s.agentSlug), ['sdlc-ticket-intake', 'sdlc-fix-implementer'])
assert.equal(loaded.workflowName, 'Demo')

// ── 3. Updates persist ────────────────────────────────────────────────────
loaded.steps[0].status = 'completed'
loaded.steps[0].output = 'the packet'
loaded.status = 'paused'
await store.saveRun(loaded)
const reloaded = await store.getRun(run.id)
assert.equal(reloaded.status, 'paused')
assert.equal(reloaded.steps[0].output, 'the packet')

// ── 4. A run owned by a dead process reads back as interrupted ────────────
// Not written to disk as 'interrupted' — the process that would write it is
// by definition gone, so it has to be computed on read.
reloaded.pid = 999999            // a pid that is not running
reloaded.status = 'running'
await store.saveRun(reloaded)
const orphaned = await store.getRun(run.id)
assert.equal(orphaned.status, 'interrupted', 'a running run with a dead owner is interrupted')
assert.equal(orphaned.steps[0].output, 'the packet', 'its steps stay frozen at last persisted state')

// ── 5. A finished run is never rewritten as interrupted ───────────────────
orphaned.status = 'completed'
await store.saveRun(orphaned)
const done = await store.getRun(run.id)
assert.equal(done.status, 'completed', 'a completed run stays completed regardless of pid')

// ── 6. Listing is newest first and filters by workflow ────────────────────
const other = await store.createRun({
  workflowSlug: 'other', workflowName: 'Other', autoRun: true,
  initialPrompt: 'x', steps: sampleSteps,
})
const all = await store.listRuns()
assert.equal(all.length, 2)
assert.equal(all[0].id, other.id, 'newest first')
const onlyDemo = await store.listRuns('demo')
assert.equal(onlyDemo.length, 1)
assert.equal(onlyDemo[0].workflowSlug, 'demo')

// ── 7. Active-run lookup ignores finished runs ────────────────────────────
assert.equal(await store.findActiveRun('demo'), null, 'a completed run is not active')
const active = await store.findActiveRun('other')
assert.equal(active.id, other.id)

// ── 8. A missing run is null, not a throw ─────────────────────────────────
assert.equal(await store.getRun('does-not-exist'), null)

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('workflowRunStore: all assertions passed')
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node scripts/test-workflow-run-store.mjs`
Expected: FAIL — cannot resolve `../server/utils/workflowRunStore.ts`.

- [ ] **Step 4: Implement the store**

Create `server/utils/workflowRunStore.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir'
import type { WorkflowRun, NewRunInput } from '~~/shared/types/run'

export const RUNS_DIR_NAME = 'workflow-runs'

const runsDir = () => resolveClaudePath(RUNS_DIR_NAME)
const runPath = (id: string) => join(runsDir(), `${id}.json`)

async function ensureDir() {
  const dir = runsDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** Is that process still alive? Signal 0 tests existence without signalling. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * A run whose owning process is gone cannot still be running. This is computed
 * on read rather than written, because the writer is the thing that died.
 */
function applyInterrupted(run: WorkflowRun): WorkflowRun {
  const live = run.status === 'running' || run.status === 'paused'
  if (live && !processAlive(run.pid)) return { ...run, status: 'interrupted' }
  return run
}

export async function createRun(input: NewRunInput): Promise<WorkflowRun> {
  await ensureDir()
  const run: WorkflowRun = {
    id: randomUUID(),
    workflowSlug: input.workflowSlug,
    workflowName: input.workflowName,
    status: 'running',
    autoRun: input.autoRun,
    initialPrompt: input.initialPrompt,
    projectDir: input.projectDir,
    steps: input.steps.map(s => ({
      stepId: s.stepId, label: s.label, agentSlug: s.agentSlug,
      status: 'pending', input: '', output: '', visits: 0,
    })),
    currentStepIds: [],
    nextStepIds: [],
    startedAt: Date.now(),
    pid: process.pid,
  }
  await saveRun(run)
  return run
}

export async function saveRun(run: WorkflowRun): Promise<void> {
  await ensureDir()
  await writeFile(runPath(run.id), JSON.stringify(run, null, 2), 'utf-8')
}

export async function getRun(id: string): Promise<WorkflowRun | null> {
  const path = runPath(id)
  if (!existsSync(path)) return null
  try {
    return applyInterrupted(JSON.parse(await readFile(path, 'utf-8')) as WorkflowRun)
  } catch {
    // A half-written or corrupt record is a missing record, never a crash.
    return null
  }
}

export async function listRuns(workflowSlug?: string): Promise<WorkflowRun[]> {
  const dir = runsDir()
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  const runs: WorkflowRun[] = []
  for (const file of files) {
    const run = await getRun(file.replace(/\.json$/, ''))
    if (run && (!workflowSlug || run.workflowSlug === workflowSlug)) runs.push(run)
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt)
}

export async function findActiveRun(workflowSlug: string): Promise<WorkflowRun | null> {
  const runs = await listRuns(workflowSlug)
  return runs.find(r => r.status === 'running' || r.status === 'paused') ?? null
}
```

- [ ] **Step 5: Run the test until it passes**

Run: `node scripts/test-workflow-run-store.mjs`
Expected: `workflowRunStore: all assertions passed`

- [ ] **Step 6: Commit**

```bash
git add shared/types/run.ts server/utils/workflowRunStore.ts scripts/test-workflow-run-store.mjs
git commit -m "feat: persist workflow runs with per-agent step status"
```

---

### Task 3: The server-side runner

**Files:**
- Create: `server/utils/workflowRunner.ts`
- Test: `scripts/test-workflow-runner.mjs`

**Interfaces:**
- Consumes: `shared/utils/workflowGraph.ts`; the store from Task 2.
- Produces:
  - `startRun(opts: StartRunOpts): Promise<WorkflowRun>`
  - `continueRun(runId: string): Promise<WorkflowRun | null>`
  - `respondToRun(runId: string, reply: string): Promise<WorkflowRun | null>`
  - `stopRun(runId: string): Promise<WorkflowRun | null>`
  - `subscribe(runId: string, fn: (run: WorkflowRun) => void): () => void`
  - `type AgentCaller = (agentSlug: string, input: string, projectDir?: string) => Promise<string>`
  - `setAgentCaller(fn: AgentCaller): void` — dependency seam so tests drive the loop without spending tokens.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-workflow-runner.mjs`:

```js
/**
 * Self-check for the server-side runner. A stub agent caller drives the loop,
 * so the scheduler, persistence and pause/continue semantics are testable
 * without a single API call.
 *
 *   node scripts/test-workflow-runner.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runner-'))

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')

const calls = []
runner.setAgentCaller(async (agentSlug, input) => {
  calls.push({ agentSlug, input })
  return `output of ${agentSlug}`
})

const workflow = {
  slug: 'demo', name: 'Demo',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['b', 'c'] },
    { id: 'b', agentSlug: 'agent-b', label: 'B', next: ['d'] },
    { id: 'c', agentSlug: 'agent-c', label: 'C', next: ['d'] },
    { id: 'd', agentSlug: 'agent-d', label: 'D', next: [] },
  ],
}

// ── 1. A manual run stops after the first wave and persists that ──────────
let run = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
assert.equal(run.status, 'paused', 'a manual run pauses after its first wave')
assert.equal(run.steps.find(s => s.stepId === 'a').status, 'completed')
assert.equal(run.steps.find(s => s.stepId === 'a').output, 'output of agent-a')
assert.deepEqual(run.nextStepIds.sort(), ['b', 'c'], 'the fan-out is queued')

// It is on disk, not just in memory — that is the whole feature.
const fromDisk = await store.getRun(run.id)
assert.equal(fromDisk.status, 'paused')
assert.equal(fromDisk.steps.find(s => s.stepId === 'a').output, 'output of agent-a')

// ── 2. Continue runs the fan-out as ONE wave ──────────────────────────────
run = await runner.continueRun(run.id)
assert.equal(run.steps.find(s => s.stepId === 'b').status, 'completed')
assert.equal(run.steps.find(s => s.stepId === 'c').status, 'completed')
assert.deepEqual(run.nextStepIds, ['d'], 'the join is queued once both branches are done')

// ── 3. The join receives BOTH branches' output ────────────────────────────
run = await runner.continueRun(run.id)
const dInput = run.steps.find(s => s.stepId === 'd').input
assert.match(dInput, /output of agent-b/)
assert.match(dInput, /output of agent-c/)
assert.equal(run.status, 'completed')
assert.ok(run.endedAt, 'a finished run records when it ended')

// ── 4. An auto-run goes to completion with no continue calls ──────────────
calls.length = 0
const auto = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
assert.equal(auto.status, 'completed', 'auto-run finishes on its own')
assert.equal(calls.length, 4, 'every step ran exactly once')

// ── 5. A failing step stops the run and skips the rest ────────────────────
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'agent-b') throw new Error('agent-b exploded')
  return `output of ${agentSlug}`
})
const failing = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
assert.equal(failing.status, 'failed')
assert.equal(failing.steps.find(s => s.stepId === 'b').status, 'failed')
assert.match(failing.steps.find(s => s.stepId === 'b').error, /exploded/)
assert.equal(failing.steps.find(s => s.stepId === 'd').status, 'skipped',
  'a step downstream of a failure is skipped, never left pending')

// ── 6. Subscribers see progress ───────────────────────────────────────────
runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
const seen = []
const started = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
const unsubscribe = runner.subscribe(started.id, r => seen.push(r.status))
await runner.continueRun(started.id)
unsubscribe()
assert.ok(seen.length > 0, 'a subscriber is notified as the run advances')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('workflowRunner: all assertions passed')
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL — cannot resolve `../server/utils/workflowRunner.ts`.

- [ ] **Step 3: Implement the runner**

Create `server/utils/workflowRunner.ts`. Port the loop from `app/composables/useWorkflowExecution.ts` — same wave semantics, same monitor handling, same failure path — with run state living in the store instead of refs.

```ts
import {
  buildGraph, initRunState, readyNodes, markRunning, markCompleted, markFailed,
  skipPending, isFinished, armNode, canRevisit, joinInputs, parseVerdict,
  monitorPrompt, MAX_CONCURRENCY,
  type WorkflowGraph, type RunState,
} from '../../shared/utils/workflowGraph'   // relative, not an alias: the node
                                            // test scripts import this file
                                            // directly and cannot resolve ~~/
import { createRun, getRun, saveRun } from './workflowRunStore'
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
```

- [ ] **Step 4: Run the test until it passes**

Run: `node scripts/test-workflow-runner.mjs`
Expected: `workflowRunner: all assertions passed`

- [ ] **Step 5: Confirm the pre-existing scheduler test still passes**

Run: `node scripts/test-workflow-graph.mjs`
Expected: `workflowGraph: all checks passed`

- [ ] **Step 6: Commit**

```bash
git add server/utils/workflowRunner.ts scripts/test-workflow-runner.mjs
git commit -m "feat: drive workflow runs on the server instead of in the browser"
```

---

### Task 4: Run API endpoints

**Files:**
- Create: `server/api/workflows/[slug]/runs.post.ts`, `server/api/workflows/[slug]/runs.get.ts`
- Create: `server/api/runs/[id].get.ts`, `server/api/runs/[id]/continue.post.ts`, `server/api/runs/[id]/respond.post.ts`, `server/api/runs/[id]/stop.post.ts`
- Create: `server/utils/agentCaller.ts`

**Interfaces:**
- Consumes: `startRun`, `continueRun`, `respondToRun`, `stopRun`, `setAgentCaller` from Task 3; `getRun`, `listRuns`, `findActiveRun` from Task 2.
- Produces: the HTTP surface the client uses in Task 6.

- [ ] **Step 1: Wire the real agent caller**

Create `server/utils/agentCaller.ts`. It calls the SDK the same way `server/api/chat.post.ts` does, honouring the agent's own `tools` and `maxTurns` via `agentToolPolicy`.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir'
import { parseFrontmatter } from './frontmatter'
import { resolveTools, resolveMaxTurns } from './agentToolPolicy'
import { setAgentCaller } from './workflowRunner'
import type { AgentFrontmatter } from '~/types'

/** One agent turn. Returns its final text. */
async function callAgent(agentSlug: string, input: string, projectDir?: string): Promise<string> {
  const claudeDir = getClaudeDir()
  const cwd = projectDir && existsSync(projectDir) ? projectDir : claudeDir

  let systemAppend = `You are "${agentSlug}", a specialized agent.`
  let frontmatter: AgentFrontmatter | undefined

  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)
  if (existsSync(agentPath)) {
    const parsed = parseFrontmatter<AgentFrontmatter>(await readFile(agentPath, 'utf-8'))
    frontmatter = parsed.frontmatter
    systemAppend = `You are "${parsed.frontmatter.name || agentSlug}", a specialized agent. `
      + `Follow these instructions precisely:\n\n${parsed.body}\n\n`
      + `The current working directory is: ${cwd}`
  }

  const toolsOption = resolveTools(frontmatter)
  let result = ''
  for await (const message of query({
    prompt: input,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: resolveMaxTurns(frontmatter),
      ...(toolsOption ? { tools: toolsOption } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    },
  })) {
    if (message.type === 'result' && 'result' in message) result = String(message.result ?? '')
  }
  return result
}

setAgentCaller(callAgent)
```

- [ ] **Step 2: Start a run**

Create `server/api/workflows/[slug]/runs.post.ts`:

```ts
import { startRun } from '../../../utils/workflowRunner'
import { findActiveRun } from '../../../utils/workflowRunStore'
import '../../../utils/agentCaller'   // registers the real caller

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<{ initialPrompt: string, autoRun?: boolean, projectDir?: string }>(event)
  if (!body?.initialPrompt?.trim()) {
    throw createError({ statusCode: 400, message: 'initialPrompt is required' })
  }

  // One run per workflow: two concurrent runs against the same projectDir would
  // have their agents editing the same files.
  const active = await findActiveRun(slug)
  if (active) {
    throw createError({
      statusCode: 409,
      message: `This workflow already has a run in progress`,
      data: { runId: active.id },
    })
  }

  const workflow = await $fetch<{ slug: string, name: string, steps: any[] }>(`/api/workflows/${slug}`)
  if (!workflow?.steps?.length) {
    throw createError({ statusCode: 400, message: 'This workflow has no steps' })
  }

  // Deliberately not awaited to completion: the HTTP response returns as soon
  // as the run exists, and the run continues server-side. That is the feature.
  const run = await startRun({
    workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
    initialPrompt: body.initialPrompt,
    autoRun: body.autoRun === true,
    projectDir: body.projectDir,
  })
  return run
})
```

- [ ] **Step 3: The read and control endpoints**

`server/api/workflows/[slug]/runs.get.ts`:
```ts
import { listRuns } from '../../../utils/workflowRunStore'
export default defineEventHandler(async (event) =>
  listRuns(getRouterParam(event, 'slug')!))
```

`server/api/runs/[id].get.ts`:
```ts
import { getRun } from '../../utils/workflowRunStore'
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
```

`server/api/runs/[id]/continue.post.ts`:
```ts
import { continueRun } from '../../../utils/workflowRunner'
import '../../../utils/agentCaller'
export default defineEventHandler(async (event) => {
  const run = await continueRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
```

`server/api/runs/[id]/respond.post.ts`:
```ts
import { respondToRun } from '../../../utils/workflowRunner'
import '../../../utils/agentCaller'
export default defineEventHandler(async (event) => {
  const body = await readBody<{ reply: string }>(event)
  if (!body?.reply?.trim()) throw createError({ statusCode: 400, message: 'reply is required' })
  const run = await respondToRun(getRouterParam(event, 'id')!, body.reply)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
```

`server/api/runs/[id]/stop.post.ts`:
```ts
import { stopRun } from '../../../utils/workflowRunner'
export default defineEventHandler(async (event) => {
  const run = await stopRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return run
})
```

- [ ] **Step 4: Verify against a dev server**

Start `npx nuxt dev --port 3031`. Then:

```bash
curl -s localhost:3031/api/workflows | head -c 200          # find a slug
curl -s localhost:3031/api/workflows/<slug>/runs            # expect []
curl -s localhost:3031/api/runs/nope -o /dev/null -w '%{http_code}\n'   # expect 404
```
Report actual output. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add server/api/workflows server/api/runs server/utils/agentCaller.ts
git commit -m "feat: HTTP surface for starting, reading and controlling runs"
```

---

### Task 5: Live updates over SSE

**Files:**
- Create: `server/api/runs/[id]/stream.get.ts`

**Interfaces:**
- Consumes: `subscribe` from Task 3, `getRun` from Task 2.
- Produces: an SSE endpoint emitting `data: {"type":"run","run":{...}}` on every state change, then `data: {"type":"done"}`.

- [ ] **Step 1: Implement the stream**

```ts
import { getRun } from '../../../utils/workflowRunStore'
import { subscribe } from '../../../utils/workflowRunner'
import type { WorkflowRun } from '~~/shared/types/run'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const initial = await getRun(id)
  if (!initial) throw createError({ statusCode: 404, message: 'Run not found' })

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const send = (payload: unknown) => {
    event.node.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  // The full run first, so a late subscriber is immediately correct rather
  // than waiting for the next change.
  send({ type: 'run', run: initial })

  const finished = (r: WorkflowRun) =>
    r.status !== 'running' && r.status !== 'paused'

  if (finished(initial)) {
    send({ type: 'done' })
    event.node.res.end()
    return
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = subscribe(id, (run) => {
      send({ type: 'run', run })
      if (finished(run)) { send({ type: 'done' }); cleanup(); resolve() }
    })
    const cleanup = () => { unsubscribe(); try { event.node.res.end() } catch { /* already closed */ } }
    // The run is not the connection: a client leaving must not affect it.
    event.node.req.on('close', () => { unsubscribe(); resolve() })
  })
})
```

- [ ] **Step 2: Verify it streams**

Start `npx nuxt dev --port 3031`, start a run against a real workflow via `POST /api/workflows/<slug>/runs`, then in another shell:
`curl -N -s localhost:3031/api/runs/<id>/stream | head -5`
Expected: at least one `data: {"type":"run",...}` line. Report actual output. Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add server/api/runs/\[id\]/stream.get.ts
git commit -m "feat: stream run status over SSE"
```

---

### Task 6: The client — subscribe instead of drive

**Files:**
- Create: `app/composables/useWorkflowRun.ts`
- Create: `app/components/WorkflowRunPanel.vue`
- Modify: `app/pages/workflows/[slug].vue`
- Delete: `app/composables/useWorkflowExecution.ts`

**Interfaces:**
- Consumes: the endpoints from Tasks 4 and 5; `WorkflowRun` / `RunStep` types from Task 2.
- Produces: `useWorkflowRun()` returning `{ run, runs, loading, error, start, attach, continueRun, respond, stop, refreshRuns }`.

- [ ] **Step 1: The composable**

```ts
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * Subscribes to a server-owned run. It does not drive anything — the server
 * does. That is what lets a run outlive this tab.
 */
export function useWorkflowRun(slug: string) {
  const run = ref<WorkflowRun | null>(null)
  const runs = ref<WorkflowRun[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  let source: EventSource | null = null

  function listen(runId: string) {
    source?.close()
    source = new EventSource(`/api/runs/${runId}/stream`)
    source.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        if (payload.type === 'run') run.value = payload.run
        if (payload.type === 'done') { source?.close(); source = null; refreshRuns() }
      } catch { /* a malformed frame self-heals on the next one */ }
    }
    source.onerror = () => { source?.close(); source = null }
  }

  async function refreshRuns() {
    runs.value = await $fetch<WorkflowRun[]>(`/api/workflows/${slug}/runs`)
  }

  /** Attach to whatever is already running, if anything. Called on page load. */
  async function attach() {
    await refreshRuns()
    const active = runs.value.find(r => r.status === 'running' || r.status === 'paused')
    if (active) { run.value = active; listen(active.id) }
  }

  async function start(initialPrompt: string, projectDir?: string, autoRun = false) {
    loading.value = true
    error.value = null
    try {
      const started = await $fetch<WorkflowRun>(`/api/workflows/${slug}/runs`, {
        method: 'POST', body: { initialPrompt, projectDir, autoRun },
      })
      run.value = started
      listen(started.id)
      await refreshRuns()
    } catch (e: any) {
      // 409 means a run is already going; attaching to it is more useful than an error.
      if (e?.statusCode === 409 && e?.data?.data?.runId) {
        run.value = await $fetch<WorkflowRun>(`/api/runs/${e.data.data.runId}`)
        listen(run.value.id)
      } else {
        error.value = e?.data?.message || e?.message || 'Failed to start run'
      }
    } finally {
      loading.value = false
    }
  }

  const act = (path: string, body?: unknown) => async () => {
    if (!run.value) return
    run.value = await $fetch<WorkflowRun>(`/api/runs/${run.value.id}/${path}`, { method: 'POST', body })
  }

  onScopeDispose(() => source?.close())

  return {
    run, runs, loading, error, attach, start, refreshRuns,
    continueRun: act('continue'),
    respond: async (reply: string) => {
      if (!run.value) return
      run.value = await $fetch<WorkflowRun>(`/api/runs/${run.value.id}/respond`, { method: 'POST', body: { reply } })
    },
    stop: act('stop'),
  }
}
```

- [ ] **Step 2: The panel — per-agent rows are the point**

Create `app/components/WorkflowRunPanel.vue`:

```vue
<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'

const props = defineProps<{ run: WorkflowRun | null, runs: WorkflowRun[] }>()
const emit = defineEmits<{ continue: [], stop: [], attach: [id: string] }>()

const STATUS_COLOR: Record<string, string> = {
  running: 'var(--info, #3b82f6)',
  paused: 'var(--warning, #f59e0b)',
  completed: 'var(--success, #22c55e)',
  failed: 'var(--error, #ef4444)',
  stopped: 'var(--text-disabled, #9ca3af)',
  interrupted: 'var(--error, #ef4444)',
  pending: 'var(--text-disabled, #9ca3af)',
  skipped: 'var(--text-disabled, #9ca3af)',
}

const elapsed = (s: { startedAt?: number, completedAt?: number }) => {
  if (!s.startedAt) return ''
  const end = s.completedAt ?? Date.now()
  const secs = Math.round((end - s.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}
const expanded = ref<string | null>(null)
</script>

<template>
  <div v-if="run" class="border rounded-md p-4 space-y-3">
    <div class="flex items-center gap-3">
      <span class="text-[11px] font-mono uppercase" :style="{ color: STATUS_COLOR[run.status] }">
        {{ run.status }}
      </span>
      <span class="text-[12px] text-label">{{ run.workflowName }}</span>
      <span class="text-[11px] text-label ml-auto">{{ elapsed({ startedAt: run.startedAt, completedAt: run.endedAt }) }}</span>
    </div>

    <p v-if="run.status === 'interrupted'" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">
      The process that was running this is gone. Its steps are frozen where they stopped.
    </p>

    <!-- One row per agent. This is what the panel exists for. -->
    <div class="space-y-1">
      <div v-for="step in run.steps" :key="step.stepId" class="text-[12px]">
        <button class="w-full flex items-center gap-2 text-left py-1" @click="expanded = expanded === step.stepId ? null : step.stepId">
          <span class="w-2 h-2 rounded-full shrink-0" :style="{ background: STATUS_COLOR[step.status] }" />
          <span class="font-medium">{{ step.label }}</span>
          <span class="text-label font-mono text-[10px]">{{ step.agentSlug }}</span>
          <span v-if="step.visits > 1" class="text-[10px] text-label">×{{ step.visits }}</span>
          <span v-if="step.monitorVerdict" class="text-[10px] font-mono">{{ step.monitorVerdict }}</span>
          <span class="ml-auto text-[10px] text-label">{{ elapsed(step) }}</span>
        </button>
        <div v-if="expanded === step.stepId" class="pl-4 pb-2 space-y-1">
          <p v-if="step.error" class="text-[11px]" :style="{ color: STATUS_COLOR.failed }">{{ step.error }}</p>
          <pre v-if="step.output" class="text-[11px] whitespace-pre-wrap max-h-64 overflow-auto">{{ step.output }}</pre>
          <p v-else class="text-[11px] text-label">No output yet.</p>
        </div>
      </div>
    </div>

    <div class="flex gap-2">
      <UButton v-if="run.status === 'paused'" size="xs" label="Continue" @click="emit('continue')" />
      <UButton v-if="run.status === 'running' || run.status === 'paused'" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
    </div>
  </div>

  <div v-else-if="runs.length" class="space-y-1">
    <p class="text-[11px] text-label">Previous runs</p>
    <button v-for="r in runs.slice(0, 10)" :key="r.id" class="w-full flex items-center gap-2 text-[12px] py-1 text-left" @click="emit('attach', r.id)">
      <span class="w-2 h-2 rounded-full" :style="{ background: STATUS_COLOR[r.status] }" />
      <span>{{ new Date(r.startedAt).toLocaleString() }}</span>
      <span class="ml-auto text-[10px] font-mono text-label">{{ r.status }}</span>
    </button>
  </div>
</template>
```

- [ ] **Step 3: Wire the page and delete the old engine**

In `app/pages/workflows/[slug].vue`: replace the `useWorkflowExecution()` destructure (line 18) with `useWorkflowRun(slug)`, call `attach()` in `onMounted`, render `<WorkflowRunPanel>` where `<WorkflowExecutionLog>` was, and point `startRun` at the composable's `start`.

Then delete the old engine — two engines that can both run a workflow is how they drift:
```bash
git rm app/composables/useWorkflowExecution.ts
```
`WorkflowExecutionLog.vue` may be deleted too if nothing else imports it — check with `grep -rn "WorkflowExecutionLog" app/`.

- [ ] **Step 4: Typecheck and confirm nothing references the deleted composable**

```bash
grep -rn "useWorkflowExecution" app/ server/ shared/ || echo "clean"
node .superpowers/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: workflow page shows live per-agent status from server-owned runs"
```

---

### Task 7: End-to-end verification

**Files:** none — verification only, no commits.

- [ ] **Step 1: Every test**

```bash
node scripts/test-workflow-graph.mjs
node scripts/test-workflow-run-store.mjs
node scripts/test-workflow-runner.mjs
node scripts/test-agent-tool-policy.mjs
node scripts/test-workflow-templates.mjs
node .superpowers/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit
```
All pass; typecheck shows only the one known pre-existing error.

- [ ] **Step 2: The behaviour this feature exists for**

With `npx nuxt dev --port 3031`:
1. Start a run on a real workflow from the UI.
2. **Close the browser tab.**
3. Reopen `http://localhost:3031/workflows/<slug>`.

Expected: the run is still there, still advancing, with live per-agent rows. This is the acceptance test — if this fails, the feature does not work regardless of what the unit tests say.

- [ ] **Step 3: The 409 path**

Start a second run on the same workflow while one is active. Expected: the UI attaches to the existing run rather than erroring.

- [ ] **Step 4: Report**

State what passed, what did not, and anything verified by reading code rather than observing. Stop the dev server.
