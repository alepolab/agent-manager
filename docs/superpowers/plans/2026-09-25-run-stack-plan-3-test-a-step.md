# Run Stack (Plan 3 of 3): Test a Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the builder's step drawer, run one step against a finished run's outputs. The step uses its current, possibly unsaved, config. It runs on its own throwaway branch, with no side effects, and nothing after it runs.

**Architecture:** A new `startTestRun` in the runner creates a run that carries `testOf`:
- **Created from the source run.** Every step before the tested one is copied in as completed, with its outputs, and the source's artifacts are copied too. Every other step is skipped as "Not part of this test".
- **Resumed like a restart.** The runner rebuilds its scheduling state with the existing `rehydrate`, arms the tested step, and drives the run.
- **Stops after one step.** `runWave` settles the run as soon as the tested step settles.
- **Has no side effects.**
  - Approvals don't pause it.
  - Jira, notify and loop steps record what they would have done and do nothing.
  - The finished-run Jira comment and the channel notification are skipped.
- **Runs in its own worktree.** The worktree is cut from the tested step's recorded start commit (`headAtStart`, recorded from now on), or from the source branch. It is removed when the test settles.
- **Kept apart from real runs:**
  - hidden from `/runs` by default
  - left out of watch dispatch checks, group slots and notifications
  - costed on a separate line

**Tech Stack:** Nuxt 3 server routes, `server/utils/workflowRunner.ts`, real local git in tests, Vue 3 + Nuxt UI v3.

**Spec:** `docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md`, section 4. It depends on Plan 2's `StepDrawer.vue` (the Test tab goes there) and Plan 1's `/runs` view chips.

## Global Constraints

- **A test run is marked by `WorkflowRun.testOf`, never by `origin`.**
  - `origin` already means where a defect was found (`'production' | 'qa' | 'development'`). It is read by `baseBranchFor`, so reusing it would change branch routing.
  - `parentRunId` stays reserved for loop-step (dispatch) lineage. `resumeJoinIfReady` walks it.
  - Task 6 corrects the spec, which said `origin: 'test'` and `parentRunId`.
- **`testOf` shape:** `{ sourceRunId: string, stepId: string, stepOverride?: Record<string, unknown>, startPoint: string, codeNote?: string }`.
  - `startPoint` is the commit or branch the worktree was cut from.
  - `codeNote` is the warning shown when `headAtStart` was missing.
- **Tested step and stop point:** `run.stopAfter = testOf.stepId`. The runner arms nothing after it. The run settles `completed`, or `failed` if the step fails.
- **No side effects.** In a test run:
  - Jira, notify and loop steps call nothing external and start no child run.
  - No approval pauses the run. The budget gate still applies.
  - `notifyTicketOutcome` and `onRunTransition` are not called.
- **Kept apart from real runs:**
  - `findActiveRun` and `inFlightForGroup` ignore test runs.
  - The notifications route drops them.
  - `GET /api/runs` leaves them out unless `?tests=1` is passed.
  - `GET /api/runs/cost` reports them under a separate `tests` key.
- **Code state:**
  - The worktree branch is `test/<sourceRunId first 8>-<stepId first 8>-<n>`, with `n` counting up from 1 until the branch is free.
  - The root repository's worktree starts from the source step's `headAtStart` when it was recorded. Otherwise it starts from the source run's branch, and `codeNote` is set to `Code is the state at the end of run <first 8 of sourceRunId>, not when this step ran.`
  - Nested repositories always start from the source run's branch.
  - The worktree and branch are removed when the test run settles, and the artifacts stay.
- **Permissions:** `POST /api/runs/:id/test` requires `runEngine`, the same as restart.
- **Value imports** inside `shared/` and `server/` use the `.ts` extension. **Tests** are plain node scripts. The runner harness is in `scripts/test-workflow-runner.mjs`:
  - set `CLAUDE_DIR` and `AGENT_RUNS_DIR` to tmpdirs before importing the runner
  - use `runner.setPreflight`, `runner.setAgentCaller`, `runner.waitForSettled` and `runner._dropLive`
  - use real git repositories in tmpdirs
- **Typecheck:** `npx nuxt typecheck` must stay at 0 errors.
- **Known baseline failures:**
  - `test-jira-steps` and `test-ticket-notifier` (missing JIRA env)
  - `test-gitignore-keeps-plans` (only in this worktree)
  - the Groups section of `e2e/concurrency-groups.smoke.mjs`
- **Commits:** configured identity, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `shared/types/run.ts` | modify | `RunStep.headAtStart`, `WorkflowRun.testOf`, `WorkflowRun.stopAfter`, `isTestRun()` |
| `server/utils/workflowRunner.ts` | modify | Record `headAtStart`; `publish` skips notifications for tests; `runWave` stop-after, approval skip; dry-run steps; `startTestRun`; `testOf.stepOverride` applied where steps load |
| `server/utils/workflowRunStore.ts` | modify | `findActiveRun` ignores tests |
| `server/utils/runQueue.ts` | modify | `inFlightForGroup` ignores tests |
| `server/utils/workspace.ts` | modify | `ensureTestWorktrees`, `removeTestWorktrees` |
| `server/api/notifications/index.get.ts`, `server/api/runs/index.get.ts`, `server/api/runs/cost.get.ts` | modify | Exclude or separate test runs |
| `server/api/runs/[id]/test.post.ts` | create | Start a test run |
| `scripts/test-test-run.mjs` | create | Runner-level tests: seeding, stop-after, no gates, dry runs, override, exclusions, worktree start point and cleanup |
| `app/components/StepTestPanel.vue` | create | The Test tab: pick a run, start, show the result |
| `app/components/StepDrawer.vue` | modify | Third tab, "Test" |
| `app/pages/runs/index.vue` | modify | "Tests" chip |
| `CLAUDE.md`, the spec | modify | Document, and record corrections |

---

### Task 1: Types, `headAtStart`, and keeping test runs apart

**Files:**
- Modify: `shared/types/run.ts`, `server/utils/workflowRunner.ts` (the step-start `Object.assign` near line 829, `publish` near lines 413-456), `server/utils/workflowRunStore.ts:238-241`, `server/utils/runQueue.ts:91-94`, `server/api/notifications/index.get.ts`, `server/api/runs/index.get.ts`, `server/api/runs/cost.get.ts`
- Test: `scripts/test-test-run.mjs` (section 1; later tasks add sections)

**Interfaces:**
- Produces:
  - `RunStep.headAtStart?: string`
  - `interface TestOf { sourceRunId: string, stepId: string, stepOverride?: Record<string, unknown>, startPoint: string, codeNote?: string }`
  - `WorkflowRun.testOf?: TestOf`
  - `WorkflowRun.stopAfter?: string`
  - `isTestRun(run: Pick<WorkflowRun, 'testOf'>): boolean`, exported from `shared/types/run.ts`

- [ ] **Step 1: Write the failing test (section 1)**

Create `scripts/test-test-run.mjs`:

```js
/**
 * Self-check for test runs: one step run against a finished run's outputs,
 * on its own branch, with no side effects, kept apart from real runs.
 *
 *   node scripts/test-test-run.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'test-run-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'test-run-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const queue = await import('../server/utils/runQueue.ts')
const { isTestRun } = await import('../shared/types/run.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 30_000
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
const save = w => writeFileSync(join(CLAUDE_DIR, 'workflows', `${w.slug}.json`), JSON.stringify(w, null, 2))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'test-run-repo-'))
  git(dir, 'init', '-q', '-b', 'develop')
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'README.md'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one')
  return dir
}

// ── 1. isTestRun, and a real run records headAtStart ───────────────────────
assert.equal(isTestRun({}), false)
assert.equal(isTestRun({ testOf: { sourceRunId: 'r', stepId: 's', startPoint: 'x' } }), true)
{
  const workflow = { slug: 'heads', name: 'Heads', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ] }
  save(workflow)
  const projectDir = repo()
  runner.setAgentCaller(async (slug, _input, dir) => {
    if (slug === 'agent-a') { writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'a') }
    return `output of ${slug}`
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, projectDir })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  const [a, b] = run.steps
  assert.match(a.headAtStart, /^[0-9a-f]{40}$/, 'a step records the commit it started from')
  assert.notEqual(a.headAtStart, b.headAtStart, 'b started after a committed')
}

// ── 2. test runs are kept apart ────────────────────────────────────────────
{
  const live = { id: 't1', workflowSlug: 'heads', status: 'running', group: undefined, testOf: { sourceRunId: 'x', stepId: 'a', startPoint: 'develop' } }
  assert.equal(queue.inFlightForGroup('default', [live]), 0, 'a test run holds no group slot')
  assert.equal(queue.inFlightForGroup('default', [{ ...live, testOf: undefined }]), 1, 'a real one does')
}

console.log('testRun: all checks passed')
process.exit(0)
```

Read `inFlightForGroup`'s real signature and its group-defaulting in `runQueue.ts` first, and adjust the call's arguments to match. The assertion values stay the same.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node scripts/test-test-run.mjs`. It should fail because `isTestRun` is not exported.

- [ ] **Step 3: Types**

In `shared/types/run.ts`:
- Inside `RunStep`, add:
  ```ts
  /** The commit (`git rev-parse HEAD` in the run's worktree) this step started from. Lets a test of this step start from the same code. Absent on runs from before it was recorded. */
  headAtStart?: string
  ```
- Next to `SendBack`, add the `TestOf` interface above, with a doc comment for each field.
- Inside `WorkflowRun`, add:
  ```ts
  /** Set on a run that tests one step of another run. Never set on a real run. See TestOf. */
  testOf?: TestOf
  /** The runner arms nothing after this step and settles the run when it settles. Set on test runs. */
  stopAfter?: string
  ```
- Export:
  ```ts
  export function isTestRun(run: Pick<WorkflowRun, 'testOf'>): boolean { return !!run.testOf }
  ```

- [ ] **Step 4: Record `headAtStart`**

In `workflowRunner.ts`, import `captureBaseline` from `./gitFacts.ts` if it isn't already imported. In `executeNode`'s `Object.assign(rec, { status: 'running', … })`, add:

```ts
      headAtStart: run.projectDir ? (await captureBaseline(run.projectDir)) ?? undefined : undefined,
```

The value must be computed before the `Object.assign` (the `await` can't sit inside an object literal passed synchronously in some lint setups). Compute `const headAtStart = …` on the line before and reference it.

- [ ] **Step 5: Exclusions**
  - `workflowRunStore.ts`, in `findActiveRun`: `runs.find(r => isLiveStatus(r.status) && !isTestRun(r))`.
  - `runQueue.ts`, in `inFlightForGroup`: add `&& !isTestRun(r)` to the filter.
  - `workflowRunner.ts`, in `publish`:
    - wrap the `if (run.ticketKey && !run.ticketCommented)` block's condition with `!isTestRun(run) &&`
    - change `onRunTransition(run)` to `if (!isTestRun(run)) onRunTransition(run)`
    - add a one-line comment on each saying a test run tells no one.
  - `server/api/notifications/index.get.ts`: pass `(await listRuns()).filter(r => !isTestRun(r))`.
  - `server/api/runs/index.get.ts`: `const runs = await listRuns(); return getQuery(event).tests === '1' ? runs : runs.filter(r => !isTestRun(r))`. Keep whatever it does today and add only this filter.
  - `server/api/runs/cost.get.ts`: return the existing aggregate over the real runs, with a `tests` key added: `aggregateCost(runs.filter(isTestRun))`. Read the route first. If its return type is consumed by `app/` code, add `tests` as an optional field, so no existing consumer changes.

- [ ] **Step 6: Run the test, then the runner tests**

```bash
node scripts/test-test-run.mjs && node scripts/test-workflow-runner.mjs && node scripts/test-run-history.mjs && node scripts/test-notifications.mjs
```

Expected: all pass. If `test-notifications.mjs` doesn't exist, skip it.

- [ ] **Step 7: Commit**

```bash
git add shared/types/run.ts server/utils/workflowRunner.ts server/utils/workflowRunStore.ts server/utils/runQueue.ts server/api/notifications/index.get.ts server/api/runs/index.get.ts server/api/runs/cost.get.ts scripts/test-test-run.mjs
git commit -m "feat(runs): record each step's start commit; keep test runs out of real-run accounting

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `startTestRun`: seeding, stop-after, no gates, override

**Files:**
- Modify: `server/utils/workflowRunner.ts`
- Test: `scripts/test-test-run.mjs` (section 3)

**Interfaces:**
- Consumes: `rehydrate(run)` (~2896), `armNode`, `markCompleted`, `ancestorsOf` / `buildGraph` from `shared/utils/workflowGraph.ts`, `loadWorkflowSteps`, `createRun`, `saveRun`, the `restartRun` tail pattern (~3095-3156), and `runArtifactsDir` from `runArtifacts.ts`.
- Produces:
  - `export class TestRunError extends Error { constructor(public status: number, message: string) }`
  - `export async function startTestRun(sourceRunId: string, stepId: string, opts?: { stepOverride?: Record<string, unknown>, startedBy?: string }): Promise<WorkflowRun>`

**How it works:**

1. **Load the source run.**
   - Missing → `TestRunError(404, 'Run not found')`.
   - Live (`isLiveStatus`) → `409, 'Wait for this run to finish before testing one of its steps.'`
   - The step isn't in it → `400, 'Unknown step "<id>" on this run.'`
2. **Load the workflow's steps** (`loadWorkflowSteps(source.workflowSlug)`) and `buildGraph`. The ancestors come from `ancestorsOf(graph, stepId)`.
   - Every ancestor must be `completed`, or `skipped` with a `skipReason`, in the source run. Otherwise → `409, 'This run stopped before "<label>" could run: "<first unsettled ancestor label>" did not finish. Pick a run that got that far.'`
3. **Create the run** through `createRun`, with the source's `workflowSlug`, `workflowName`, `initialPrompt`, `parameters`, `projectDir`, `watch` and `startedBy` (opts.startedBy ?? source.startedBy). Then set:
   - `testOf = { sourceRunId, stepId, stepOverride, startPoint: '' }`. Task 3 fills `startPoint` and `codeNote`.
   - `stopAfter = stepId`
   - `ticketKey`, `product`, `workType`, `origin` and `blastRadius` copied from the source
   - `autoRun = true`
4. **Seed the steps:**
   - Each ancestor: copy `status`, `input`, `output`, `skipReason`, `usage: null` and `visits` from the source. The cost stays with the source run.
   - The tested step: leave it `pending`.
   - Every other step: `status: 'skipped'`, `skipReason: 'Not part of this test'`.
   - Save the run.
5. **Copy the artifacts:** `await cp(runArtifactsDir(sourceRunId), runArtifactsDir(run.id), { recursive: true, force: false })` from `node:fs/promises`, only if the source directory exists.
6. **Apply the override where steps load.** Find the one place where `rehydrate` and `beginRun` get the workflow's steps (`loadWorkflowSteps`), and pass them through:
   ```ts
   function withTestOverride<T extends { id: string }>(steps: T[], run: Pick<WorkflowRun, 'testOf'>): T[] {
     const o = run.testOf?.stepOverride
     if (!o) return steps
     const { id: _id, next: _next, ...patch } = o as Record<string, unknown>
     return steps.map(s => (s.id === run.testOf!.stepId ? { ...s, ...patch } as T : s))
   }
   ```
   `id` and `next` are never overridden. The graph is the saved workflow's.
7. **Drive the run:** `const l = await rehydrate(run)`, arm `stepId` the way `restartRun` arms its restart point, `run.status = 'running'`, `await saveRun(run)`, then call `driveToSettlement(…)` exactly as `restartRun` does. Return the run. Export `rehydrate` only if `startTestRun` can't live next to it, and prefer keeping it unexported.

**`runWave` changes:**
- **Stop-after.** Directly after `const ready = readyNodes(l.graph, l.state)`, and before the `!ready.length` branches:
  ```ts
  // A test run settles with its one step: nothing after it is armed or run,
  // and the steps that were never going to run are not a stuck run.
  if (run.stopAfter) {
    const rec = run.steps.find(s => s.stepId === run.stopAfter)
    if (rec && ['completed', 'failed', 'skipped'].includes(rec.status)) {
      for (const s of run.steps) if (s.status === 'pending') { s.status = 'skipped'; s.skipReason ??= 'Not part of this test' }
      run.status = rec.status === 'failed' ? 'failed' : 'completed'
      if (rec.status === 'failed') run.error ??= rec.error ?? `"${rec.label}" failed.`
      run.endedAt = Date.now()
      run.currentStepIds = []
      run.nextStepIds = []
      l.running = false
      await publish(run)
      return run
    }
  }
  ```
- **No approval pauses.** In the `gatedSet` computation (~1941), add `&& !isTestRun(run)` to the filter condition. Leave the budget gate alone.

- [ ] **Step 1: Add section 3 to the test**, before the final `console.log`:

```js
// ── 3. a test run: seeded, one step, no gates, override ────────────────────
{
  const workflow = { slug: 'tested', name: 'Tested', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: ['c'], approval: true },
    { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
  ] }
  save(workflow)
  const seen = []
  runner.setAgentCaller(async (slug, input) => { seen.push({ slug, input }); return `output of ${slug}` })
  const src = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  let source = await runner.waitForSettled(src.id, TIMEOUT)
  if (source.status === 'paused') { await runner.continueRun(source.id); source = await runner.waitForSettled(src.id, TIMEOUT) }
  assert.equal(source.status, 'completed', 'the source run finishes (its approval answered)')

  seen.length = 0
  const t = await runner.startTestRun(source.id, 'b', { stepOverride: { agentSlug: 'agent-b2', id: 'hijack', next: ['a'] } })
  const test = await runner.waitForSettled(t.id, TIMEOUT)
  assert.equal(test.status, 'completed', 'the approval did not pause the test')
  assert.deepEqual(seen.map(s => s.slug), ['agent-b2'], 'only the tested step ran, with the overridden agent')
  assert.match(seen[0].input, /output of agent-a/, 'it saw the source run\'s earlier output')
  const byId = Object.fromEntries(test.steps.map(s => [s.stepId, s]))
  assert.equal(byId.a.status, 'completed'); assert.equal(byId.a.output, 'output of agent-a')
  assert.equal(byId.b.status, 'completed')
  assert.equal(byId.c.status, 'skipped'); assert.equal(byId.c.skipReason, 'Not part of this test')
  assert.equal(test.testOf.sourceRunId, source.id)
  assert.equal(test.stopAfter, 'b')
  assert.equal(test.parentRunId, undefined, 'dispatch lineage untouched')

  await assert.rejects(runner.startTestRun(source.id, 'zz'), e => e.status === 400)
  await assert.rejects(runner.startTestRun('nope', 'b'), e => e.status === 404)

  // A failing tested step fails the test run, and still runs nothing after it.
  seen.length = 0
  runner.setAgentCaller(async (slug) => { seen.push({ slug }); if (slug === 'agent-b') throw new Error('boom'); return `output of ${slug}` })
  const f = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.equal(f.status, 'failed')
  assert.ok(!seen.some(s => s.slug === 'agent-c'), 'nothing after the tested step')

  // A source run that never reached the step is refused with a reason.
  runner.setAgentCaller(async (slug) => { if (slug === 'agent-a') throw new Error('stop'); return 'x' })
  const early = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  await assert.rejects(runner.startTestRun(early.id, 'c'), e => e.status === 409 && /did not finish/.test(e.message))
}
```

Match the exact name of the continue function the runner exports (`continueRun`), and how the existing tests answer an approval gate. Read `scripts/test-workflow-runner.mjs` for the pattern.

- [ ] **Step 2: Run it and confirm section 3 fails** (`startTestRun` is not a function).
- [ ] **Step 3: Implement** as described above.
- [ ] **Step 4: Run** `node scripts/test-test-run.mjs && node scripts/test-workflow-runner.mjs` → both pass.
- [ ] **Step 5: Commit**

```bash
git add server/utils/workflowRunner.ts scripts/test-test-run.mjs
git commit -m "feat(runs): startTestRun runs one step against a finished run's outputs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Dry-run steps and the test worktree

**Files:**
- Modify: `server/utils/workflowRunner.ts` (the `step.jira` branch ~853, `step.notify` ~935, `runDispatchStep` ~1510, `ensureRunCheckoutOnce` ~2176-2222, `publish` terminal branch), `server/utils/workspace.ts`
- Test: `scripts/test-test-run.mjs` (sections 4-5)

**Interfaces:**
- Produces:
  - `ensureTestWorktrees(path: string, branch: string, rootStart: string, nestedStart: string): Promise<string[]>`
  - `removeTestWorktrees(path: string, branch: string): Promise<void>`

  Both are exported from `workspace.ts`.

**Dry runs.** In a test run, each runner-executed step records what it would have done and completes. Nothing external is called:
- **Jira** (before `runJiraStep`):
  - output `[Test run] Would move <ticketKey ?? 'the ticket'> to "<cfg.transition>"`
  - then `, and post the outcome comment` if `cfg.comment`
  - then `, and attach the evidence files` if `cfg.attach`
  - For `action: 'create'`: `[Test run] Would create Jira tickets from <cfg.source>`.
- **Notify** (before `runNotifyStep`): `[Test run] Would post to <cfg.channel>: <cfg.message ?? '(default message)'>`.
- **Loop** (at the top of `runDispatchStep`, before any planning result is acted on): run the existing planning (`planDispatch` / `planListDispatch`) so the list is real. Return `{ output: '[Test run] Would start N runs:\n' + list of "<item> → <workflow slug>", failed: false }` and start nothing.

Each then goes down the same completion path as a real success. Write the output as the step's artifact the way the real path does.

**The worktree.**
- In `ensureRunCheckoutOnce`, when `run.testOf` is set:
  - Branch: `test/${testOf.sourceRunId.slice(0, 8)}-${testOf.stepId.slice(0, 8)}-${n}`, where `n` is the first value from 1 upward for which `git rev-parse --verify --quiet refs/heads/<branch>` fails in the checkout.
  - Root start: the source run's `steps.find(s => s.stepId === testOf.stepId)?.headAtStart`. If there is none, use the source run's `branch`, and set `testOf.codeNote` to `Code is the state at the end of run ${sourceRunId.slice(0, 8)}, not when this step ran.`
  - Nested start: the source run's `branch`.
  - Call `ensureTestWorktrees(checkout, branch, rootStart, nestedStart)` instead of `ensureRunBranch`. Set `run.branch`, `testOf.startPoint = rootStart` and `run.projectDir` the same way the normal path does.
  - Look up the source run with `getRun(testOf.sourceRunId)`.
- **`ensureTestWorktrees`** mirrors `ensureRunBranch`'s loop: `worktreeDirFor`, `nestedRepos`, `worktree prune`, and `excludeFromGit`. It never fetches, and it always runs `git worktree add --quiet -B <branch> <wt> <start>`, with `rootStart` for the root repository and `nestedStart` for the nested ones.
- **`removeTestWorktrees`**, for the root and every nested repository:
  - `git worktree remove --force <wt>` (ignore "not a working tree")
  - `git branch -D <branch>` (ignore "not found")
  - `git worktree prune`

  Put a doc comment on it. It must refuse any branch that doesn't start with `test/`, because a run's real branch is never removed.
- **In `publish`,** when a test run reaches a terminal status (`completed`, `failed`, `stopped`), call `removeTestWorktrees(checkout, run.branch)` once, best effort, logging a failure. Save the run's `projectDir` as it is. Work out the checkout the same way `ensureRunCheckoutOnce` does. Add a `testWorktreeRemoved?: true` marker on `testOf` so it runs once.

- [ ] **Step 1: Add sections 4-5 to the test**

```js
// ── 4. runner steps dry-run in a test ──────────────────────────────────────
{
  const workflow = { slug: 'drytest', name: 'Dry', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['j'] },
    { id: 'j', agentSlug: 'sdlc-jira-tracker', label: 'Jira', jira: { transition: 'In Review', comment: true }, next: ['n'] },
    { id: 'n', agentSlug: 'sdlc-notifier', label: 'Tell', notify: { channel: 'team', message: 'done' }, next: [] },
  ] }
  save(workflow)
  // The source run needs the Jira and notify steps to have completed; mark them
  // completed by seeding the source record directly rather than calling Jira.
  runner.setAgentCaller(async slug => `output of ${slug}`)
  const src = await store.createRun({ workflowSlug: 'drytest', workflowName: 'Dry', initialPrompt: 'go', watch: 'direct-invocation', steps: workflow.steps })
  for (const s of src.steps) Object.assign(s, { status: 'completed', output: `real ${s.stepId}` })
  Object.assign(src, { status: 'completed', ticketKey: 'SUP-1', endedAt: Date.now() })
  await store.saveRun(src)

  const tj = await runner.waitForSettled((await runner.startTestRun(src.id, 'j')).id, TIMEOUT)
  assert.equal(tj.status, 'completed')
  assert.equal(tj.steps.find(s => s.stepId === 'j').output, '[Test run] Would move SUP-1 to "In Review", and post the outcome comment')
  assert.notEqual(tj.ticketCommented, true, 'no outcome comment was posted for a test run')

  const tn = await runner.waitForSettled((await runner.startTestRun(src.id, 'n')).id, TIMEOUT)
  assert.equal(tn.steps.find(s => s.stepId === 'n').output, '[Test run] Would post to team: done')
}

// ── 5. the test worktree: its own branch, from the step's start commit, removed after ──
{
  const workflow = { slug: 'wt', name: 'Wt', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ] }
  save(workflow)
  const projectDir = repo()
  runner.setAgentCaller(async (slug, _i, dir) => {
    writeFileSync(join(dir, `${slug}.txt`), slug); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', slug)
    return `output of ${slug}`
  })
  const source = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, projectDir })).id, TIMEOUT)
  const bStart = source.steps.find(s => s.stepId === 'b').headAtStart

  let testDir = null
  runner.setAgentCaller(async (slug, _i, dir) => {
    testDir = dir
    assert.equal(git(dir, 'rev-parse', 'HEAD'), bStart, 'the test starts from the commit b started from')
    assert.equal(existsSync(join(dir, 'agent-b.txt')), false, 'not from the end of the source run')
    return 'tested'
  })
  const t = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.equal(t.status, 'completed')
  assert.match(t.branch, new RegExp(`^test/${source.id.slice(0, 8)}-b-1$`))
  assert.equal(t.testOf.startPoint, bStart)
  assert.equal(t.testOf.codeNote, undefined)
  assert.ok(testDir, 'the agent ran in a directory')
  for (let i = 0; i < 50 && existsSync(testDir); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(existsSync(testDir), false, 'the test worktree is removed when the test settles')
  assert.equal(git(projectDir, 'branch', '--list', t.branch), '', 'and its branch')
  assert.notEqual(git(projectDir, 'branch', '--list', source.branch), '', 'the source run\'s branch is untouched')
}
```

Read how `store.createRun`'s input names its fields (`NewRunInput`) and adjust section 4's call to match. The assertions stay the same. If `createRun` needs steps shaped differently, build them the way `newRunInput` does.

- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement** the dry runs, `ensureTestWorktrees`, `removeTestWorktrees`, the `ensureRunCheckoutOnce` branch, and the `publish` cleanup.
- [ ] **Step 4: Run** `node scripts/test-test-run.mjs && node scripts/test-workflow-runner.mjs && node scripts/test-restart-preconditions.mjs` → all pass.
- [ ] **Step 5: Commit**

```bash
git add server/utils/workflowRunner.ts server/utils/workspace.ts scripts/test-test-run.mjs
git commit -m "feat(runs): test runs dry-run Jira, notify and loop steps on their own worktree

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The route

**Files:**
- Create: `server/api/runs/[id]/test.post.ts`
- Model it on: `server/api/runs/[id]/restart.post.ts`. Read it and follow its auth, error mapping and `startedBy`.

- [ ] **Step 1: Write the route**

```ts
import { startTestRun, TestRunError } from '../../../utils/workflowRunner'

/**
 * Run one step of a finished run again, on its own branch, with no side
 * effects: the Test tab of the builder's step drawer. `stepOverride` is the
 * drawer's current, possibly unsaved, config for that step.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'runEngine')
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ stepId?: unknown, stepOverride?: unknown }>(event)
  if (typeof body?.stepId !== 'string' || !body.stepId) throw createError({ statusCode: 400, message: 'Say which step to test.' })
  const override = body.stepOverride
  if (override !== undefined && (typeof override !== 'object' || override === null || Array.isArray(override))) {
    throw createError({ statusCode: 400, message: 'stepOverride must be an object of step fields.' })
  }
  const user = await currentUser(event)
  try {
    return await startTestRun(id, body.stepId, { stepOverride: override as Record<string, unknown> | undefined, startedBy: user?.login })
  } catch (err) {
    if (err instanceof TestRunError) throw createError({ statusCode: err.status, message: err.message })
    throw err
  }
})
```

Match `requireCapability` and `currentUser`'s import style to `restart.post.ts`. They may be auto-imported.

- [ ] **Step 2:** `npx nuxt typecheck` → 0 errors.
- [ ] **Step 3: Commit**

```bash
git add server/api/runs/[id]/test.post.ts
git commit -m "feat(runs): POST /api/runs/:id/test

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The Test tab and the Tests chip

**Files:**
- Create: `app/components/StepTestPanel.vue`
- Modify: `app/components/StepDrawer.vue` (Plan 2), `app/pages/runs/index.vue`

**`StepTestPanel.vue`**
- Props: `{ workflowSlug: string, step: WorkflowStep }`. `step` is the drawer's current, possibly unsaved, config.
- On mount, fetch `/api/runs` and keep runs where:
  - `workflowSlug` matches
  - the status is settled (not live)
  - the run has a step with this `step.id`

  Newest first. If there are none, show "Run this workflow once, then test its steps here."
- A `<select>` of those runs, labelled "Test against". Options read `#<id first 6> · <status> · <time ago>`, and the newest is selected.
- A **Test step** button, and a "Testing…" state while the request is in flight. It posts `{ stepId: step.id, stepOverride: omit(step, ['id', 'next', 'position']) }` to `/api/runs/<selected>/test`. A server error shows its `message` as a toast. On success, keep the returned run's id.
- **Result,** via `useRun(testRunId)` (live over SSE) once a test has started:
  - a status pill from `RUN_STATUS_COLOR`
  - the tested step's monitor verdict, when present
  - the `produces` files it declared, and the step's `LogLines` tail (last 20 lines)
  - tokens and `usd` from the step's `usage`
  - `testOf.codeNote` in `var(--warning)`, when set
  - a link, "Open test run", to `/runs/<id>`
- Only for `can('runEngine')`. Otherwise show "Testing a step needs permission to run the pipeline."

**`StepDrawer.vue`:** add a third tab, **Test**, rendering `<StepTestPanel :workflow-slug :step />`. Add a `workflowSlug` prop, and pass it from the page (Plan 2's `[slug].vue`). The page must pass the step as the drawer currently has it, unsaved edits included.

**`runs/index.vue`:**
- Add a `{ value: 'tests', label: 'Tests' }` view.
- `refresh()` fetches `/api/runs?tests=1` when `view === 'tests'` and `/api/runs` otherwise. Watch `view` so switching refetches.
- `matchesView(r, 'tests')` is `isTestRun(r)`.
- Test rows show "Test of #<source first 6>" as their title prefix.

- [ ] **Step 1: Build all three.**
- [ ] **Step 2:** `npx nuxt typecheck` → 0 errors.
- [ ] **Step 3: Check it in a browser.** Use a throwaway `/tmp` Playwright script, with a seeded disposable `CLAUDE_DIR` and a real tmp git repo as `projectDir`. Stub the agents the way the smokes do, or seed a finished source run whose steps have `headAtStart`. Take screenshots into the plan workspace's `shots/task-5/`, and check:
  - Open the builder, select a step, go to Test, choose the run, and press Test step. The result shows a completed status and a link.
  - The test run doesn't appear under "All" on `/runs`, and does appear under "Tests".
  - A reviewer role sees the permission message.
- [ ] **Step 4: Commit**

```bash
git add app/components/StepTestPanel.vue app/components/StepDrawer.vue app/pages/runs/index.vue app/pages/workflows/[slug].vue
git commit -m "feat(workflows): test a step from the builder; Tests view on /runs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation and spec corrections

- [ ] **Step 1: Spec §4.** Record, in the spec's plain style:
  - **The marker.** A test run is marked by `testOf { sourceRunId, stepId, stepOverride, startPoint, codeNote }`, not `origin: 'test'` and `parentRunId`. `origin` already records where a defect was found and routes the base branch. `parentRunId` is loop-step lineage.
  - **Other steps.** Steps that are neither before nor the tested step are skipped as "Not part of this test".
  - **Nested repositories.** They start from the source run's branch, and only the root repository uses `headAtStart`.
  - **Filtering.** `GET /api/runs` leaves test runs out unless `?tests=1` is passed.
  - **What a test doesn't do.** It posts no finished-run Jira comment and sends no channel notification.
  - **Cleanup.** The worktree and branch are removed when the test settles, and only `test/` branches can be removed this way.
- [ ] **Step 2: `CLAUDE.md`.** In the Run stack paragraph, add: "A test run (`startTestRun`, `POST /api/runs/:id/test`) runs one step against a finished run's outputs on a `test/` worktree; it carries `testOf`, stops after that step (`stopAfter`), dry-runs Jira/notify/loop steps, and is left out of `/api/runs` (unless `?tests=1`), group slots, notifications and the watch dispatch check."
- [ ] **Step 3: Full verification.**
  - `npx nuxt typecheck` → 0
  - the full plain-node suite → only the known baseline FAILs
  - the smokes `awaiting-review`, `notifications` and `workflow-builder` (from Plan 2) pass
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-24-workflow-run-stack-design.md
git commit -m "docs: test a step

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
