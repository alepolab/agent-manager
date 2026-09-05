# Run Manager: Restart, Resume and Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workflow run be restarted from any settled step under the same run id, resumed after the server process died, and cloned into the Run modal, with a Runs page that lists every run and offers those actions.

**Architecture:** One new runner function, `rehydrate`, rebuilds the in-memory `Live` record from the persisted run and the workflow file, so the existing wave loop continues a run it has never seen. `restartRun` resets a step and its forward descendants and drives the run again; interrupted-run continue is `restartRun` on the steps that were executing. The client gets a `/runs` page, a Run button on workflow cards, and query-driven attach/clone/start in the existing builder.

**Tech Stack:** Nuxt 3, Vue 3, Nuxt UI 3, Nitro server routes, plain-node test scripts under `scripts/`, Docker Compose for the running instance.

**Spec:** `docs/superpowers/specs/2026-09-05-run-manager-restart-clone-design.md`

## Global Constraints

- Server code under `server/utils` imports siblings with the `.ts` extension so `node scripts/test-*.mjs` can load them without a bundler.
- No raw model string literals; nothing here touches models.
- Conventional Commits, imperative, under 72 chars, no attribution trailers (user rule).
- Don't reformat or reorganise untouched code.
- Every task ends with `node scripts/test-workflow-runner.mjs` green (server tasks) or `bun run typecheck` unchanged from its pre-existing single failure in `scripts/test-workflow-graph.mjs` (client tasks).
- The running instance is the docker compose container; the last task rebuilds it.

---

### Task 1: `rehydrate` and `restartRun` in the runner, with a test

**Files:**
- Modify: `server/utils/workflowRunner.ts` (imports at top; add after `stopRun`, line ~604)
- Modify: `server/utils/workflowRunStore.ts` (add `loadWorkflowSteps`)
- Test: `scripts/test-workflow-runner.mjs` (append case 9)

**Interfaces:**
- Produces: `export async function restartRun(runId: string, stepId: string): Promise<WorkflowRun>` — throws `RestartError` with `.statusCode` 404/400/409.
- Produces: `export class RestartError extends Error { statusCode: number; data?: Record<string, unknown> }`
- Produces (store): `export async function loadWorkflowSteps(slug: string): Promise<{ slug: string, name: string, steps: any[] } | null>` — reads `CLAUDE_DIR/workflows/<slug>.json`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-workflow-runner.mjs` before the final `rmSync` lines:

```js
// ── 9. restartRun re-runs a failed step and its descendants only ──────────
// The runner loads the workflow from disk to rehydrate, so write it there.
import { mkdirSync } from 'node:fs'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps }))

let explode = true
runner.setAgentCaller(async (agentSlug, input) => {
  calls.push(agentSlug)
  if (agentSlug === 'agent-b' && explode) throw new Error('agent-b exploded')
  return `output of ${agentSlug} <- ${input.slice(-40).replace(/\n/g, ' ')}`
})
calls.length = 0
let rst = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
rst = await runner.waitForSettled(rst.id, TIMEOUT)
assert.equal(rst.status, 'failed')
const aOutput = rst.steps.find(s => s.stepId === 'a').output

// A restart while nothing is live is the realistic case: simulate a server
// restart by forgetting the in-memory record before restarting.
runner._dropLive(rst.id)
explode = false
calls.length = 0
await assert.rejects(runner.restartRun(rst.id, 'nope'), /nope/, 'unknown step id is refused')
rst = await runner.restartRun(rst.id, 'b')
assert.equal(rst.status, 'running', 'restart drives the run immediately')
rst = await runner.waitForSettled(rst.id, TIMEOUT)
assert.equal(rst.status, 'completed', 'restart from b runs b and d to completion')
assert.deepEqual(calls.sort(), ['agent-b', 'agent-d'], 'only the failed step and its descendants re-run')
assert.equal(rst.steps.find(s => s.stepId === 'a').output, aOutput, 'a kept its output')
assert.equal(rst.steps.find(s => s.stepId === 'c').status, 'completed', 'c, not downstream of b, is untouched')
assert.equal(rst.steps.find(s => s.stepId === 'b').visits, 2, 'visits keep counting across a restart')
const stepFiles = readdirSync(join(process.env.AGENT_RUNS_DIR, rst.id, 'artifacts', 'steps'))
assert.ok(stepFiles.some(f => /step-02-.*-restart-1\.json$/.test(f)), 'the failed attempt is snapshotted before the restart')

// Refused while running.
runner.setAgentCaller(async (agentSlug) => { await new Promise(r => setTimeout(r, 300)); return `slow ${agentSlug}` })
let busy = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
await assert.rejects(runner.restartRun(busy.id, 'a'), /running/, 'restart refused while the run is running')
await runner.waitForSettled(busy.id, TIMEOUT)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL with `runner._dropLive is not a function` (or `restartRun is not a function`).

- [ ] **Step 3: Add `loadWorkflowSteps` to the store**

Append to `server/utils/workflowRunStore.ts`:

```ts
/** The workflow definition a run was started from, read from disk. The runner
 *  needs it to rebuild scheduling state for a run it has never seen in memory. */
export async function loadWorkflowSteps(slug: string): Promise<{ slug: string, name: string, steps: any[] } | null> {
  const path = resolveClaudePath('workflows', `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(await readFile(path, 'utf-8'))
    return { slug, name: data.name ?? slug, steps: data.steps ?? [] }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Implement `rehydrate`, `restartRun`, `RestartError` and the test hook**

In `server/utils/workflowRunner.ts`, extend the store import:

```ts
import { createRun, getRun, saveRun, loadWorkflowSteps } from './workflowRunStore.ts'
```

Append after `stopRun`:

```ts
export class RestartError extends Error {
  constructor(public statusCode: number, message: string, public data?: Record<string, unknown>) {
    super(message)
  }
}

/** Test seam: forget a run's in-memory record, as a server restart would. */
export function _dropLive(runId: string) { live.delete(runId) }

/**
 * Rebuilds the in-memory scheduling record from the persisted run. Completed
 * steps are re-marked in step order so the graph arms exactly what it would
 * have armed live; their outputs and inputs come back from the record. Anything
 * not completed stays pending and unarmed until a predecessor arms it.
 */
async function rehydrate(run: WorkflowRun): Promise<Live> {
  const existing = live.get(run.id)
  if (existing) return existing
  const workflow = await loadWorkflowSteps(run.workflowSlug)
  if (!workflow) {
    throw new RestartError(409, `Workflow "${run.workflowSlug}" no longer exists, so this run cannot be rebuilt`)
  }
  const graph = buildGraph(workflow.steps)
  const state = initRunState(graph)
  const l: Live = {
    workflow, graph, state, outputs: {}, lastInputs: {}, retryFeedback: {}, stopped: false, running: false,
  }
  for (const s of run.steps) {
    state.visits[s.stepId] = s.visits ?? 0
    if (s.status !== 'completed') continue
    markCompleted(graph, state, s.stepId)
    l.outputs[s.stepId] = s.output
    // Stored input carries the artifact header; computeInput's retry branch
    // rebuilds from lastInputs, so strip it the way executeNode keeps it.
    l.lastInputs[s.stepId] = s.input.replace(artifactHeader(runArtifactsDir(run.id)), '')
  }
  live.set(run.id, l)
  return l
}

function forwardDescendants(graph: WorkflowGraph, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const next of graph.succ[cur] ?? []) {
      if (graph.backEdges.has(`${cur}->${next}`) || seen.has(next)) continue
      seen.add(next); out.push(next); stack.push(next)
    }
  }
  return out
}

const RESTARTABLE: WorkflowRun['status'][] = ['failed', 'stopped', 'interrupted', 'completed']

/**
 * Re-runs `stepId` and everything downstream of it, keeping every other
 * step's output, under the same run id and artifacts directory. The previous
 * attempt of each reset step is snapshotted the way monitor retries are.
 */
export async function restartRun(runId: string, stepId: string): Promise<WorkflowRun> {
  const run = await getRun(runId)
  if (!run) throw new RestartError(404, 'Run not found')
  if (!run.steps.some(s => s.stepId === stepId)) throw new RestartError(400, `Unknown step "${stepId}"`)
  if (!RESTARTABLE.includes(run.status)) {
    throw new RestartError(409, `A ${run.status} run cannot be restarted; ${run.status === 'paused' ? 'continue it instead' : 'wait for it to settle'}`)
  }
  const { findActiveRun } = await import('./workflowRunStore.ts')
  const active = await findActiveRun(run.workflowSlug)
  if (active && active.id !== run.id) {
    throw new RestartError(409, 'This workflow already has a run in progress', { runId: active.id })
  }
  const l = await rehydrate(run)
  if (l.running) throw new RestartError(409, 'This run is already running')

  const reset = [stepId, ...forwardDescendants(l.graph, stepId)]
  for (const id of reset) {
    const rec = recOf(run, id)
    if (rec.status !== 'pending') {
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec), `restart-${rec.visits}`) } catch { /* best effort */ }
    }
    Object.assign(rec, {
      status: 'pending', output: '', error: undefined, startedAt: undefined, completedAt: undefined,
      monitorVerdict: undefined, monitorNote: undefined, model: undefined,
    })
    l.state.status[id] = 'pending'
    l.state.armed[id] = false
    delete l.state.triggeredBy[id]
    delete l.outputs[id]
    delete l.retryFeedback[id]
  }
  // Arm the restart point the way its predecessors would have: an entry arms
  // itself; otherwise every forward predecessor must still read completed.
  if (l.graph.entries.includes(stepId)) armNode(l.state, stepId)
  else if ((l.graph.forwardPreds[stepId] ?? []).every(p => l.state.status[p] === 'completed')) armNode(l.state, stepId)
  else throw new RestartError(409, `Step "${stepId}" has predecessors that did not complete; restart from one of those`)

  l.stopped = false
  l.running = true
  run.status = 'running'
  run.error = undefined
  run.endedAt = undefined
  run.pid = process.pid
  run.currentStepIds = []
  run.nextStepIds = [stepId]
  await publish(run)
  void driveToSettlement(l, run)
  return run
}
```

Also change `stopRun`'s unused-`l` guard: nothing to change. But `continueRun` must handle interrupted runs; that is Task 2.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/test-workflow-runner.mjs`
Expected: `workflowRunner: all assertions passed`

- [ ] **Step 6: Commit**

```bash
git add server/utils/workflowRunner.ts server/utils/workflowRunStore.ts scripts/test-workflow-runner.mjs
git commit -m "feat(runner): restart a run from a step under the same run id"
```

---

### Task 2: Continue an interrupted run

**Files:**
- Modify: `server/utils/workflowRunner.ts` (`continueRun`, line ~504)
- Test: `scripts/test-workflow-runner.mjs` (append case 10)

**Interfaces:**
- Consumes: `restartRun`, `_dropLive` from Task 1.
- Changes: `continueRun` now also resumes `interrupted` runs.

- [ ] **Step 1: Write the failing test**

Append before the final `rmSync` lines:

```js
// ── 10. continueRun resumes an interrupted run from the executing step ────
runner.setAgentCaller(async (agentSlug) => { calls.push(agentSlug); return `output of ${agentSlug}` })
calls.length = 0
let intr = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
intr = await runner.waitForSettled(intr.id, TIMEOUT)          // paused after a
// Fake a dead owner: rewrite the record with a pid that cannot exist and a
// step frozen as running, then forget the live record.
{
  const p = join(process.env.CLAUDE_DIR, 'workflow-runs', `${intr.id}.json`)
  const rec = JSON.parse(readFileSync(p, 'utf8'))
  rec.status = 'running'; rec.pid = 2 ** 22 + 7
  rec.currentStepIds = ['b']
  rec.steps.find(s => s.stepId === 'b').status = 'running'
  writeFileSync(p, JSON.stringify(rec))
  runner._dropLive(intr.id)
}
assert.equal((await store.getRun(intr.id)).status, 'interrupted', 'a dead pid reads as interrupted')
calls.length = 0
intr = await runner.continueRun(intr.id)
assert.equal(intr.status, 'running', 'continue on an interrupted run restarts it')
intr = await runner.waitForSettled(intr.id, TIMEOUT)
assert.ok(calls.includes('agent-b'), 'the step that was executing re-runs')
assert.ok(!calls.includes('agent-a'), 'completed steps do not re-run')
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL at `continue on an interrupted run restarts it` (status is `interrupted`).

- [ ] **Step 3: Implement**

Replace the start of `continueRun` in `server/utils/workflowRunner.ts`:

```ts
export async function continueRun(runId: string): Promise<WorkflowRun | null> {
  const l = live.get(runId)
  // A run whose owning process died has no live record. Its currentStepIds
  // name what was executing; restarting from those is the honest resume.
  if (!l) {
    const stored = await getRun(runId)
    if (stored?.status === 'interrupted') {
      const from = stored.currentStepIds[0]
        ?? stored.steps.find(s => s.status === 'running' || s.status === 'pending')?.stepId
      if (!from) return stored
      return restartRun(runId, from)
    }
    return stored
  }
  if (l.running) return getRun(runId)
```

Keep the rest of the function as is. `restartRun` refuses a running run and rehydrates from disk, so an interrupted run whose record says `running` is accepted because `getRun` already maps a dead pid to `interrupted` and `RESTARTABLE` includes it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/test-workflow-runner.mjs`
Expected: `workflowRunner: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add server/utils/workflowRunner.ts scripts/test-workflow-runner.mjs
git commit -m "feat(runner): resume an interrupted run from its executing step"
```

---

### Task 3: Endpoints `POST /api/runs/:id/restart` and `GET /api/runs`

**Files:**
- Create: `server/api/runs/[id]/restart.post.ts`
- Create: `server/api/runs/index.get.ts`

**Interfaces:**
- Consumes: `restartRun`, `RestartError` (Task 1); `listRuns` from the store.
- Produces: `POST /api/runs/:id/restart` body `{ stepId: string }` → `WorkflowRun`; `GET /api/runs` → `WorkflowRun[]` newest first.

- [ ] **Step 1: Create the restart route**

```ts
import { restartRun, RestartError } from '../../../utils/workflowRunner'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: string }>(event)
  if (!body?.stepId) throw createError({ statusCode: 400, message: 'stepId is required' })
  try {
    return await restartRun(id, body.stepId)
  } catch (err) {
    if (err instanceof RestartError) throw createError({ statusCode: err.statusCode, message: err.message, data: err.data })
    throw err
  }
})
```

- [ ] **Step 2: Create the list route**

```ts
import { listRuns } from '../../utils/workflowRunStore'
export default defineEventHandler(async () => listRuns())
```

- [ ] **Step 3: Verify against the running instance after rebuild**

This is verified in Task 8 with curl; nothing to run here beyond typecheck:
Run: `bun run typecheck 2>&1 | grep -E "error TS" | grep -v test-workflow-graph`
Expected: no lines.

- [ ] **Step 4: Commit**

```bash
git add server/api/runs/[id]/restart.post.ts server/api/runs/index.get.ts
git commit -m "feat(api): restart a run from a step and list all runs"
```

---

### Task 4: Composable and run panel actions

**Files:**
- Modify: `app/composables/useWorkflowRun.ts:64-77`
- Modify: `app/components/WorkflowRunPanel.vue`
- Create: `app/components/RunProgressBar.vue`

**Interfaces:**
- Produces: `useWorkflowRun` returns `restart: (stepId: string) => Promise<void>`.
- Produces: `WorkflowRunPanel` emits `restart: [stepId: string]`, `clone: []` in addition to the existing three.
- Produces: `RunProgressBar` props `{ steps: RunStep[] }`.

- [ ] **Step 1: Add `restart` to the composable**

In `app/composables/useWorkflowRun.ts`, change `act` so a body can be passed per call, and export `restart`:

```ts
  const act = (path: string) => async (body?: unknown) => {
    if (!run.value) return
    run.value = await $fetch<WorkflowRun>(`/api/runs/${run.value.id}/${path}`, { method: 'POST', body })
    listen(run.value.id)
  }
```

and in the returned object:

```ts
    continueRun: () => act('continue')(),
    restart: (stepId: string) => act('restart')({ stepId }),
```

`listen` is called after every action because a finished run has no open stream: without it, a restart's progress would never reach the page.

- [ ] **Step 2: Extract the progress bar**

Create `app/components/RunProgressBar.vue`:

```vue
<script setup lang="ts">
import type { RunStep } from '~~/shared/types/run'
defineProps<{ steps: RunStep[] }>()

export const STATUS_COLOR: Record<string, string> = {
  running: 'var(--info, #3b82f6)',
  paused: 'var(--warning, #f59e0b)',
  completed: 'var(--success, #22c55e)',
  failed: 'var(--error, #ef4444)',
  stopped: 'var(--text-disabled, #9ca3af)',
  interrupted: 'var(--error, #ef4444)',
  pending: 'var(--text-disabled, #9ca3af)',
  skipped: 'var(--text-disabled, #9ca3af)',
}
</script>

<template>
  <div class="flex gap-0.5" data-testid="run-progress-bar">
    <span
      v-for="step in steps"
      :key="`seg-${step.stepId}`"
      class="h-1 flex-1 rounded-sm"
      :style="{ background: STATUS_COLOR[step.status] }"
      :title="`${step.label}: ${step.status}`"
    />
  </div>
</template>
```

Vue `<script setup>` cannot `export const`; put `STATUS_COLOR` in `app/utils/runStatus.ts` instead:

```ts
export const RUN_STATUS_COLOR: Record<string, string> = { /* same map */ }
```

and import it in both components. Remove the duplicate map from `WorkflowRunPanel.vue` and replace its segment `<div>` with `<RunProgressBar :steps="run.steps" />`.

- [ ] **Step 3: Add the actions to the panel**

In `WorkflowRunPanel.vue`:

```ts
const emit = defineEmits<{ continue: [], stop: [], attach: [id: string], restart: [stepId: string], clone: [] }>()
const settledRun = computed(() => !!props.run && !['running', 'paused'].includes(props.run.status))
const stepSettled = (s: { status: string }) => ['completed', 'failed', 'skipped'].includes(s.status)
```

Inside each step row's expanded section, before the output `<pre>`:

```vue
<UButton
  v-if="settledRun && stepSettled(step)"
  size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Restart from here"
  @click.stop="emit('restart', step.stepId)"
/>
```

Replace the bottom button row:

```vue
<div class="flex gap-2">
  <UButton v-if="run.status === 'paused'" size="xs" label="Continue" @click="emit('continue')" />
  <UButton v-if="run.status === 'interrupted'" size="xs" label="Resume" icon="i-lucide-play" @click="emit('continue')" />
  <UButton v-if="run.status === 'running' || run.status === 'paused'" size="xs" variant="ghost" color="neutral" label="Stop" @click="emit('stop')" />
  <UButton v-if="settledRun" size="xs" variant="ghost" color="neutral" icon="i-lucide-copy" label="Clone run" @click="emit('clone')" />
</div>
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck 2>&1 | grep -E "error TS" | grep -v test-workflow-graph`
Expected: no lines.

- [ ] **Step 5: Commit**

```bash
git add app/composables/useWorkflowRun.ts app/components/WorkflowRunPanel.vue app/components/RunProgressBar.vue app/utils/runStatus.ts
git commit -m "feat(runs): restart, resume and clone actions in the run panel"
```

---

### Task 5: Builder handles `run`, `clone` and `start` queries; modal prefill

**Files:**
- Modify: `app/pages/workflows/[slug].vue` (onMounted ~47-60, template ~514-531)
- Modify: `app/components/WorkflowRunModal.vue`

**Interfaces:**
- Consumes: panel emits `restart`, `clone`; composable `restart`.
- Produces: `WorkflowRunModal` prop `initial?: { prompt: string, projectDir?: string, autoRun: boolean }`.

- [ ] **Step 1: Modal prefill**

In `WorkflowRunModal.vue` props and watcher:

```ts
const props = defineProps<{
  open: boolean
  initial?: { prompt: string, projectDir?: string, autoRun: boolean }
}>()

watch(() => props.open, (val) => {
  if (!val) return
  prompt.value = props.initial?.prompt ?? ''
  projectDir.value = props.initial?.projectDir ?? workingDir.value
  autoRun.value = props.initial?.autoRun ?? false
})
```

- [ ] **Step 2: Query handling in the builder**

In `app/pages/workflows/[slug].vue` script, after `const { run, runs, attach, start, continueRun, stop } = useWorkflowRun(slug)` add `restart` to the destructure and:

```ts
const route = useRoute()
const runInitial = ref<{ prompt: string, projectDir?: string, autoRun: boolean } | undefined>()

/** One-shot query intents from the Runs page and workflow cards. Consumed
 *  then removed from the URL so a reload does not repeat them. */
async function applyQueryIntent() {
  const q = route.query
  if (typeof q.run === 'string') {
    await attach()
    const found = runs.value.find(r => r.id === q.run)
    if (found) run.value = found
  }
  if (typeof q.clone === 'string') {
    await attach()
    const src = runs.value.find(r => r.id === q.clone)
    runInitial.value = src ? { prompt: src.initialPrompt, projectDir: src.projectDir, autoRun: src.autoRun } : undefined
    showRunModal.value = true
  }
  if (q.start === '1') { runInitial.value = undefined; showRunModal.value = true }
  if (q.run || q.clone || q.start) router.replace({ path: route.path })
}
```

Replace the trailing `attach()` in `onMounted` with `await applyQueryIntent(); if (!route.query.run && !route.query.clone) attach()` — simpler: call `attach()` first, then `await applyQueryIntent()`. Since `attach()` picks the newest active run and `applyQueryIntent` overrides `run.value` when `?run=` names one, order them `await attach(); await applyQueryIntent()` and drop the inner `attach()` calls from `applyQueryIntent`.

`attach()` sets `run.value` only for running or paused runs, so `?run=<finished id>` correctly shows the finished run and its Restart actions.

Wire the panel:

```vue
<WorkflowRunPanel
  :run="run" :runs="runs"
  @continue="continueRun" @stop="stop" @attach="attachRun"
  @restart="restart"
  @clone="run && (runInitial = { prompt: run.initialPrompt, projectDir: run.projectDir, autoRun: run.autoRun }, showRunModal = true)"
/>
<WorkflowRunModal :open="showRunModal" :initial="runInitial" @update:open="showRunModal = $event" @start="startRun" />
```

Also `canRun` must allow starting a new run when the attached run is finished; it already does (only running/paused block it).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck 2>&1 | grep -E "error TS" | grep -v test-workflow-graph`
Expected: no lines.

- [ ] **Step 4: Commit**

```bash
git add app/pages/workflows/[slug].vue app/components/WorkflowRunModal.vue
git commit -m "feat(builder): open a run, clone a run or start from the URL"
```

---

### Task 6: Run button on workflow cards

**Files:**
- Modify: `app/components/WorkflowCard.vue`

- [ ] **Step 1: Add the button**

The card is a `NuxtLink`; a nested link is invalid HTML, so use a button that navigates. In the footer row, after the step count:

```vue
<UButton
  size="xs" variant="soft" icon="i-lucide-play" label="Run"
  class="ml-auto"
  :disabled="workflow.steps.length === 0"
  :title="workflow.steps.length === 0 ? 'Add a step before running' : 'Run this workflow'"
  @click.prevent.stop="navigateTo(`/workflows/${workflow.slug}?start=1`)"
/>
```

Move the existing `lastRunAt` span's `ml-auto` to `ml-2` so both fit.

- [ ] **Step 2: Typecheck and commit**

Run: `bun run typecheck 2>&1 | grep -E "error TS" | grep -v test-workflow-graph` → no lines.

```bash
git add app/components/WorkflowCard.vue
git commit -m "feat(workflows): run action on workflow cards"
```

---

### Task 7: Runs page and sidebar entry

**Files:**
- Create: `app/pages/runs.vue`
- Modify: `app/app.vue:111-120` (navTop)

**Interfaces:**
- Consumes: `GET /api/runs`, `POST /api/runs/:id/restart`, `POST /api/runs/:id/stop`, `RunProgressBar`, `RUN_STATUS_COLOR`.

- [ ] **Step 1: Sidebar entry**

In `app/app.vue` `navTop`, after Workflows:

```ts
  { label: 'Runs', icon: 'i-lucide-play-circle', to: '/runs' },
```

- [ ] **Step 2: The page**

```vue
<script setup lang="ts">
import type { WorkflowRun } from '~~/shared/types/run'
import { RUN_STATUS_COLOR } from '~/utils/runStatus'

const runs = ref<WorkflowRun[]>([])
const filter = ref('')
const status = ref<string>('')
const busy = ref<string | null>(null)
const toast = useToast()

async function refresh() { runs.value = await $fetch<WorkflowRun[]>('/api/runs') }
onMounted(refresh)
// Poll only while something can change; a static list must not hammer the server.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { if (runs.value.some(r => r.status === 'running' || r.status === 'paused')) refresh() }, 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const STATUSES = ['running', 'paused', 'completed', 'failed', 'stopped', 'interrupted']
const shown = computed(() => runs.value.filter(r =>
  (!filter.value || r.workflowName.toLowerCase().includes(filter.value.toLowerCase()))
  && (!status.value || r.status === status.value)))

const duration = (r: WorkflowRun) => {
  const secs = Math.round(((r.endedAt ?? Date.now()) - r.startedAt) / 1000)
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
}
/** The step a one-click restart resumes from: the failed one, or what was executing. */
const restartPoint = (r: WorkflowRun) =>
  r.steps.find(s => s.status === 'failed')?.stepId ?? r.currentStepIds[0] ?? r.steps.find(s => s.status !== 'completed')?.stepId
const canRestart = (r: WorkflowRun) => ['failed', 'stopped', 'interrupted'].includes(r.status) && !!restartPoint(r)
const canStop = (r: WorkflowRun) => r.status === 'running' || r.status === 'paused'

async function act(r: WorkflowRun, path: 'restart' | 'stop', body?: unknown) {
  busy.value = r.id
  try {
    await $fetch(`/api/runs/${r.id}/${path}`, { method: 'POST', body })
    await refresh()
    if (path === 'restart') navigateTo(`/workflows/${r.workflowSlug}?run=${r.id}`)
  } catch (e: any) {
    toast.add({ title: `Failed to ${path}`, description: e.data?.message || e.message, color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div>
    <PageHeader title="Runs">
      <template #trailing><span class="text-[12px] text-meta">{{ runs.length }}</span></template>
    </PageHeader>
    <div class="px-6 py-4 space-y-4">
      <div class="flex gap-2 items-center">
        <input v-model="filter" placeholder="Filter by workflow..." class="field-search max-w-xs" />
        <select v-model="status" class="field-input w-40">
          <option value="">All statuses</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>

      <p v-if="!runs.length" class="text-[13px] text-label">No runs yet. Start one from a workflow card.</p>

      <div v-else class="overflow-x-auto rounded-xl" style="border: 1px solid var(--border-subtle);">
        <table class="w-full text-[12px]">
          <thead>
            <tr class="text-left text-label" style="background: var(--surface-raised);">
              <th class="px-3 py-2 font-medium">Workflow</th>
              <th class="px-3 py-2 font-medium">Status</th>
              <th class="px-3 py-2 font-medium">Started</th>
              <th class="px-3 py-2 font-medium">Duration</th>
              <th class="px-3 py-2 font-medium w-48">Steps</th>
              <th class="px-3 py-2 font-medium">Prompt</th>
              <th class="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="r.id" style="border-top: 1px solid var(--border-subtle);">
              <td class="px-3 py-2 font-medium">{{ r.workflowName }}</td>
              <td class="px-3 py-2 font-mono uppercase text-[11px]" :style="{ color: RUN_STATUS_COLOR[r.status] }">{{ r.status }}</td>
              <td class="px-3 py-2 text-label whitespace-nowrap">{{ new Date(r.startedAt).toLocaleString() }}</td>
              <td class="px-3 py-2 text-label">{{ duration(r) }}</td>
              <td class="px-3 py-2"><RunProgressBar :steps="r.steps" /></td>
              <td class="px-3 py-2 text-label truncate max-w-xs" :title="r.initialPrompt">{{ r.initialPrompt }}</td>
              <td class="px-3 py-2">
                <div class="flex gap-1 justify-end">
                  <UButton size="xs" variant="ghost" label="Open" :to="`/workflows/${r.workflowSlug}?run=${r.id}`" />
                  <UButton v-if="canRestart(r)" size="xs" variant="soft" icon="i-lucide-rotate-ccw" label="Restart" :loading="busy === r.id" @click="act(r, 'restart', { stepId: restartPoint(r) })" />
                  <UButton size="xs" variant="ghost" icon="i-lucide-copy" label="Clone" :to="`/workflows/${r.workflowSlug}?clone=${r.id}`" />
                  <UButton v-if="canStop(r)" size="xs" variant="ghost" color="neutral" label="Stop" :loading="busy === r.id" @click="act(r, 'stop')" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Typecheck and commit**

Run: `bun run typecheck 2>&1 | grep -E "error TS" | grep -v test-workflow-graph` → no lines.

```bash
git add app/pages/runs.vue app/app.vue
git commit -m "feat(runs): runs page with open, restart, clone and stop"
```

---

### Task 8: Rebuild the local stack and verify live

**Files:** none new.

- [ ] **Step 1: Rebuild**

Run: `docker compose up -d --build 2>&1 | tail -3 && sleep 8 && curl -sf http://localhost:3030/api/health`
Expected: container Started, `{"status":"ok"}`.

- [ ] **Step 2: API smoke**

```bash
curl -s http://localhost:3030/api/runs | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d),'runs');print([ (r['id'][:8],r['status']) for r in d[:3]])"
curl -s -X POST http://localhost:3030/api/runs/does-not-exist/restart -H 'content-type: application/json' -d '{"stepId":"x"}' -w '\n%{http_code}\n'
```
Expected: a count and the three newest runs; then a 404 body and `404`.

- [ ] **Step 3: Live UI, with agent-browser**

1. Open `http://localhost:3030/runs`, screenshot. Expect the table with run bdf4a656 as `failed` and a Restart button.
2. Click Restart on bdf4a656. Expect navigation to the builder with that run attached and the PR step `running`. Screenshot.
3. Wait for settlement (`~/.claude/workflow-runs/bdf4a656-….json` status leaves `running`). Report the PR step's outcome; if it opened a PR, record branch and URL.
4. Open `/workflows`, screenshot, click Run on the Runbook A card; expect the builder with the modal open. Cancel.
5. Open `/runs`, click Clone on bdf4a656; expect the modal prefilled with `SCN-402`. Screenshot. Cancel.
6. Check the browser console for errors on each page.

- [ ] **Step 4: Report**

State what ran, what was screenshotted, and the PR step result. Commit nothing further unless the live pass required a fix; if it did, commit that fix on its own.
