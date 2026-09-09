/**
 * A run's own clock: how long it has actually been executing.
 *
 * `startedAt` and `endedAt` bracket a run in wall-clock time, and for a run
 * that ran once, straight through, the difference between them is its
 * duration. A restart breaks that. It resumes the SAME run id after an
 * arbitrary, human-shaped gap — a run that failed at midnight and is noticed
 * the next morning is restarted eight hours later — and `endedAt - startedAt`
 * then reports those eight hours as the run's duration. A real run read
 * "73m" on the runs page against twelve minutes of agent work; the other
 * sixty-one minutes were the time it sat failed, waiting for a person.
 *
 * So a run keeps a clock instead of a subtraction. `activeMs` holds the
 * stretches that have closed, `runningSince` marks the stretch that is open
 * now. The clock runs while the run's status is `running` and stops
 * everywhere else: a paused run is waiting on a person, exactly as a failed
 * one waits to be restarted, and in neither case is the run working. What
 * `startedAt`/`endedAt` mean is unchanged — they are still the wall-clock
 * moments the run first began and last settled, and the runs page still shows
 * `startedAt` in its own column.
 *
 * Everything here is pure and free of Vue, Nuxt aliases and I/O, so the runs
 * page, the runner's budget, the cost report and
 * scripts/test-run-clock.mjs all read one implementation.
 */

/**
 * The parts of a run this clock reads. Structural rather than the full
 * `WorkflowRun` so the tests can hand it plain objects, and so nothing here
 * can quietly grow a dependency on the rest of the record.
 */
export interface RunClockRecord {
  status: string
  startedAt: number
  endedAt?: number
  /** See WorkflowRun.activeMs. */
  activeMs?: number
  /** See WorkflowRun.runningSince. */
  runningSince?: number
  steps?: { startedAt?: number, completedAt?: number, lastActivityAt?: number }[]
}

/** A run whose clock is allowed to be running. Only one status qualifies:
 *  `paused` is waiting on a person, and the rest are settled. */
export function runClockTicking(run: RunClockRecord): boolean {
  return run.status === 'running'
}

/**
 * The last moment this record knows anything happened in the run.
 *
 * The honest end for a stretch whose owning process died before it could
 * write one: the run was alive at least until its last step reported
 * something, and nothing is known after that. Never `now` — an open stretch
 * measured to now is precisely the defect this module exists to remove, and
 * on a dead run it would tick forever. Falls back to `startedAt`, which
 * makes such a stretch zero-length rather than invented.
 */
export function lastKnownActivity(run: RunClockRecord): number {
  let last = run.startedAt
  for (const s of run.steps ?? []) {
    for (const t of [s.startedAt, s.completedAt, s.lastActivityAt]) {
      if (typeof t === 'number' && t > last) last = t
    }
  }
  return last
}

/** The open stretch's contribution, or 0 when no stretch is open. */
function openStretchMs(run: RunClockRecord, now: number): number {
  if (run.runningSince === undefined) return 0
  const end = run.endedAt ?? (runClockTicking(run) ? now : lastKnownActivity(run))
  return Math.max(0, end - run.runningSince)
}

/**
 * Milliseconds this run has spent executing, across every attempt.
 *
 * A record written before this clock existed carries neither field; there is
 * nothing to read but the wall clock, so that is what it returns — old runs
 * render exactly as they did, rather than being rewritten to a number their
 * record never supported.
 */
export function runElapsedMs(run: RunClockRecord, now: number = Date.now()): number {
  if (run.activeMs === undefined && run.runningSince === undefined) {
    return Math.max(0, (run.endedAt ?? now) - run.startedAt)
  }
  return (run.activeMs ?? 0) + openStretchMs(run, now)
}

/** Opens a stretch, if one is not already open. Idempotent: a wave publishes
 *  the same `running` status many times and must not restart the clock. */
export function startRunClock(run: RunClockRecord, now: number = Date.now()): void {
  if (run.runningSince === undefined) run.runningSince = now
}

/**
 * Closes the open stretch at `now`, folding it into `activeMs`. For the
 * process that owns the run, on its own transition out of `running` — it did
 * the work and `now` is when the work stopped, so a run that paused after
 * three minutes banks three minutes.
 *
 * Must run BEFORE `endedAt` is cleared for a restart: `endedAt`, when the
 * transition set one, is the moment the stretch actually ended.
 */
export function settleRunClock(run: RunClockRecord, now: number = Date.now()): void {
  if (run.runningSince === undefined) return
  const end = run.endedAt ?? now
  run.activeMs = (run.activeMs ?? 0) + Math.max(0, end - run.runningSince)
  run.runningSince = undefined
}

/**
 * Closes a stretch left open by a process that is GONE.
 *
 * A run whose server died mid-step never published a settled status, so its
 * clock is still running with nobody to stop it. `now` is not the honest end
 * there — the run stopped whenever the process did, and all the record knows
 * is the last thing a step reported, so that is where the stretch closes.
 * Deliberately NOT capped at `now` the way settleRunClock is: charging a
 * restart with the hours a run spent dead is the whole defect this module
 * exists to prevent.
 *
 * A no-op when the run is genuinely still running, which is the runner
 * handing a live run to itself (a widened or reworked run restarts from an
 * earlier step without ever stopping): that stretch is current, not stale.
 */
export function reconcileRunClock(run: RunClockRecord): void {
  if (run.runningSince === undefined || runClockTicking(run)) return
  const end = run.endedAt ?? lastKnownActivity(run)
  run.activeMs = (run.activeMs ?? 0) + Math.max(0, end - run.runningSince)
  run.runningSince = undefined
}

/**
 * The most recent moment anything happened in this run: the answer to "what
 * ran last", which is not the answer to "what started last".
 *
 * A restart resumes an old run id, so a run first started three days ago can
 * be the one that ran an hour ago. Ordering "recent runs" by `startedAt`
 * files it under three days ago and buries it beneath runs that have done
 * nothing since.
 */
export function runLastActivityAt(run: RunClockRecord): number {
  return Math.max(lastKnownActivity(run), run.endedAt ?? 0, run.runningSince ?? 0)
}

/** Whole minutes of execution, for the budget cap and the cost report. */
export function runElapsedMinutes(run: RunClockRecord, now: number = Date.now()): number {
  return runElapsedMs(run, now) / 60000
}
