/**
 * A run waiting on a person must cost human time, whether or not it asked a
 * question.
 *
 * `humanWaitMs` counted decided gates plus one open question, so a run paused
 * with NO question scored zero. That state is not exotic: with autoRun off the
 * wave loop stops between waves and waits for someone to press Continue. The
 * board's `waiting` list filtered on `r.question` for the same reason, so
 * those runs were invisible there too.
 *
 * Net effect: the cautious operator — the one who unticked the box so a human
 * sees each wave — produced exactly the runs the manager's board could not
 * see, and contributed nothing to the one headline figure the page exists to
 * produce. The careful path was the invisible one.
 *
 *   node scripts/test-human-wait.mjs
 */
import assert from 'node:assert/strict'
import { humanWaitMs } from '../shared/utils/runDecisions.ts'

const MIN = 60_000
const now = Date.now()

/** A run with no decisions and no question, paused since its last activity. */
const bare = (status, lastActivity) => ({
  id: 'r', status, startedAt: now - 120 * MIN,
  steps: [{ startedAt: now - 120 * MIN, completedAt: lastActivity }],
})

// ---- A bare pause accrues human time ------------------------------------
{
  const run = bare('paused', now - 30 * MIN)
  const ms = humanWaitMs(run)
  assert.ok(ms >= 29 * MIN && ms <= 31 * MIN,
    `a run paused 30 minutes with no question must cost ~30 minutes of human time, got ${Math.round(ms / MIN)}m`)
}

// ---- A settled run accrues nothing --------------------------------------
// Only `paused` is waiting on a person. A completed or failed run is not, and
// counting its idle time would make every old run inflate the figure forever.
for (const status of ['completed', 'failed', 'stopped', 'running', 'interrupted']) {
  assert.equal(humanWaitMs(bare(status, now - 30 * MIN)), 0,
    `${status} is not waiting on a person and must contribute nothing`)
}

// ---- A gate still measures from when it ASKED, not from last activity ----
// The question carries its own timestamp and it is the more precise one: a
// step can finish well before the gate is raised.
{
  const run = {
    id: 'r', status: 'paused', startedAt: now - 120 * MIN,
    steps: [{ startedAt: now - 120 * MIN, completedAt: now - 90 * MIN }],
    question: { stepId: 's', text: '', kind: 'approval', askedAt: now - 10 * MIN },
  }
  const ms = humanWaitMs(run)
  assert.ok(ms >= 9 * MIN && ms <= 11 * MIN,
    `a gate asked 10 minutes ago must cost ~10 minutes, not the 90 since the step finished, got ${Math.round(ms / MIN)}m`)
}

// ---- Decided waits still accumulate, and add to the open one ------------
{
  const run = {
    id: 'r', status: 'paused', startedAt: now - 300 * MIN,
    steps: [{ startedAt: now - 300 * MIN, completedAt: now - 60 * MIN }],
    decisions: [
      { stepId: 'a', label: 'A', at: now - 200 * MIN, by: 'x', verdict: 'approved', waitedMs: 20 * MIN },
      { stepId: 'b', label: 'B', at: now - 100 * MIN, by: 'y', verdict: 'approved', waitedMs: 15 * MIN },
    ],
    question: { stepId: 'c', text: '', kind: 'approval', askedAt: now - 5 * MIN },
  }
  const ms = humanWaitMs(run)
  assert.ok(ms >= 39 * MIN && ms <= 41 * MIN,
    `20 + 15 decided plus 5 open should be ~40 minutes, got ${Math.round(ms / MIN)}m`)
}

// ---- Never negative ------------------------------------------------------
// A clock skew between the server that stamped the pause and the one reading
// it must not subtract from the total.
{
  assert.equal(humanWaitMs(bare('paused', now + 60 * MIN)), 0,
    'a future timestamp is a clock artefact, not negative human time')
}

console.log('human wait: a bare pause costs human time, a settled run costs none, and a gate measures from when it asked')
