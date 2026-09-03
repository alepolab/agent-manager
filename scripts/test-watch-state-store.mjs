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
