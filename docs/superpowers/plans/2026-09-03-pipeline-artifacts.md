# Pipeline Artifacts and Halt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Runbook A run produce a run directory the existing evidence-bundle assembler accepts — or fail loudly at the step where the evidence went missing.

**Architecture:** Four changes to the server-side runner and the Runbook A template: a step may opt into receiving its full ancestry rather than only its immediate predecessors; every run gets an artifacts directory the runner itself populates and the agents write into; a step may halt the run with a structured marker; and the load-bearing steps get a monitor. An acceptance test drives a stubbed full run through the real assembler and the real validator.

**Tech Stack:** TypeScript (Nuxt 3 / Nitro server utils), Node 24 test scripts using `node:assert/strict`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-pipeline-artifacts-design.md`

## Global Constraints

- **No new dependencies.** Not in `server/`, not in `engineering/`.
- **Server-side imports carry explicit `.ts` extensions** (`import { x } from './claudeDir.ts'`). The test scripts import these modules directly under Node's native type stripping and cannot resolve extensionless paths. `~~/shared/...` aliases work only for *type-only* imports.
- **Existing suites must stay green after every task:**
  ```bash
  node scripts/test-workflow-graph.mjs
  node scripts/test-workflow-runner.mjs
  node scripts/test-workflow-run-store.mjs
  node scripts/test-workflow-templates.mjs
  node scripts/test-agent-system-prompt.mjs
  node scripts/test-agent-tool-policy.mjs
  node scripts/test-agent-caller-wiring.mjs
  node scripts/test-watch-scheduler.mjs
  node scripts/test-watch-state-store.mjs
  node scripts/test-ticket-source.mjs
  ```
  Plus, for Task 5, `node engineering/scripts/test-assemble-bundle.mjs` and `node engineering/scripts/test-validate-bundle.mjs`.
- **Do not touch `server/utils/watchConfig.ts`, `server/plugins/watcher.ts`, or `app/pages/watches.vue`** — another change is in flight there.
- **`npm run typecheck` is broken in this repo** (npx pairs vue-tsc 3.3.11 with typescript 7.0.2, which dropped `./lib/tsc`). Use the pinned copy:
  ```bash
  node .superpowers/sdd/*/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit
  ```
  One pre-existing error is the known baseline and is **not** yours to fix:
  `scripts/test-workflow-graph.mjs(54,1): error TS1005: '=>' expected.`
- **Never fabricate evidence.** Anywhere this plan says a field or file may be missing, the correct behaviour is to leave it absent and let validation reject the bundle. A default that makes a bundle validate is worse than no bundle.
- Default behaviour for every existing workflow must be unchanged. `contextMode` defaults to `'predecessors'`; a workflow with no artifacts directory configured still runs.

## File Structure

| File | Responsibility |
|---|---|
| `shared/utils/workflowGraph.ts` (modify) | Add `ancestorsOf()` and `parseHalt()` — pure graph/text functions, no I/O, importable from both browser and server |
| `app/types/index.ts` (modify) | Add `contextMode` to `WorkflowStep` |
| `server/utils/runArtifacts.ts` (create) | Everything that writes into a run's artifacts directory. The only module in this change that touches the filesystem |
| `server/utils/workflowRunner.ts` (modify) | Call the three new pieces: ancestry in `computeInput`, artifact writes around `executeNode`, halt detection after the agent returns |
| `app/utils/workflowTemplates.ts` (modify) | Carry `monitorSlug` / `maxVisits` / `contextMode` through materialization; Runbook A declares them |
| `app/utils/templates.ts` (modify) | The seven `sdlc-*` agent bodies gain artifact, determinism and halt instructions; one new monitor agent template |
| `scripts/test-run-artifacts.mjs` (create) | Task 2's suite |
| `scripts/test-runbook-a-acceptance.mjs` (create) | Task 5: stubbed full run through the real assembler and validator |

---

### Task 1: Ancestor context mode

**Files:**
- Modify: `shared/utils/workflowGraph.ts` (add `ancestorsOf`)
- Modify: `app/types/index.ts` (`WorkflowStep.contextMode`)
- Modify: `server/utils/workflowRunner.ts` (`computeInput`, `WorkflowLike`)
- Test: `scripts/test-workflow-graph.mjs`, `scripts/test-workflow-runner.mjs`

**Interfaces:**
- Produces: `ancestorsOf(graph: WorkflowGraph, id: string): string[]` — every transitive forward-ancestor of `id`, nearest-first, no duplicates, terminating on cyclic graphs.
- Produces: `WorkflowStep.contextMode?: 'predecessors' | 'ancestors'`, read by `computeInput`.
- Consumes: the existing `WorkflowGraph.forwardPreds` (back-edges are already excluded from it, which is why ancestry over it terminates).

- [ ] **Step 1: Write the failing graph test**

Append to `scripts/test-workflow-graph.mjs`, before its final success line:

```js
// ancestorsOf: the full transitive forward ancestry
{
  const g = buildGraph([
    { id: 'a', agentSlug: 'x', label: 'A', next: ['b'] },
    { id: 'b', agentSlug: 'x', label: 'B', next: ['c'] },
    { id: 'c', agentSlug: 'x', label: 'C', next: ['d'] },
    { id: 'd', agentSlug: 'x', label: 'D', next: [] },
  ])
  assert.deepEqual(ancestorsOf(g, 'd'), ['c', 'b', 'a'],
    'nearest-first: d sees c, then b, then a')
  assert.deepEqual(ancestorsOf(g, 'a'), [], 'an entry node has no ancestors')

  // A diamond must not report the shared root twice.
  const diamond = buildGraph([
    { id: 'r', agentSlug: 'x', label: 'R', next: ['l', 'm'] },
    { id: 'l', agentSlug: 'x', label: 'L', next: ['j'] },
    { id: 'm', agentSlug: 'x', label: 'M', next: ['j'] },
    { id: 'j', agentSlug: 'x', label: 'J', next: [] },
  ])
  const anc = ancestorsOf(diamond, 'j')
  assert.equal(anc.filter(i => i === 'r').length, 1, 'diamond root appears once')
  assert.deepEqual([...anc].sort(), ['l', 'm', 'r'])

  // A cycle must terminate. buildGraph classifies the closing edge as a
  // back-edge and keeps it out of forwardPreds, so this is really a check
  // that ancestorsOf relies on forwardPreds and nothing else.
  const cyclic = buildGraph([
    { id: 'p', agentSlug: 'x', label: 'P', next: ['q'] },
    { id: 'q', agentSlug: 'x', label: 'Q', next: ['p'] },
  ])
  assert.deepEqual(ancestorsOf(cyclic, 'q'), ['p'], 'cycle terminates')
}
```

Add `ancestorsOf` to that file's existing import from `../shared/utils/workflowGraph.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
node scripts/test-workflow-graph.mjs
```
Expected: a `SyntaxError` or `ReferenceError` naming `ancestorsOf`.

- [ ] **Step 3: Implement `ancestorsOf`**

Add to `shared/utils/workflowGraph.ts`, next to the other graph helpers:

```ts
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
```

- [ ] **Step 4: Run the graph test until it passes**

```bash
node scripts/test-workflow-graph.mjs
```

- [ ] **Step 5: Write the failing runner test**

Append to `scripts/test-workflow-runner.mjs`, before its cleanup line:

```js
// contextMode 'ancestors' reaches past the immediate predecessors.
// This is THE regression guard for the defect this change exists to fix: the
// evidence step could not see the pre-fix FAIL output, because that output
// belonged to a step three hops upstream.
{
  const chain = {
    slug: 'chain', name: 'Chain',
    steps: [
      { id: 's1', agentSlug: 'a1', label: 'One', next: ['s2'] },
      { id: 's2', agentSlug: 'a2', label: 'Two', next: ['s3'] },
      { id: 's3', agentSlug: 'a3', label: 'Three', next: ['s4'] },
      { id: 's4', agentSlug: 'a4', label: 'Four', next: [], contextMode: 'ancestors' },
    ],
  }
  runner.setAgentCaller(async agentSlug => `OUTPUT-OF-${agentSlug}`)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const s4 = r.steps.find(s => s.stepId === 's4').input
  assert.ok(s4.includes('OUTPUT-OF-a1'), 'ancestors mode reaches the far ancestor')
  assert.ok(s4.includes('OUTPUT-OF-a3'), 'ancestors mode still includes the direct predecessor')

  // And the default is unchanged.
  const plain = { ...chain, slug: 'plain', steps: chain.steps.map(s => ({ ...s, contextMode: undefined })) }
  const r2 = await runner.waitForSettled(
    (await runner.startRun({ workflow: plain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const p4 = r2.steps.find(s => s.stepId === 's4').input
  assert.ok(!p4.includes('OUTPUT-OF-a1'), 'default mode does NOT reach the far ancestor')
  assert.ok(p4.includes('OUTPUT-OF-a3'), 'default mode includes the direct predecessor')
}

// The join is capped, and the cap never drops a whole ancestor.
{
  const big = 'X'.repeat(200000)
  const chain = {
    slug: 'big', name: 'Big',
    steps: [
      { id: 'b1', agentSlug: 'big-1', label: 'One', next: ['b2'] },
      { id: 'b2', agentSlug: 'big-2', label: 'Two', next: ['b3'] },
      { id: 'b3', agentSlug: 'big-3', label: 'Three', next: [], contextMode: 'ancestors' },
    ],
  }
  runner.setAgentCaller(async agentSlug => `MARKER-${agentSlug}\n${big}`)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const input = r.steps.find(s => s.stepId === 'b3').input
  assert.ok(input.length < 200000, 'joined context is capped')
  assert.ok(input.includes('[truncated'), 'truncation is marked, never silent')
  // Every ancestor still contributes. Budget is shared evenly rather than
  // spent first-come, so a long early step cannot squeeze a later one out —
  // and the marker text an agent must find is at the START of its output.
  assert.ok(input.includes('MARKER-big-1'), 'the far ancestor is still present')
  assert.ok(input.includes('MARKER-big-2'), 'the near ancestor is still present')
}
```

- [ ] **Step 6: Run it and watch it fail**

```bash
node scripts/test-workflow-runner.mjs
```
Expected: the first assertion fails — `s4`'s input contains only `OUTPUT-OF-a3`.

- [ ] **Step 7: Implement in the runner**

In `server/utils/workflowRunner.ts`, add `ancestorsOf` to the import from `'../../shared/utils/workflowGraph.ts'`, add `contextMode?: 'predecessors' | 'ancestors'` to the step shape inside `interface WorkflowLike`, and add above `computeInput`:

```ts
/** Total characters of upstream output a single step's input may carry.
 *  Sized so a seven-step Runbook A run stays well inside a 200k-token
 *  context after the agent's own system prompt and skills. */
const MAX_JOINED_CONTEXT = 60000

/**
 * Joins upstream outputs under a fixed total budget, shared EVENLY across
 * parts rather than first-come. Even sharing is the point: with a first-come
 * budget a verbose early step could consume the whole allowance and push the
 * pre-fix FAIL output out entirely — silently reintroducing the exact defect
 * `contextMode: 'ancestors'` exists to fix. Truncation is always marked.
 */
function joinBudgeted(parts: { label: string, text: string }[]): string {
  if (!parts.length) return ''
  const share = Math.floor(MAX_JOINED_CONTEXT / parts.length)
  const clipped = parts.map((p) => {
    if (p.text.length <= share) return p
    const dropped = p.text.length - share
    return { label: p.label, text: `${p.text.slice(0, share)}\n\n[truncated ${dropped} characters]` }
  })
  return joinInputs(clipped)
}
```

and replace the tail of `computeInput`:

```ts
  const step = stepOf(l, id)
  // ancestorsOf returns nearest-first; reverse so the join reads
  // oldest-to-newest, the order a person reads a pipeline in.
  const preds = step?.contextMode === 'ancestors'
    ? ancestorsOf(l.graph, id).reverse()
    : (l.graph.forwardPreds[id] ?? [])
  if (!preds.length) return initialPrompt
  return joinBudgeted(preds.map(p => ({ label: recOf(run, p).label, text: l.outputs[p] ?? '' })))
```

- [ ] **Step 8: Add `contextMode` to the public type**

In `app/types/index.ts`, inside `WorkflowStep`:

```ts
  /**
   * Which upstream outputs this step receives. `'predecessors'` (the default)
   * passes only immediate forward predecessors; `'ancestors'` passes the full
   * transitive ancestry, budgeted and truncation-marked. Use `'ancestors'`
   * for a step that must see evidence produced several hops upstream.
   */
  contextMode?: 'predecessors' | 'ancestors'
```

- [ ] **Step 9: Run both suites plus typecheck**

```bash
node scripts/test-workflow-graph.mjs && node scripts/test-workflow-runner.mjs
node .superpowers/sdd/*/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add shared/utils/workflowGraph.ts app/types/index.ts server/utils/workflowRunner.ts scripts/test-workflow-graph.mjs scripts/test-workflow-runner.mjs
git commit -m "feat: contextMode 'ancestors' so a step can see its full upstream evidence"
```

---

### Task 2: The run artifacts directory

**Files:**
- Create: `server/utils/runArtifacts.ts`
- Modify: `server/utils/workflowRunner.ts`
- Test: `scripts/test-run-artifacts.mjs`

**Interfaces:**
- Consumes: `claudeDir()` from `./claudeDir.ts`; `WorkflowRun` / `RunStep` from `~~/shared/types/run` (type-only).
- Produces:
  - `runArtifactsDir(runId: string): string` — `<CLAUDE_DIR>/workflow-runs/<runId>/artifacts`
  - `initRunArtifacts(run: WorkflowRun, workflowName: string): Promise<void>`
  - `writeStepArtifact(run: WorkflowRun, rec: RunStep, index: number): Promise<void>`
  - `finalizeRunArtifacts(run: WorkflowRun): Promise<void>`
  - `artifactHeader(dir: string): string` — the block prepended to every step input

**Design decision to implement exactly as written — who owns `meta.json`:**

The assembler's `meta.json` needs fields no runner can know (ticket, product, blast radius, the repos changed). It also needs fields no agent should be trusted to self-report (which model ran, how long it took, how many attempts). So:

1. `initRunArtifacts` **seeds** `meta.json` with only the runner-owned keys.
2. Agents merge their own keys into the same file during the run.
3. `finalizeRunArtifacts` **re-asserts the runner-owned keys over whatever is there**, so an agent cannot overstate them.

Runner-owned keys: `identity` (the run's workflow slug), `model`, `cost.wall_clock_min`, `cost.attempts`. Everything else belongs to the agents. `cost.input_tokens` and `cost.output_tokens` stay `0` — the runner does not currently observe token counts, and a fabricated number is worse than an honest zero. Note that in your report.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-run-artifacts.mjs`:

```js
/**
 * Self-check for the run artifacts directory. Everything here is filesystem
 * behaviour under a temp CLAUDE_DIR — no agent calls.
 *
 *   node scripts/test-run-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'artifacts-'))
const A = await import('../server/utils/runArtifacts.ts')

const run = {
  id: 'run-1', workflowSlug: 'runbook-a', status: 'running',
  initialPrompt: 'fix SA-1', startedAt: Date.now(), currentStepIds: [], nextStepIds: [],
  steps: [{ stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake', status: 'pending' }],
}

// 1. init creates the directory and a meta.json holding only runner-owned keys
await A.initRunArtifacts(run, 'Runbook A')
const dir = A.runArtifactsDir(run.id)
assert.ok(existsSync(dir), 'artifacts directory is created')
const seeded = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(seeded.identity, 'runbook-a')
assert.ok('model' in seeded, 'model is seeded')
assert.equal(seeded.cost.input_tokens, 0,
  'token counts stay 0 — the runner does not observe them and must not invent them')
assert.ok(!('ticket' in seeded), 'the runner does not claim agent-owned fields')

// 2. a step artifact records the runner's own account of the step
const rec = {
  stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake',
  status: 'completed', input: 'IN', output: 'OUT', startedAt: 1000, completedAt: 4000,
}
await A.writeStepArtifact(run, rec, 0)
const stepFile = join(dir, 'steps', 'step-01-ticket-intake.json')
assert.ok(existsSync(stepFile), `step artifact written at ${stepFile}`)
const step = JSON.parse(readFileSync(stepFile, 'utf8'))
assert.equal(step.output, 'OUT')
assert.equal(step.agentSlug, 'sdlc-ticket-intake')
assert.equal(step.status, 'completed')

// 3. an agent's merged keys survive finalize; the runner's keys win over them
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
  ticket: 'SA-1203', product: 'ocs_cpp14',
  identity: 'i-promoted-myself',
  cost: { input_tokens: 999999, output_tokens: 999999, attempts: 1, wall_clock_min: 0 },
}))
run.endedAt = run.startedAt + 120000
await A.finalizeRunArtifacts(run)
const final = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(final.ticket, 'SA-1203', 'agent-owned keys survive')
assert.equal(final.identity, 'runbook-a', 'runner-owned keys are re-asserted over the agent')
assert.equal(final.cost.input_tokens, 0, 'a self-reported token count is overwritten, not trusted')
assert.equal(final.cost.wall_clock_min, 2, 'wall clock comes from the runner clock')

// 4. malformed meta.json from an agent must not lose the runner's facts
writeFileSync(join(dir, 'meta.json'), '{ this is not json')
await A.finalizeRunArtifacts(run)
const recovered = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(recovered.identity, 'runbook-a', 'unparseable meta.json is rebuilt from runner facts')

// 5. the header names the directory
const header = A.artifactHeader(dir)
assert.ok(header.includes(dir), 'the header carries the real path')

// 6. a slug with path separators cannot escape the directory
await A.writeStepArtifact(run, { ...rec, agentSlug: '../../etc/passwd' }, 1)
const names = readdirSync(join(dir, 'steps'))
assert.ok(names.every(n => !n.includes('/') && !n.includes('..')),
  'agent slugs are sanitised into the filename, never traversed')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('run artifacts: all checks passed')
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node scripts/test-run-artifacts.mjs
```
Expected: `ERR_MODULE_NOT_FOUND` for `runArtifacts.ts`.

- [ ] **Step 3: Implement `server/utils/runArtifacts.ts`**

```ts
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeDir } from './claudeDir.ts'
import { DEFAULT_MODEL_ALIAS } from './models.ts'
import type { WorkflowRun, RunStep } from '~~/shared/types/run'

/** Where a run's evidence lives. The assembler's --run-dir points here. */
export function runArtifactsDir(runId: string): string {
  return join(claudeDir(), 'workflow-runs', runId, 'artifacts')
}

/** Filenames come from agent slugs, which are user data. Keep them inert. */
const safe = (s: string) =>
  s.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 60) || 'step'

/** Keys the RUNNER owns. An agent may write them; finalize overwrites them.
 *  Split out so there is exactly one list, used by both seed and finalize. */
function runnerOwned(run: WorkflowRun) {
  const ended = run.endedAt ?? Date.now()
  return {
    identity: run.workflowSlug,
    model: DEFAULT_MODEL_ALIAS,
    cost: {
      // The runner does not observe token usage. Zero is honest; a plausible
      // number would be a fabricated field in an evidence bundle.
      input_tokens: 0,
      output_tokens: 0,
      attempts: Math.max(1, ...run.steps.map(s => s.visits ?? 1)),
      wall_clock_min: Math.round((ended - run.startedAt) / 60000),
    },
  }
}

export async function initRunArtifacts(run: WorkflowRun, workflowName: string): Promise<void> {
  const dir = runArtifactsDir(run.id)
  await mkdir(join(dir, 'steps'), { recursive: true })
  await writeFile(join(dir, 'meta.json'),
    JSON.stringify({ ...runnerOwned(run), workflow: workflowName }, null, 2))
}

export async function writeStepArtifact(run: WorkflowRun, rec: RunStep, index: number): Promise<void> {
  const dir = join(runArtifactsDir(run.id), 'steps')
  await mkdir(dir, { recursive: true })
  const n = String(index + 1).padStart(2, '0')
  const name = `step-${n}-${safe(rec.agentSlug.replace(/^sdlc-/, ''))}.json`
  await writeFile(join(dir, name), JSON.stringify({
    stepId: rec.stepId,
    agentSlug: rec.agentSlug,
    label: rec.label,
    status: rec.status,
    error: rec.error ?? null,
    monitorVerdict: rec.monitorVerdict ?? null,
    startedAt: rec.startedAt ?? null,
    completedAt: rec.completedAt ?? null,
    input: rec.input ?? '',
    output: rec.output ?? '',
  }, null, 2))
}

/**
 * Re-assert the runner's facts over whatever the agents merged in, and
 * survive a meta.json an agent corrupted: the runner's own record is the
 * floor this whole design rests on, so it must not be lost to a bad write.
 */
export async function finalizeRunArtifacts(run: WorkflowRun): Promise<void> {
  const dir = runArtifactsDir(run.id)
  const path = join(dir, 'meta.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
  } catch {
    /* absent or unparseable: rebuild from runner facts alone */
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify({ ...existing, ...runnerOwned(run) }, null, 2))
}

/** Prepended to every step's input. The only channel an agent has for
 *  learning where to write, so it must be unmissable and literal. */
export function artifactHeader(dir: string): string {
  return [
    '## Run artifacts directory',
    '',
    `Write every artifact you produce into: ${dir}`,
    '',
    'This directory is the run\'s evidence. A file you do not write is evidence',
    'that does not exist — do not describe an artifact in prose instead of',
    'writing it, and never write a placeholder in place of a real result.',
    '',
    '---',
    '',
  ].join('\n')
}
```

If `DEFAULT_MODEL_ALIAS` is not exported from `server/utils/models.ts` under that name, read the file and use the one that is — do not inline a model string literal, per the repo's model-registry rule in `CLAUDE.md`.

- [ ] **Step 4: Run the test until it passes**

```bash
node scripts/test-run-artifacts.mjs
```

- [ ] **Step 5: Wire it into the runner**

In `server/utils/workflowRunner.ts`:

```ts
import {
  runArtifactsDir, initRunArtifacts, writeStepArtifact, finalizeRunArtifacts, artifactHeader,
} from './runArtifacts.ts'
```

In `startRun`, after the run record is created and before the wave loop begins:

```ts
  // Best-effort: a filesystem problem here must not stop the run. The run
  // still executes; what it loses is its evidence, and the assembler will
  // say so plainly rather than the run failing for an unrelated reason.
  try { await initRunArtifacts(run, opts.workflow.name) } catch { /* absence is the signal */ }
```

In `computeInput`, prepend the header to **every** branch — including the retry branch, since a retried step is exactly the one most likely to need to rewrite an artifact:

```ts
  const header = artifactHeader(runArtifactsDir(run.id))
```

In `executeNode`, immediately before **each** `return` — the success path, the failure path, and the halt path added in Task 3:

```ts
  try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
```

In `runWave`, alongside each terminal `publish(run)` — both the completed branch and the failed branch:

```ts
  try { await finalizeRunArtifacts(run) } catch { /* best effort */ }
```

- [ ] **Step 6: Assert the wiring in the runner test**

Append to `scripts/test-workflow-runner.mjs`:

```js
// The runner writes its own record of every run.
{
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const dir = join(process.env.CLAUDE_DIR, 'workflow-runs', r.id, 'artifacts')
  assert.ok(existsSync(join(dir, 'meta.json')), 'meta.json exists after a run')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.identity, 'demo', 'meta.json names the workflow that ran')
  assert.ok(existsSync(join(dir, 'steps', 'step-01-agent-a.json')), 'per-step record exists')
  const first = JSON.parse(readFileSync(join(dir, 'steps', 'step-01-agent-a.json'), 'utf8'))
  assert.equal(first.output, 'output of agent-a', 'the step record holds the real output')
  // And the agent was told where to write.
  assert.ok(r.steps.find(s => s.stepId === 'a').input.includes(dir),
    'every step input names the artifacts directory')
}
```

- [ ] **Step 7: Run the full suite list from Global Constraints, plus typecheck**

- [ ] **Step 8: Commit**

```bash
git add server/utils/runArtifacts.ts server/utils/workflowRunner.ts scripts/test-run-artifacts.mjs scripts/test-workflow-runner.mjs
git commit -m "feat: every workflow run gets an artifacts directory the runner populates itself"
```

---

### Task 3: The halt signal

**Files:**
- Modify: `shared/utils/workflowGraph.ts` (add `parseHalt`)
- Modify: `server/utils/workflowRunner.ts` (`executeNode`)
- Test: `scripts/test-workflow-graph.mjs`, `scripts/test-workflow-runner.mjs`

**Interfaces:**
- Produces: `parseHalt(text: string | undefined | null): string | null` — the reason from the last `PIPELINE-HALT:` line, or `null`.
- Behaviour: a halting step is `failed`; the run is `failed`; every pending step is `skipped` — identical to a thrown error, which is the property the existing failure tests already pin.

- [ ] **Step 1: Write the failing graph test**

Append to `scripts/test-workflow-graph.mjs`:

```js
// parseHalt: a step's structured way of stopping the run
{
  assert.equal(parseHalt('all good'), null, 'ordinary output does not halt')
  assert.equal(parseHalt('tried everything\nPIPELINE-HALT: stack would not come up'),
    'stack would not come up')
  assert.equal(parseHalt('PIPELINE-HALT: first\nPIPELINE-HALT: second'), 'second',
    'the last marker wins, matching parseVerdict')
  assert.equal(parseHalt('the agent may mention PIPELINE-HALT: mid-sentence in prose'), null,
    'the marker must start its own line — prose about it is not a halt')
  assert.equal(parseHalt(''), null)
  assert.equal(parseHalt(undefined), null, 'unreadable output does not halt')
  assert.equal(parseHalt('PIPELINE-HALT:   '), null, 'a marker with no reason is not a halt')
}
```

Add `parseHalt` to that file's import list.

- [ ] **Step 2: Run it and watch it fail**

```bash
node scripts/test-workflow-graph.mjs
```

- [ ] **Step 3: Implement `parseHalt`**

Add to `shared/utils/workflowGraph.ts`, directly beneath `parseVerdict`:

```ts
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
```

- [ ] **Step 4: Run the graph test until it passes**

- [ ] **Step 5: Write the failing runner test**

Append to `scripts/test-workflow-runner.mjs`:

```js
// PIPELINE-HALT stops the run exactly as a throw does.
{
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug === 'agent-b') return 'could not reach the database\nPIPELINE-HALT: stack unavailable'
    return `output of ${agentSlug}`
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  assert.equal(r.status, 'failed', 'a halted step fails the run')
  const b = r.steps.find(s => s.stepId === 'b')
  assert.equal(b.status, 'failed', 'the halting step is failed, not completed')
  assert.match(b.error, /stack unavailable/, 'the reason is preserved in the step error')
  assert.ok(b.output.includes('PIPELINE-HALT'), 'the output is kept for the record')
  assert.equal(r.steps.find(s => s.stepId === 'd').status, 'skipped',
    'downstream steps are skipped, not left pending in a dead run')
}
```

- [ ] **Step 6: Run it and watch it fail**

Expected: `r.status` is `'completed'` — the run marches on to the final step. That is the defect.

- [ ] **Step 7: Implement in `executeNode`**

Add `parseHalt` to the `workflowGraph.ts` import, then in the success path of `executeNode`, immediately after `const output = await agentCaller(...)` and **before** `l.outputs[id] = output`:

```ts
    // A halt is a failure the agent raised deliberately. Checked before the
    // monitor and before the output is published downstream: a step that says
    // it could not proceed has produced no result worth propagating, and
    // running a monitor over a halt would only invite it to vote CONTINUE.
    const halt = parseHalt(output)
    if (halt) {
      markFailed(l.state, id)
      Object.assign(rec, {
        status: 'failed', output, error: `Step halted: ${halt}`, completedAt: Date.now(),
      })
      try { await writeStepArtifact(run, rec, run.steps.indexOf(rec)) } catch { /* best effort */ }
      return false
    }
```

- [ ] **Step 8: Run the full suite list, plus typecheck**

- [ ] **Step 9: Commit**

```bash
git add shared/utils/workflowGraph.ts server/utils/workflowRunner.ts scripts/test-workflow-graph.mjs scripts/test-workflow-runner.mjs
git commit -m "feat: PIPELINE-HALT lets a step stop the run instead of reporting failure downstream"
```

---

### Task 4: Runbook A declares what it needs

**Files:**
- Modify: `app/utils/workflowTemplates.ts` (carry `monitorSlug` / `maxVisits` / `contextMode`; Runbook A declares them)
- Modify: `app/utils/templates.ts` (seven `sdlc-*` bodies; one new monitor agent template)
- Test: `scripts/test-workflow-templates.mjs`

**Interfaces:**
- Consumes: `contextMode` from Task 1, the artifacts header from Task 2, `PIPELINE-HALT` from Task 3.
- Produces: a `runbook-a-jira-to-diff` template whose materialized steps carry `contextMode: 'ancestors'` on the evidence step and `monitorSlug` on the two load-bearing steps.

- [ ] **Step 1: Write the failing template test**

Append to `scripts/test-workflow-templates.mjs`:

```js
// Runbook A declares the wiring its evidence bundle depends on.
{
  const runbook = WORKFLOW_TEMPLATES.find(t => t.id === 'runbook-a-jira-to-diff')
  assert.ok(runbook, 'the Runbook A template exists')

  const slugs = Object.fromEntries(runbook.steps.map(s => [s.agentTemplateId, s.agentTemplateId]))
  slugs['sdlc-step-monitor'] = 'sdlc-step-monitor'
  const steps = materializeTemplateSteps(runbook, slugs)

  const evidence = steps.find(s => s.agentSlug === 'sdlc-evidence-and-pr')
  assert.equal(evidence.contextMode, 'ancestors',
    'the evidence step must see the pre-fix FAIL, which is three hops upstream')

  const provisioner = steps.find(s => s.agentSlug === 'sdlc-stack-provisioner')
  const verifier = steps.find(s => s.agentSlug === 'sdlc-verifier')
  assert.equal(provisioner.monitorSlug, 'sdlc-step-monitor',
    'a silent stack failure makes everything after it meaningless')
  assert.equal(verifier.monitorSlug, 'sdlc-step-monitor')

  // The monitor agent must actually exist, or monitorSlug names nothing and
  // runMonitor's catch quietly turns every review into CONTINUE.
  assert.ok(AGENT_TEMPLATES.find(a => a.id === 'sdlc-step-monitor'),
    'the monitor agent template exists')

  // An unresolvable monitor is dropped rather than kept as a dangling name.
  const noMonitor = materializeTemplateSteps(
    runbook, Object.fromEntries(runbook.steps.map(s => [s.agentTemplateId, s.agentTemplateId])))
  assert.equal(noMonitor.find(s => s.agentSlug === 'sdlc-verifier').monitorSlug, undefined,
    'a monitorSlug that resolves to nothing is dropped, not left dangling')
}

// The sdlc prompts instruct what the evidence bundle requires.
{
  const body = id => AGENT_TEMPLATES.find(a => a.id === id).prompt
  assert.match(body('sdlc-test-author'), /oracle-before\.xml/,
    'the test author is told the exact artifact filename the assembler reads')
  assert.match(body('sdlc-test-author'), /three times/i,
    'three-run determinism is instructed, or the bundle fails at oracle.runs')
  assert.match(body('sdlc-verifier'), /oracle-after\.xml/)
  assert.match(body('sdlc-verifier'), /regression\.xml/)
  assert.match(body('sdlc-ticket-intake'), /intent\.md/)
  assert.match(body('sdlc-ticket-intake'), /context-packet\.json/)
  assert.match(body('sdlc-fix-implementer'), /plan\.md/)
  assert.match(body('sdlc-evidence-and-pr'), /summary\.md/)
  for (const id of ['sdlc-ticket-intake', 'sdlc-stack-provisioner', 'sdlc-test-author',
                    'sdlc-fix-implementer', 'sdlc-verifier', 'sdlc-trace-capture',
                    'sdlc-evidence-and-pr']) {
    assert.match(body(id), /PIPELINE-HALT/,
      `${id} must know how to stop the run rather than report failure downstream`)
  }
}
```

Import `AGENT_TEMPLATES` in that test if it does not already.

- [ ] **Step 2: Run it and watch it fail**

```bash
node scripts/test-workflow-templates.mjs
```

- [ ] **Step 3: Carry the three fields through materialization**

In `app/utils/workflowTemplates.ts`, extend `WorkflowTemplateStep`:

```ts
  /** `agentTemplateId` of the agent that reviews this step's output. */
  monitorSlug?: string
  /** How many times this step may run in one execution. */
  maxVisits?: number
  /** See WorkflowStep.contextMode. */
  contextMode?: 'predecessors' | 'ancestors'
```

and in `materializeTemplateSteps`, after the `next` translation:

```ts
    // monitorSlug names an AGENT, not a step, so it resolves through the same
    // agentSlug map the step's own agentSlug does — not through
    // stepIdByTemplateId. Dropped when unresolvable, for the same reason a
    // dangling `next` target is dropped: a monitorSlug naming an agent that
    // does not exist makes every review silently CONTINUE.
    if (step.monitorSlug) {
      const resolved = agentSlugByTemplateId[step.monitorSlug]
      if (resolved) materialized.monitorSlug = resolved
    }
    if (step.maxVisits !== undefined) materialized.maxVisits = step.maxVisits
    if (step.contextMode !== undefined) materialized.contextMode = step.contextMode
```

- [ ] **Step 4: Declare them on Runbook A**

In the `runbook-a-jira-to-diff` template's steps:

```ts
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack',
        next: ['sdlc-test-author'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-verifier', label: 'Verify + Regression',
        next: ['sdlc-evidence-and-pr'], monitorSlug: 'sdlc-step-monitor' },
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR',
        next: [], contextMode: 'ancestors' },
```

Keep the other four steps and the existing ordering exactly as they are.

**Do not add `sdlc-step-monitor` as a step.** It is an agent the steps reference, not a stage of the pipeline. Whichever code resolves `agentSlugByTemplateId` before calling `materializeTemplateSteps` must therefore also resolve monitor agents — find that call site (search for `materializeTemplateSteps(` outside the test), include every step's `monitorSlug` in the set of agent template ids it creates and resolves, and say in your report where that was and what you changed.

- [ ] **Step 5: Add the monitor agent template**

In `app/utils/templates.ts`, add alongside the other `sdlc-*` entries, matching the surrounding entries' exact field shape (read one first — `model`, `color`, `icon` and any other fields must be present and of the right type):

```ts
  {
    id: 'sdlc-step-monitor',
    name: 'SDLC Step Monitor',
    description: 'Reviews a pipeline step\'s output and votes CONTINUE, RETRY or ABORT.',
    prompt: `You review one step of an automated fix pipeline. You did not run the step; you see only its input and its output.

Judge one thing: did this step actually do what it claims?

The failure you exist to catch is a step that reports success in prose while
producing nothing. "The stack is up" with no command output is not evidence
the stack is up. "Tests pass" with no test output is not evidence tests pass.

End your review with exactly one line:

VERDICT: CONTINUE   - the step did what it claims, with evidence in the output
VERDICT: RETRY      - the step is recoverable and a second attempt is worth making
VERDICT: ABORT      - the step failed in a way that makes every later step meaningless

Prefer ABORT over CONTINUE when the step was supposed to establish something
later steps depend on and did not. A pipeline that stops here is cheap; a pull
request built on evidence that was never gathered is not.`,
  },
```

- [ ] **Step 6: Extend the seven `sdlc-*` prompts**

Append to each of the seven existing prompt bodies. Every one gets this block verbatim:

```
## Stopping

If you cannot complete this step — the stack will not come up, the repository
is not there, a required credential is missing — do not describe the problem
and hand it downstream. End your output with a line of exactly this form:

PIPELINE-HALT: <one line saying what stopped you>

That line stops the run. Nothing after your step will execute, which is the
correct outcome: every later step's work would be built on something that did
not happen.
```

Plus, per agent, an artifact instruction naming the exact filenames. These filenames are the assembler's published contract — a near-miss filename is a silently missing artifact, so copy them exactly:

- **`sdlc-ticket-intake`** — write `intent.md` (problem, outcome, affected systems, constraints, open questions; "not stated" is the correct answer for anything the ticket does not say) and `context-packet.json` (the exact context you worked from). Merge `ticket`, `watch`, `work_type`, `class`, `product`, `blast_radius` into `meta.json`.
- **`sdlc-stack-provisioner`** — merge a `stack` key into `meta.json` recording the compose profile, topology, and Liquibase tag (or `null`).
- **`sdlc-test-author`** — write the pre-fix run to `oracle-before.xml` in JUnit xunit format, and **run the oracle three times**, recording all three. Merge an `oracle` key into `meta.json` with `kind`, `path`, `runs`, `rows`. State plainly in the prompt: a single run is not evidence, and the bundle is rejected at `oracle.runs`; and this oracle must **FAIL** — a passing pre-fix oracle means nothing was reproduced.
- **`sdlc-fix-implementer`** — write `plan.md`. Merge a `fix` key into `meta.json` with `repos` (each `{ repo, commits, pr }`), `files_changed`, `lines_changed`, `test_dirs_unlocked`, and `unlock_reason` when unlocked. More than one repo additionally requires `merge_order`.
- **`sdlc-verifier`** — write `oracle-after.xml` (three runs; must PASS) and `regression.xml`. Merge `oracle_after` and `regression.suite` into `meta.json`.
- **`sdlc-trace-capture`** — write `trace.zip`. If there is no browser surface to trace, say so plainly: the bundle allows a null trace, and a fabricated one is worse than an honest absence.
- **`sdlc-evidence-and-pr`** — write `summary.md`, under 40 lines: what was wrong, what changed, what proves it, the blast-radius label, the deployment truths considered, and the cost. Then run the assembler against the artifacts directory and report its real output:
  ```
  node engineering/scripts/assemble-bundle.mjs --run-dir <artifacts dir> --out <artifacts dir>/bundle.json
  ```
  If it exits non-zero, the fields it names as missing are the finding — report them and do **not** open a PR.

Every agent that merges into `meta.json` must read the file, merge its keys, and write it back — never overwrite it. Say that in each prompt that touches it.

- [ ] **Step 7: Run the template test until it passes, then the full suite list and typecheck**

- [ ] **Step 8: Commit**

```bash
git add app/utils/workflowTemplates.ts app/utils/templates.ts scripts/test-workflow-templates.mjs
git commit -m "feat: Runbook A declares ancestry, monitors and the artifacts its bundle needs"
```

---

### Task 5: The acceptance test

**Files:**
- Create: `scripts/test-runbook-a-acceptance.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–4, plus `engineering/scripts/assemble-bundle.mjs` and `validate-bundle.mjs` **unchanged**.
- Produces: proof that a run producing the specified artifacts yields a bundle the real validator accepts — and a named list of what is still missing if it does not.

- [ ] **Step 1: Write the test**

Create `scripts/test-runbook-a-acceptance.mjs`. A stub agent caller plays all seven agents: each one parses the artifacts directory out of its input header (proving the header is the working channel, not an assumption), writes the files its real counterpart is instructed to write, and returns prose. Then assemble and validate for real.

```js
/**
 * Acceptance: a Runbook A run must produce a directory the REAL assembler
 * turns into a bundle the REAL validator accepts.
 *
 * The agents are stubbed; nothing else is. This is the test that fails when
 * the pipeline and the bundle contract drift apart — which is exactly the
 * failure that made this whole change necessary.
 *
 *   node scripts/test-runbook-a-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'acceptance-'))
const runner = await import('../server/utils/workflowRunner.ts')
const { assembleBundle } = await import('../engineering/scripts/assemble-bundle.mjs')

const xunit = failures => `<testsuite tests="4" failures="${failures}" errors="0" skipped="0"/>`

const mergeMeta = (dir, patch) => {
  const path = join(dir, 'meta.json')
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  writeFileSync(path, JSON.stringify({ ...cur, ...patch }, null, 2))
}

// The directory is discovered from the input header — the same way a real
// agent must discover it. A change that breaks the header breaks this test.
const dirFrom = (input) => {
  const m = input.match(/Write every artifact you produce into: (\S+)/)
  assert.ok(m, 'every step input carries the artifacts directory')
  return m[1]
}

const writers = {
  'sdlc-ticket-intake': (dir) => {
    writeFileSync(join(dir, 'intent.md'), '# Intent\n\nParsing drops the second AVP.\n')
    writeFileSync(join(dir, 'context-packet.json'), JSON.stringify({ ticket: 'SA-1203' }))
    mergeMeta(dir, {
      ticket: 'SA-1203', watch: 'sa-bugs', work_type: 'bug', class: 'parsing',
      product: 'ocs_cpp14', blast_radius: 'ui_parsing', plugin_version: '0.1.0',
      adversarial: null,
    })
  },
  'sdlc-stack-provisioner': dir =>
    mergeMeta(dir, { stack: { profile: 'ocs', topology: 'single', liquibase_tag: null } }),
  'sdlc-test-author': (dir) => {
    writeFileSync(join(dir, 'oracle-before.xml'), xunit(4))
    mergeMeta(dir, { oracle: { kind: 'parameterised_test', path: 'tests/test_avp.py', runs: 3, rows: 4 } })
  },
  'sdlc-fix-implementer': (dir) => {
    writeFileSync(join(dir, 'plan.md'), '# Plan\n\nFix the loop bound.\n')
    mergeMeta(dir, {
      fix: {
        repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://example.invalid/pr/1' }],
        files_changed: 2, lines_changed: 18, test_dirs_unlocked: false, unlock_reason: null,
      },
    })
  },
  'sdlc-verifier': (dir) => {
    writeFileSync(join(dir, 'oracle-after.xml'), xunit(0))
    writeFileSync(join(dir, 'regression.xml'), xunit(0))
    mergeMeta(dir, {
      oracle_after: { kind: 'parameterised_test', path: 'tests/test_avp.py', runs: 3, rows: 4 },
      regression: { suite: 'full' },
    })
  },
  'sdlc-trace-capture': dir => writeFileSync(join(dir, 'trace.zip'), 'PKstub'),
  'sdlc-evidence-and-pr': dir =>
    writeFileSync(join(dir, 'summary.md'), '# SA-1203\n\nWhat was wrong, what changed, what proves it.\n'),
}

const workflow = {
  slug: 'runbook-a', name: 'Runbook A',
  steps: [
    { id: 'i', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['s'] },
    { id: 's', agentSlug: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['t'] },
    { id: 't', agentSlug: 'sdlc-test-author', label: 'Failing Test', next: ['f'] },
    { id: 'f', agentSlug: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['v', 'c'] },
    { id: 'v', agentSlug: 'sdlc-verifier', label: 'Verify + Regression', next: ['e'] },
    { id: 'c', agentSlug: 'sdlc-trace-capture', label: 'Browser Trace', next: ['e'] },
    { id: 'e', agentSlug: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR',
      next: [], contextMode: 'ancestors' },
  ],
}

runner.setAgentCaller(async (agentSlug, input) => {
  writers[agentSlug](dirFrom(input))
  return `${agentSlug} done. EVIDENCE-FROM-${agentSlug}`
})

const run = await runner.waitForSettled(
  (await runner.startRun({ workflow, initialPrompt: 'Fix SA-1203', autoRun: true })).id, 15000)
assert.equal(run.status, 'completed',
  `run finished: ${JSON.stringify(run.steps.map(s => [s.stepId, s.status, s.error]))}`)

// The keystone property, asserted directly: the evidence step saw the step
// three hops upstream that produced the pre-fix FAIL.
const evidenceInput = run.steps.find(s => s.stepId === 'e').input
assert.ok(evidenceInput.includes('EVIDENCE-FROM-sdlc-test-author'),
  'the evidence step receives the test author output, three hops upstream')

const dir = join(process.env.CLAUDE_DIR, 'workflow-runs', run.id, 'artifacts')
const { bundle, problems } = await assembleBundle(dir)
assert.deepEqual(problems, [],
  `the assembled bundle must validate. Problems: ${JSON.stringify(problems, null, 2)}`)
assert.equal(bundle.oracle.verdict, 'FAIL', 'the pre-fix oracle failed — something was reproduced')
assert.equal(bundle.oracle_after.verdict, 'PASS', 'the post-fix oracle passed')
assert.equal(bundle.ticket, 'SA-1203')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('runbook A acceptance: all checks passed')
```

- [ ] **Step 2: Run it**

```bash
node scripts/test-runbook-a-acceptance.mjs
```

**This is the step where a real finding is likely.** If `problems` is non-empty, read what it names and classify it:

- A field the **stub** forgot to write → fix the stub, then check whether the corresponding real prompt in Task 4 instructs writing it. If not, that is a Task 4 gap: fix the prompt too.
- A field **no agent could supply** — a hash the assembler computes, or a key belonging to the runner → that is a real finding about the pipeline. Fix the pipeline, not the schema. The Global Constraints forbid loosening the bundle contract to make this pass.
- The path the assembler reads differs from where the runner writes → reconcile on the assembler's documented contract; it is the older, published one.

Report exactly which of these you hit.

- [ ] **Step 3: Run every suite**

```bash
for t in scripts/test-*.mjs; do echo "== $t"; node "$t" || echo "FAILED $t"; done
node engineering/scripts/test-assemble-bundle.mjs
node engineering/scripts/test-validate-bundle.mjs
node engineering/scripts/test-validate-registry.mjs
node engineering/scripts/test-hooks.mjs
node .superpowers/sdd/*/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js -b --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add scripts/test-runbook-a-acceptance.mjs
git commit -m "test: Runbook A produces a bundle the real assembler and validator accept"
```

- [ ] **Step 5: Report**

State plainly, in the report file:

1. Whether the acceptance test passes, and if it needed pipeline changes, which.
2. Which bundle fields still come from an agent's **self-report** rather than a computed fact — `fix.files_changed`, `fix.lines_changed` and `fix.repos` at minimum. This is the honest limit of the change and belongs at the top of the report, not buried.
3. That `cost.input_tokens` and `cost.output_tokens` are `0` because the runner does not observe token usage, and what it would take to change that.
