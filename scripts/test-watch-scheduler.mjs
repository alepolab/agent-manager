/**
 * Self-check for the watch scheduler — the piece that makes the user's
 * requirement literally true: "if it fails at some stage the next run
 * should pick up the other jiras, don't stuck at the failed ones."
 *
 *   node scripts/test-watch-scheduler.mjs
 */
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
const t = (key) => ({ key, summary: key, description: key, updatedAt: 1 });

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

// ══ THE ACCEPTANCE CRITERION: a dispatch that always throws must escalate
//    after exactly 3 cycles and disappear from the 4th cycle's dispatch set,
//    instead of being retried forever (the defect in the brief's example).
//    Isolated on its own watch id / ticket source so it does not inherit
//    attempt count from the isolation and dedupe blocks above. ══════════════
{
  const escWatch = { ...watch, id: 'w-escalation' }
  setTicketSource({ fetch: async () => [t('BAD-ESC')] })
  sched.setRunStarter(async () => { throw new Error('still broken') })

  const c1 = await sched.runCycle(escWatch) // attempt 1
  assert.deepEqual(c1.failed, ['BAD-ESC'])
  let state = await store.getWatchState('w-escalation')
  assert.equal(state['BAD-ESC'].attempts, 1)
  assert.equal(state['BAD-ESC'].disposition, 'failed', 'not escalated until MAX_ATTEMPTS')

  const c2 = await sched.runCycle(escWatch) // attempt 2
  assert.deepEqual(c2.failed, ['BAD-ESC'])
  state = await store.getWatchState('w-escalation')
  assert.equal(state['BAD-ESC'].attempts, 2)
  assert.equal(state['BAD-ESC'].disposition, 'failed', 'still not escalated at 2 attempts')

  const c3 = await sched.runCycle(escWatch) // attempt 3 -> escalated
  assert.deepEqual(c3.failed, ['BAD-ESC'])
  state = await store.getWatchState('w-escalation')
  assert.equal(state['BAD-ESC'].attempts, 3, 'exactly 3 attempts were counted')
  assert.equal(state['BAD-ESC'].disposition, 'escalated', 'escalated after exactly 3 cycles')

  const c4 = await sched.runCycle(escWatch) // 4th cycle: never attempted again
  assert.equal(c4.failed.length, 0, 'an escalated ticket is never attempted again')
  assert.equal(c4.dispatched.length, 0,
    'BAD-ESC is absent from the 4th cycle\'s dispatch set')
  assert.ok(c4.skipped.includes('BAD-ESC'))
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
