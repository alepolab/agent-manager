/**
 * The run clock: how long a run has actually been executing.
 *
 *   node scripts/test-run-clock.mjs
 *
 * The defect this guards is the one a user reported from the runs page. A run
 * that failed, sat overnight and was then restarted showed "73m" against
 * twelve minutes of agent work — the Duration column was
 * `endedAt - startedAt`, and a restart resumes the same run id, so the hours
 * it spent waiting for a person were being reported as run time.
 *
 * Every case below is a way of getting that wrong while still rendering a
 * plausible number: charging the gap, charging a person's thinking time,
 * letting a dead run's timer tick forever, or losing the time an earlier
 * attempt genuinely spent working.
 */
import assert from 'node:assert/strict'
import {
  runElapsedMs, runElapsedMinutes, startRunClock, settleRunClock, reconcileRunClock, lastKnownActivity,
} from '../shared/utils/runClock.ts'

const MIN = 60_000
const T0 = 1_700_000_000_000

/** A run record as the store writes it, with the clock fields under test.
 *  A declaration, not an arrow returning an object literal: the cases below
 *  are bare blocks, and `=> ({...})` followed by `{` reads to the TypeScript
 *  parser (bun run typecheck covers scripts/) as an arrow parameter list. */
function rec(over = {}) {
  return { status: 'running', startedAt: T0, activeMs: 0, runningSince: T0, steps: [], ...over }
}

// ── A run in flight measures to now ───────────────────────────────────────
{
  const r = rec()
  assert.equal(runElapsedMs(r, T0 + 5 * MIN), 5 * MIN, 'a running run counts up')
  assert.equal(runElapsedMinutes(r, T0 + 5 * MIN), 5, 'minutes are the same figure')
}

// ── The reported defect: the gap before a restart is not run time ──────────
//
// Ten minutes of work, a failure, eight hours failed on disk, then a restart
// that works two more minutes. The run took twelve minutes. The subtraction
// this replaces would say eight hours and twelve minutes.
{
  const r = rec()
  // The failure publishes a settled status; the clock closes at endedAt.
  r.status = 'failed'
  r.endedAt = T0 + 10 * MIN
  settleRunClock(r, T0 + 10 * MIN)
  assert.equal(r.activeMs, 10 * MIN, 'the first attempt banked its ten minutes')
  assert.equal(r.runningSince, undefined, 'and the clock is stopped')

  // Eight hours later, nothing has moved.
  const restartAt = T0 + 8 * 60 * MIN
  assert.equal(runElapsedMs(r, restartAt), 10 * MIN, 'a failed run does not keep counting')

  // The operator restarts. endedAt is cleared and a new stretch opens.
  reconcileRunClock(r) // no-op: nothing open
  r.status = 'running'
  r.endedAt = undefined
  startRunClock(r, restartAt)
  assert.equal(runElapsedMs(r, restartAt + 2 * MIN), 12 * MIN,
    'the restart adds its own two minutes, not the eight hours the run sat failed')
  assert.ok(restartAt + 2 * MIN - r.startedAt > 8 * 60 * MIN,
    'the wall clock really is over eight hours - the point is that duration is not')
}

// ── Restarting is idempotent: a wave publishes `running` many times ────────
{
  const r = rec()
  startRunClock(r, T0 + MIN)
  startRunClock(r, T0 + 2 * MIN)
  assert.equal(r.runningSince, T0, 'an open stretch is never restarted, or the clock would reset each publish')
}

// ── A person's thinking time is not the run working ───────────────────────
//
// The run worked for three minutes and then paused for an answer. The three
// minutes count; the wait does not. settleRunClock is what publish() calls,
// and it closes at `now` because this process did the work and knows when it
// stopped - the dead-owner cap belongs to reconcileRunClock alone.
{
  const r = rec()
  r.status = 'paused'
  settleRunClock(r, T0 + 3 * MIN)
  assert.equal(runElapsedMs(r, T0 + 90 * MIN), 3 * MIN,
    'a paused run waiting on an answer does not accrue time')
  r.status = 'running'
  startRunClock(r, T0 + 90 * MIN)
  assert.equal(runElapsedMs(r, T0 + 91 * MIN), 4 * MIN, 'and resumes where it left off')
}

// ── A dead run stops counting ─────────────────────────────────────────────
//
// The process died mid-step, so nothing ever published a settled status and
// the stretch is still open. Measuring it to now means the record's duration
// grows forever - the same defect, with no restart involved. The honest end
// is the last thing the record knows happened.
{
  const r = rec({
    status: 'interrupted',
    steps: [
      { startedAt: T0, completedAt: T0 + 2 * MIN },
      { startedAt: T0 + 2 * MIN, lastActivityAt: T0 + 6 * MIN },
    ],
  })
  assert.equal(lastKnownActivity(r), T0 + 6 * MIN, 'the last step telemetry is the last thing known')
  assert.equal(runElapsedMs(r, T0 + 300 * MIN), 6 * MIN, 'an interrupted run is measured to its last activity')
  assert.equal(runElapsedMs(r, T0 + 900 * MIN), 6 * MIN, 'and does not grow with the wall clock')

  // Restarting it must not bank the dead hours either.
  reconcileRunClock(r)
  assert.equal(r.activeMs, 6 * MIN, 'the stretch a dead process left open closes at its last activity')
}

// ── A record with no telemetry at all is zero, never invented ─────────────
{
  const r = rec({ status: 'interrupted', steps: [] })
  assert.equal(runElapsedMs(r, T0 + 90 * MIN), 0,
    'nothing is known to have happened, so nothing is claimed')
}

// ── Runs recorded before the clock existed still read ─────────────────────
//
// Neither field is present. Wall clock is all such a record ever held, and
// rewriting history to a number it cannot support would be a fabrication.
{
  const legacy = { status: 'completed', startedAt: T0, endedAt: T0 + 14 * MIN, steps: [] }
  assert.equal(runElapsedMs(legacy, T0 + 900 * MIN), 14 * MIN, 'a settled legacy run reads its wall clock')
  const legacyLive = { status: 'running', startedAt: T0, steps: [] }
  assert.equal(runElapsedMs(legacyLive, T0 + 4 * MIN), 4 * MIN, 'a live legacy run measures to now')
}

// ── A settled clock is not mistaken for a legacy record ───────────────────
{
  const r = { status: 'completed', startedAt: T0, endedAt: T0 + 8 * 60 * MIN, activeMs: 12 * MIN, steps: [] }
  assert.equal(runElapsedMs(r, T0 + 900 * MIN), 12 * MIN,
    'activeMs of a finished run wins over the endedAt-startedAt span it was restarted across')
  const zero = { status: 'stopped', startedAt: T0, endedAt: T0 + 5 * MIN, activeMs: 0, steps: [] }
  assert.equal(runElapsedMs(zero, T0 + 900 * MIN), 0,
    'activeMs: 0 is a measured zero, not a missing field')
}

// ── The owner's own close is not capped by step telemetry ─────────────────
//
// A step that reported nothing (a stub, or a call that died before its first
// assistant turn) leaves lastKnownActivity at startedAt. That cap is for a
// record whose writer is gone; applying it to the owner's own settle would
// silently zero the time it just spent working.
{
  const r = rec({ steps: [{ startedAt: T0 }] })
  r.status = 'stopped'
  settleRunClock(r, T0 + 7 * MIN)
  assert.equal(r.activeMs, 7 * MIN, 'the owner closing its own stretch banks what it measured')
}

// ── Reconcile leaves a genuinely running stretch alone ────────────────────
//
// The runner restarts a live run from an earlier step when it widens or
// reworks it. The run never stopped, so its stretch is current.
{
  const r = rec()
  reconcileRunClock(r)
  assert.equal(r.runningSince, T0, 'a running run keeps its open stretch')
  assert.equal(runElapsedMs(r, T0 + 9 * MIN), 9 * MIN, 'and keeps counting across the hand-over')
}

// ── Clock skew cannot produce a negative duration ─────────────────────────
{
  const r = rec({ runningSince: T0 + 10 * MIN })
  assert.equal(runElapsedMs(r, T0), 0, 'a stretch that has not started yet contributes nothing')
}

console.log('run clock: ok')
