# Workflow Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll a ticket source every N seconds and start a workflow run for each new ticket, without ever wedging on a ticket whose run fails.

**Architecture:** A pluggable `TicketSource` (stub first, Jira later) feeds a scheduler. Per-**ticket** state — not per-run — decides eligibility, so a failed ticket is recorded and stepped over rather than retried forever or blocking the queue. Three attempts, then escalated and never picked up again.

**Tech Stack:** Nuxt 3 / Nitro (server plugin for the interval), Node 24. No test framework: plain `node:assert/strict` scripts under `scripts/`.

**Spec:** `docs/superpowers/specs/2026-09-03-workflow-watcher-design.md`

## Global Constraints

- **Depends on server-side workflow runs** (`docs/superpowers/plans/2026-09-03-server-side-workflow-runs.md`). The watcher starts runs through that API. Do not begin until it is merged and its Task 7 passes.
- **`bun` is NOT installed.** Use `npm`. Typecheck with a pinned vue-tsc (`.superpowers/sdd/*/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js`, or create one: `npm install --no-save typescript@5.9.3 vue-tsc@3.3.11`). ONE pre-existing error is expected and is NOT yours: `scripts/test-workflow-graph.mjs(54,1): error TS1005: '=>' expected.`
- **Port 3030 is a RUNNING PRODUCTION CONTAINER.** Never use or stop it. Dev server: `npx nuxt dev --port 3031` (NOT `PORT=3031 npm run dev` — package.json hardcodes `--port 3030`). Stop it with a **targeted PID kill, never a broad `pkill`**.
- **Persistence root is `CLAUDE_DIR`** via `resolveClaudePath` — never a hardcoded `~/.claude`. Tests must set `CLAUDE_DIR` to a temp dir and must not touch the real one.
- **Relative imports between `server/` and `shared/` carry explicit `.ts` extensions.**
- **A new watch starts disabled.** Enabling is an explicit act, so a mistyped query cannot dispatch on its first tick.
- **Three attempts, then escalate.** No unbounded retry anywhere.

---

### Task 1: Watch types and per-ticket state store

**Files:**
- Create: `shared/types/watch.ts`
- Create: `server/utils/watchStateStore.ts`
- Test: `scripts/test-watch-state-store.mjs`

**Interfaces:**
- Consumes: `resolveClaudePath` from `server/utils/claudeDir.ts`.
- Produces: types `Watch`, `TicketRef`, `TicketState`, `TicketDisposition`; and
  `getWatchState(watchId): Promise<Record<string, TicketState>>`,
  `saveTicketState(state: TicketState): Promise<void>`,
  `recordDispatch(watchId, key, runId): Promise<TicketState>`,
  `recordFailure(watchId, key, reason, maxAttempts): Promise<TicketState>`,
  `recordSuccess(watchId, key): Promise<TicketState>`,
  `clearEscalation(watchId, key): Promise<TicketState | null>`,
  `MAX_ATTEMPTS = 3`.

- [ ] **Step 1: Write the types**

Create `shared/types/watch.ts`:

```ts
export type TicketDisposition =
  | 'new'         // seen, not yet dispatched
  | 'dispatched'  // a run is in flight for it
  | 'done'        // its run completed
  | 'failed'      // its run failed, attempts remain
  | 'escalated'   // attempts exhausted — never picked up again

export interface TicketRef {
  key: string
  summary: string
  description: string
  updatedAt: number
}

export interface TicketState {
  key: string
  watchId: string
  disposition: TicketDisposition
  attempts: number
  lastRunId?: string
  lastError?: string
  firstSeenAt: number
  updatedAt: number
}

export interface Watch {
  id: string
  /** Human label for the operator view. */
  name: string
  /** Which workflow to run for a ticket this watch picks up. */
  workflowSlug: string
  intervalSeconds: number
  /** New watches start disabled: a mistyped query must not dispatch on tick one. */
  enabled: boolean
  maxConcurrentRuns: number
  dailyDispatchCap: number
  /** Opaque to the scheduler; the source interprets it. */
  query?: string
  projectDir?: string
  autoRun: boolean
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test-watch-state-store.mjs`:

```js
/**
 * Self-check for the per-ticket state store — the thing that stops one bad
 * ticket from wedging the queue.
 *
 *   node scripts/test-watch-state-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'watchstate-'))
const store = await import('../server/utils/watchStateStore.ts')

// ── 1. Unknown ticket has no state ────────────────────────────────────────
assert.deepEqual(await store.getWatchState('w1'), {})

// ── 2. Dispatch records it, so a second poll cannot pick it up again ──────
const d = await store.recordDispatch('w1', 'CSUP-1', 'run-1')
assert.equal(d.disposition, 'dispatched')
assert.equal(d.lastRunId, 'run-1')
assert.equal(d.attempts, 1, 'a dispatch is an attempt')

// ── 3. It survives a reload ───────────────────────────────────────────────
const reloaded = await store.getWatchState('w1')
assert.equal(reloaded['CSUP-1'].disposition, 'dispatched')

// ── 4. Success is terminal ────────────────────────────────────────────────
await store.recordSuccess('w1', 'CSUP-1')
assert.equal((await store.getWatchState('w1'))['CSUP-1'].disposition, 'done')

// ── 5. Failure below the cap stays eligible ───────────────────────────────
await store.recordDispatch('w1', 'CSUP-2', 'run-2')
const f1 = await store.recordFailure('w1', 'CSUP-2', 'stack would not come up', store.MAX_ATTEMPTS)
assert.equal(f1.disposition, 'failed', 'one failure is not an escalation')
assert.equal(f1.attempts, 1)
assert.match(f1.lastError, /stack would not come up/)

// ── 6. The third failure escalates, and that is permanent ─────────────────
await store.recordDispatch('w1', 'CSUP-2', 'run-3')
await store.recordFailure('w1', 'CSUP-2', 'again', store.MAX_ATTEMPTS)
await store.recordDispatch('w1', 'CSUP-2', 'run-4')
const f3 = await store.recordFailure('w1', 'CSUP-2', 'and again', store.MAX_ATTEMPTS)
assert.equal(f3.attempts, 3)
assert.equal(f3.disposition, 'escalated',
  'at MAX_ATTEMPTS the ticket is escalated so it can never block the queue')

// ── 7. Escalation is cleared only deliberately ────────────────────────────
const cleared = await store.clearEscalation('w1', 'CSUP-2')
assert.equal(cleared.disposition, 'new', 'clearing makes it eligible again')
assert.equal(cleared.attempts, 0, 'and resets the attempt count')
assert.equal(await store.clearEscalation('w1', 'NOPE'), null, 'clearing an unknown ticket is null')

// ── 8. Watches are isolated from each other ───────────────────────────────
await store.recordDispatch('w2', 'CSUP-1', 'run-9')
assert.equal((await store.getWatchState('w1'))['CSUP-1'].disposition, 'done')
assert.equal((await store.getWatchState('w2'))['CSUP-1'].disposition, 'dispatched')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('watchStateStore: all assertions passed')
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node scripts/test-watch-state-store.mjs`
Expected: FAIL — cannot resolve `../server/utils/watchStateStore.ts`.

- [ ] **Step 4: Implement the store**

Create `server/utils/watchStateStore.ts`. Persist one JSON file per watch at
`resolveClaudePath('watch-state', `${watchId}.json`)`, holding a
`Record<ticketKey, TicketState>`. Mirror `workflowRunStore.ts`'s shape: ensure the
directory, read-with-try/catch returning `{}` on corruption, write the whole map.

`recordDispatch` sets `disposition: 'dispatched'`, `lastRunId`, and increments
`attempts`. `recordFailure` sets `lastError` and, when `attempts >= maxAttempts`,
sets `escalated`; otherwise `failed`. `recordSuccess` sets `done`.
`clearEscalation` resets to `new` with `attempts: 0`, returning `null` when the
ticket is unknown.

- [ ] **Step 5: Run the test until it passes**

Run: `node scripts/test-watch-state-store.mjs`
Expected: `watchStateStore: all assertions passed`

- [ ] **Step 6: Commit**

```bash
git add shared/types/watch.ts server/utils/watchStateStore.ts scripts/test-watch-state-store.mjs
git commit -m "feat: per-ticket watch state so a failed ticket cannot wedge the queue"
```

---

### Task 2: The ticket source seam and its stub

**Files:**
- Create: `server/utils/ticketSource.ts`
- Test: `scripts/test-ticket-source.mjs`

**Interfaces:**
- Consumes: `Watch`, `TicketRef` from Task 1.
- Produces: `interface TicketSource { fetch(watch: Watch): Promise<TicketRef[]> }`,
  `createFileTicketSource(): TicketSource`, `setTicketSource(s: TicketSource): void`,
  `getTicketSource(): TicketSource`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-ticket-source.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ticketsrc-'))
const { createFileTicketSource, setTicketSource, getTicketSource } =
  await import('../server/utils/ticketSource.ts')

const watch = {
  id: 'w1', name: 'W1', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 2, dailyDispatchCap: 10, autoRun: false,
}

// ── 1. No file yet → no tickets, never an error ───────────────────────────
const src = createFileTicketSource()
assert.deepEqual(await src.fetch(watch), [], 'a missing ticket file is empty, not fatal')

// ── 2. Tickets are read from disk ─────────────────────────────────────────
mkdirSync(join(process.env.CLAUDE_DIR, 'watch-tickets'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'watch-tickets', 'w1.json'), JSON.stringify([
  { key: 'CSUP-1', summary: 'one', description: 'first', updatedAt: 1 },
  { key: 'CSUP-2', summary: 'two', description: 'second', updatedAt: 2 },
]))
const tickets = await src.fetch(watch)
assert.equal(tickets.length, 2)
assert.equal(tickets[0].key, 'CSUP-1')

// ── 3. Malformed content is empty, not a crash ────────────────────────────
writeFileSync(join(process.env.CLAUDE_DIR, 'watch-tickets', 'w1.json'), 'not json')
assert.deepEqual(await src.fetch(watch), [], 'a broken source file must not stop the scheduler')

// ── 4. The seam is swappable — this is how Jira arrives later ─────────────
setTicketSource({ fetch: async () => [{ key: 'X-1', summary: 's', description: 'd', updatedAt: 0 }] })
assert.equal((await getTicketSource().fetch(watch))[0].key, 'X-1')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('ticketSource: all assertions passed')
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/test-ticket-source.mjs` — expected FAIL, module missing.

- [ ] **Step 3: Implement**

Create `server/utils/ticketSource.ts`. The file source reads
`resolveClaudePath('watch-tickets', `${watch.id}.json`)`, returning `[]` when the
file is absent, unreadable or not a JSON array. A module-level `current` source
defaults to the file source; `setTicketSource` replaces it.

Document at the top **why** the seam exists: the app has no Jira integration and
the Atlassian MCP is bound to an interactive session rather than this server
process, so the loop is built and tested against a stub and Jira slots in later
without redesign.

- [ ] **Step 4: Run the test until it passes**

- [ ] **Step 5: Commit**

```bash
git add server/utils/ticketSource.ts scripts/test-ticket-source.mjs
git commit -m "feat: pluggable ticket source with a file-backed stub"
```

---

### Task 3: The scheduler — where failure isolation lives

**Files:**
- Create: `server/utils/watchScheduler.ts`
- Test: `scripts/test-watch-scheduler.mjs`

**Interfaces:**
- Consumes: Tasks 1 and 2; `findActiveRun` from `server/utils/workflowRunStore.ts`.
- Produces: `runCycle(watch: Watch): Promise<CycleResult>` where
  `CycleResult = { dispatched: string[], skipped: string[], failed: string[] }`;
  `setRunStarter(fn: RunStarter): void` with
  `RunStarter = (watch: Watch, ticket: TicketRef) => Promise<{ runId: string }>`;
  `startScheduler(): void`, `stopScheduler(): void`.

- [ ] **Step 1: Write the failing test — the isolation case is the point**

Create `scripts/test-watch-scheduler.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'sched-'))
const sched = await import('../server/utils/watchScheduler.ts')
const { setTicketSource } = await import('../server/utils/ticketSource.ts')
const store = await import('../server/utils/watchStateStore.ts')

const watch = {
  id: 'w1', name: 'W1', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 10, dailyDispatchCap: 100, autoRun: false,
}
const t = (key) => ({ key, summary: key, description: key, updatedAt: 1 })

// ══ THE REQUIREMENT: one poisoned ticket must not cost the others ═════════
{
  setTicketSource({ fetch: async () => [t('BAD-1'), t('OK-1'), t('OK-2')] })
  let n = 0
  sched.setRunStarter(async (_w, ticket) => {
    if (ticket.key === 'BAD-1') throw new Error('dispatch exploded')
    return { runId: `run-${++n}` }
  })

  const result = await sched.runCycle(watch)
  assert.deepEqual(result.failed, ['BAD-1'])
  assert.deepEqual(result.dispatched.sort(), ['OK-1', 'OK-2'],
    'the two healthy tickets dispatched even though the FIRST one threw')

  const state = await store.getWatchState('w1')
  assert.equal(state['BAD-1'].disposition, 'failed')
  assert.equal(state['OK-1'].disposition, 'dispatched')
}

// ── Dedupe: an already-dispatched ticket is not picked up again ───────────
{
  const result = await sched.runCycle(watch)
  assert.equal(result.dispatched.length, 0, 'nothing re-dispatches on the next cycle')
  assert.ok(result.skipped.includes('OK-1'))
}

// ── Escalation: three failures, then permanently skipped ──────────────────
{
  setTicketSource({ fetch: async () => [t('BAD-1')] })
  sched.setRunStarter(async () => { throw new Error('still broken') })
  await sched.runCycle(watch)   // attempt 2
  await sched.runCycle(watch)   // attempt 3 -> escalated
  const state = await store.getWatchState('w1')
  assert.equal(state['BAD-1'].disposition, 'escalated')

  const after = await sched.runCycle(watch)
  assert.equal(after.failed.length, 0, 'an escalated ticket is never attempted again')
  assert.ok(after.skipped.includes('BAD-1'))
}

// ── A disabled watch does nothing at all ──────────────────────────────────
{
  setTicketSource({ fetch: async () => [t('NEW-1')] })
  sched.setRunStarter(async () => ({ runId: 'r' }))
  const result = await sched.runCycle({ ...watch, enabled: false })
  assert.equal(result.dispatched.length, 0, 'a disabled watch never dispatches')
}

// ── The concurrency cap defers rather than drops ──────────────────────────
{
  setTicketSource({ fetch: async () => [t('C-1'), t('C-2'), t('C-3')] })
  sched.setRunStarter(async () => ({ runId: 'r' }))
  const capped = await sched.runCycle({ ...watch, id: 'w2', maxConcurrentRuns: 2 })
  assert.equal(capped.dispatched.length, 2, 'only up to the cap dispatches')
  assert.equal(capped.skipped.length, 1, 'the rest wait for the next cycle, not dropped')
}

// ── A source that throws fails the cycle quietly, not the process ─────────
{
  setTicketSource({ fetch: async () => { throw new Error('source down') } })
  const result = await sched.runCycle({ ...watch, id: 'w3' })
  assert.deepEqual(result.dispatched, [], 'a broken source yields nothing')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('watchScheduler: all assertions passed')
```

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Implement the scheduler**

Create `server/utils/watchScheduler.ts`. `runCycle`:

1. Return an empty result immediately when `watch.enabled` is false.
2. `getTicketSource().fetch(watch)` inside try/catch — a source failure yields an
   empty cycle, never a thrown error.
3. Load watch state; drop tickets whose disposition is `dispatched`, `done` or
   `escalated` into `skipped`.
4. Apply `maxConcurrentRuns` (counting currently `dispatched` tickets) and
   `dailyDispatchCap`; overflow goes to `skipped`, not dropped.
5. **For each remaining ticket, in its own try/catch:**

```ts
for (const ticket of eligible) {
  try {
    const { runId } = await starter(watch, ticket)
    await recordDispatch(watch.id, ticket.key, runId)
    dispatched.push(ticket.key)
  } catch (err) {
    // Isolation: this ticket's failure costs this ticket, not the cycle.
    await recordFailure(watch.id, ticket.key,
      err instanceof Error ? err.message : String(err), MAX_ATTEMPTS)
    failed.push(ticket.key)
  }
}
```

`startScheduler`/`stopScheduler` manage a `setInterval` per enabled watch. Never
let a cycle's rejection escape — wrap the tick body too.

- [ ] **Step 4: Run the test until it passes**

- [ ] **Step 5: Commit**

```bash
git add server/utils/watchScheduler.ts scripts/test-watch-scheduler.mjs
git commit -m "feat: watch scheduler with per-ticket failure isolation"
```

---

### Task 4: Reconciliation, watch config, and the server plugin

**Files:**
- Create: `server/utils/watchConfig.ts`
- Modify: `server/utils/watchScheduler.ts` (add `reconcile`)
- Create: `server/plugins/watcher.ts`
- Test: extend `scripts/test-watch-scheduler.mjs`

**Interfaces:**
- Consumes: `getRun` from `server/utils/workflowRunStore.ts`.
- Produces: `listWatches()`, `saveWatch(w: Watch)`, `getWatch(id)`; and
  `reconcile(watch: Watch): Promise<void>` which resolves `dispatched` tickets
  whose runs have reached a terminal state.

- [ ] **Step 1: Reconciliation test**

Add to `scripts/test-watch-scheduler.mjs`: a ticket recorded as `dispatched` with
a `lastRunId` whose run is `completed` becomes `done` after `reconcile`; one whose
run is `failed` becomes `failed` with its attempt counted; one whose run is still
`running` is left `dispatched`. Create the runs through `workflowRunStore`'s
`createRun`/`saveRun` so the test exercises the real store.

Reconciliation must run at the **start** of a cycle, so a run that finished while
the app was down is still accounted for.

- [ ] **Step 2: Implement `reconcile` and watch config**

`watchConfig.ts` persists watches at `resolveClaudePath('watches.json')`, defaulting
to `[]`. `saveWatch` forces `enabled: false` for a watch id that does not already
exist — a new watch must never dispatch on its first tick.

- [ ] **Step 3: The server plugin**

Create `server/plugins/watcher.ts` calling `startScheduler()` on nitro startup.
Guard it so tests and CI do not start real timers — e.g. skip when
`process.env.WATCHER_DISABLED === '1'` — and say in your report how you verified
the guard works.

- [ ] **Step 4: Run all tests and typecheck**

```bash
node scripts/test-watch-state-store.mjs
node scripts/test-ticket-source.mjs
node scripts/test-watch-scheduler.mjs
node scripts/test-workflow-run-store.mjs
node scripts/test-workflow-runner.mjs
node scripts/test-workflow-graph.mjs
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/watchConfig.ts server/utils/watchScheduler.ts server/plugins/watcher.ts scripts/test-watch-scheduler.mjs
git commit -m "feat: reconcile dispatched tickets and start the watcher with the server"
```

---

### Task 5: API and the operator view

**Files:**
- Create: `server/api/watches/index.get.ts`, `index.post.ts`, `[id]/state.get.ts`, `[id]/poll.post.ts`, `[id]/tickets/[key]/clear.post.ts`
- Create: `app/pages/watches.vue`
- Create: `app/composables/useWatches.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: the operator surface — what is watched, what was picked up, what escalated and why.

- [ ] **Step 1: The endpoints**

`GET /api/watches` lists watches. `POST /api/watches` creates or updates one
(new watches forced disabled). `GET /api/watches/[id]/state` returns the ticket
state map. `POST /api/watches/[id]/poll` forces one cycle immediately — the way
an operator tests a watch without waiting for the interval.
`POST /api/watches/[id]/tickets/[key]/clear` clears an escalation.

- [ ] **Step 2: The page**

`app/pages/watches.vue`: one card per watch — name, workflow, interval, enabled
toggle, and counts by disposition. Expanding shows tickets grouped by
disposition, with **escalated tickets first and their `lastError` visible**, plus
a "clear escalation" action. An escalated ticket that a human cannot see is a
silently dropped ticket.

- [ ] **Step 3: Verify against a dev server**

Start `npx nuxt dev --port 3031`. Create a watch, drop a ticket file at
`~/.claude/watch-tickets/<id>.json`, force a poll, and confirm the ticket appears
as dispatched with a real run id. Report actual output. Stop the dev server with
a targeted PID kill.

- [ ] **Step 4: Commit**

```bash
git add server/api/watches app/pages/watches.vue app/composables/useWatches.ts
git commit -m "feat: watches API and operator view"
```

---

### Task 6: End-to-end — the requirement, demonstrated

**Files:** none. Verification only.

- [ ] **Step 1: Every test plus typecheck**

- [ ] **Step 2: Demonstrate isolation with real runs**

With a dev server on 3031 and a real workflow:
1. Create a watch pointing at it, enabled, interval 30s.
2. Write three tickets to the source file, where the first names a workflow slug
   that does not exist (so its dispatch fails).
3. Wait for one cycle.

Expected: ticket 1 is `failed` with a reason; tickets 2 and 3 are `dispatched`
with run ids. **This is the requirement in one observation** — a poisoned ticket
at the head of the queue costs itself and nothing else.

- [ ] **Step 3: Demonstrate escalation**

Leave the broken ticket in place across three cycles. Expected: `escalated`, with
the attempt log visible on the watches page, and absent from the fourth cycle's
dispatch set.

- [ ] **Step 4: Report** what passed, what did not, and anything verified by
reading code rather than observing. Stop the dev server.
