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
const runStore = await import('../server/utils/workflowRunStore.ts')

/** A run record via the real store, its outcome overridden for the test. */
async function makeRun(overrides = {}) {
  const run = await runStore.createRun({
    workflowSlug: 'demo', workflowName: 'Demo', autoRun: false,
    initialPrompt: 'do the thing', steps: [],
  })
  const next = { ...run, ...overrides }
  await runStore.saveRun(next)
  return next
}

const watch = {
  id: 'w1', name: 'W1', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 10, dailyDispatchCap: 100, autoRun: false,
}
const t = (key) => ({ key, summary: key, description: key, updatedAt: 1 });

// ══ THE REQUIREMENT: one poisoned ticket must not cost the others ═════════
{
  setTicketSource({ fetch: async () => [t('BAD-1'), t('OK-1'), t('OK-2')] })
  sched.setRunStarter(async (_w, ticket) => {
    if (ticket.key === 'BAD-1') throw new Error('dispatch exploded')
    // A real run record (still 'running', owned by this alive process) so
    // the next cycle's start-of-cycle reconcile leaves it dispatched rather
    // than reading a fabricated id as a missing/lost run record.
    const run = await makeRun()
    return { runId: run.id }
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

// ══ Reconciliation: dispatched tickets resolved against real run outcomes ══
// Runs are created through workflowRunStore's real createRun/saveRun so this
// exercises the actual store — not a mock of "what a run looks like".
{
  const rWatch = { ...watch, id: 'w-reconcile' }

  const runDone = await makeRun({ status: 'completed' })
  await store.recordAttempt(rWatch.id, 'REC-DONE')
  await store.recordDispatch(rWatch.id, 'REC-DONE', runDone.id)

  const runFailed = await makeRun({ status: 'failed', error: 'boom' })
  await store.recordAttempt(rWatch.id, 'REC-FAIL')
  await store.recordDispatch(rWatch.id, 'REC-FAIL', runFailed.id)

  // createRun leaves status 'running' owned by this process's own pid, so it
  // reads back as genuinely still running (the owning process is alive).
  const runLive = await makeRun()
  await store.recordAttempt(rWatch.id, 'REC-LIVE')
  await store.recordDispatch(rWatch.id, 'REC-LIVE', runLive.id)

  // The run record that would prove REC-GONE's outcome is deleted outright —
  // simulating a lost/corrupted file, not just an unknown id.
  const runGone = await makeRun()
  await store.recordAttempt(rWatch.id, 'REC-GONE')
  await store.recordDispatch(rWatch.id, 'REC-GONE', runGone.id)
  rmSync(join(process.env.CLAUDE_DIR, 'workflow-runs', `${runGone.id}.json`), { force: true })

  await sched.reconcile(rWatch)

  const state = await store.getWatchState(rWatch.id)
  assert.equal(state['REC-DONE'].disposition, 'done', 'a completed run resolves to done')

  assert.equal(state['REC-FAIL'].disposition, 'failed', 'a failed run resolves to failed')
  assert.equal(state['REC-FAIL'].attempts, 1,
    'the attempt already counted at dispatch time is preserved, not re-counted by reconcile')

  assert.equal(state['REC-LIVE'].disposition, 'dispatched', 'a still-running run is left alone')

  // Decision: a missing run record is treated as a failed attempt, not left
  // `dispatched` forever and not thrown. There is no way to tell "still
  // genuinely running" apart from "evidence destroyed" once the file backing
  // it is gone, so it goes back through the same failed/escalate path a real
  // failure would, using the attempt already counted at dispatch time — it
  // becomes eligible for one more, verifiable attempt next cycle instead of
  // sitting in limbo indefinitely.
  assert.equal(state['REC-GONE'].disposition, 'failed',
    'a missing run record resolves to failed rather than hanging, throwing, or staying dispatched forever')
  assert.equal(state['REC-GONE'].attempts, 1, 'reconciling a missing record is not itself a new attempt')
}

// ── reconcile runs at the START of runCycle, in the same cycle it frees a
//    ticket back up — not just as a standalone function nobody calls ───────
{
  const cycleWatch = { ...watch, id: 'w-reconcile-cycle' }
  const staleRun = await makeRun({ status: 'failed', error: 'died while the app was down' })
  await store.recordAttempt(cycleWatch.id, 'CYC-1')
  await store.recordDispatch(cycleWatch.id, 'CYC-1', staleRun.id)

  setTicketSource({ fetch: async () => [t('CYC-1')] })
  sched.setRunStarter(async () => ({ runId: 'run-cyc-retry' }))

  const result = await sched.runCycle(cycleWatch)
  assert.deepEqual(result.dispatched, ['CYC-1'],
    'reconcile freed CYC-1 back to failed before eligibility was computed, so this same cycle re-dispatched it')

  const state = await store.getWatchState(cycleWatch.id)
  assert.equal(state['CYC-1'].disposition, 'dispatched')
  assert.equal(state['CYC-1'].attempts, 2, 'the retry is a genuinely new attempt on top of the one already counted')
}

// ══ THE PART 1 FIX: a watch enabled AFTER `startScheduler()` has already
//    run must still poll on its own timer, and a disabled watch must stop
//    polling — without a server restart. `startScheduler` used to read the
//    watch list exactly once at boot; this drives real timers (a fast
//    supervisor cadence, not a mocked one) and asserts on the OBSERVED
//    effect of polling — the run starter actually being invoked by a timer
//    firing on its own — not on a function having been called synchronously. ══
{
  let autoWatches = [] // mutated below to simulate watches.json changing under the scheduler
  sched.setWatchSource(() => autoWatches)

  let ticketCounter = 0
  setTicketSource({
    fetch: async (w) => {
      if (w.id !== 'w-auto') return []
      // A fresh ticket key every fetch so each tick has something new and
      // eligible to dispatch — isolates "did the timer fire" from dedupe.
      ticketCounter++
      return [t(`AUTO-${ticketCounter}`)]
    },
  })

  const starterCalls = []
  sched.setRunStarter(async (_w, ticket) => {
    starterCalls.push(ticket.key)
    const run = await makeRun()
    return { runId: run.id }
  })

  // Scheduler starts with NOTHING enabled — mirrors a server that booted
  // before this watch existed, or before it was ever enabled.
  sched.startScheduler(50) // fast supervisor cadence so the test doesn't wait on a production interval

  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(starterCalls.length, 0, 'nothing polls before any watch exists')

  // The watch is created and enabled AFTER the scheduler already started —
  // exactly the gap T5 found: `saveWatch` writing this has no way to touch
  // a timer that was set up once at boot.
  autoWatches = [{ ...watch, id: 'w-auto', enabled: true, intervalSeconds: 1 }]

  // Long enough for the supervisor (50ms) to pick up the new watch and for
  // its own 1s timer to fire at least twice, with margin.
  await new Promise(resolve => setTimeout(resolve, 3500))
  const afterEnable = starterCalls.length
  assert.ok(afterEnable >= 2,
    `a watch enabled after startScheduler() must poll on its own timer without a restart (observed ${afterEnable} dispatch attempts, wanted >= 2)`)

  // Disabling must stop the timer itself, not just skip dispatch inside
  // runCycle (which already returns early for a disabled watch, but that's
  // not what's being proven here — the timer must not even fire).
  autoWatches = [{ ...watch, id: 'w-auto', enabled: false, intervalSeconds: 1 }]
  await new Promise(resolve => setTimeout(resolve, 200)) // let the supervisor tear the timer down
  const atDisable = starterCalls.length
  await new Promise(resolve => setTimeout(resolve, 1500)) // longer than one full 1s interval
  assert.equal(starterCalls.length, atDisable,
    'a disabled watch stops polling — its timer was torn down, not just its dispatch skipped')

  sched.stopScheduler()
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('watchScheduler: all assertions passed')
