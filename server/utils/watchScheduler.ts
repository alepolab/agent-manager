/**
 * The watch scheduler — where per-ticket failure isolation lives.
 *
 * The requirement this file exists to satisfy, verbatim from the user: "if
 * it fails at some stage the next run should pick up the other jiras, don't
 * stuck at the failed ones." One ticket's dispatch throwing must cost only
 * that ticket, never the cycle, and a ticket whose dispatch keeps throwing
 * must eventually stop being retried (escalate) rather than being attempted
 * forever.
 *
 * IMPORTANT — the attempts-counting fix: `watchStateStore.ts`'s
 * `recordDispatch` and `recordFailure` only report an attempt's *outcome*;
 * `recordAttempt` is the sole place `attempts` increments, and it MUST be
 * called before invoking the run starter, on every ticket, whether the
 * starter goes on to succeed or throw. Calling `recordFailure` alone (as a
 * naive implementation would, in the catch block, without a preceding
 * `recordAttempt`) never increments `attempts` — the ticket then stays
 * eligible forever and is retried every single cycle, which is exactly the
 * queue-wedge this whole feature exists to prevent. See task-3-report.md
 * for the reproduction against the un-fixed code.
 */
import { getTicketSource } from './ticketSource.ts'
import {
  getWatchState,
  recordAttempt,
  recordDispatch,
  recordFailure,
  recordSuccess,
  MAX_ATTEMPTS,
} from './watchStateStore.ts'
import { getRun } from './workflowRunStore.ts'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'

/** Run statuses that mean the ticket's attempt did not pan out. */
const RUN_FAILURE_STATUSES = new Set(['failed', 'stopped', 'interrupted'])

/**
 * Resolves every `dispatched` ticket against its run's actual outcome.
 *
 * State is keyed by ticket ("should I touch this ticket at all") and is
 * deliberately decoupled from the run record ("what happened in this
 * attempt") — nothing updates a ticket's disposition as a side effect of the
 * run finishing. Without this function a ticket that was marked `dispatched`
 * stays `dispatched` forever once its run settles: the scheduler's dedupe
 * (`INELIGIBLE` includes `dispatched`) would then skip it on every future
 * cycle, and a ticket whose run failed would never retry or escalate. That
 * is the same queue-wedge this whole feature exists to prevent, just at the
 * far end instead of the dispatch end.
 *
 * `recordFailure`/`recordSuccess` are called without a preceding
 * `recordAttempt` here — the attempt this outcome belongs to was already
 * counted by `runCycle` at dispatch time (T3's fix). Reconciling a run's
 * outcome is not itself a new attempt.
 */
export async function reconcile(watch: Watch): Promise<void> {
  const state = await getWatchState(watch.id)

  for (const ticket of Object.values(state)) {
    if (ticket.disposition !== 'dispatched') continue

    if (!ticket.lastRunId) {
      // Marked dispatched with no run id to check — cannot have happened
      // through the normal path (recordDispatch always sets it), but leave
      // it alone rather than guessing at an outcome for it.
      continue
    }

    const run = await getRun(ticket.lastRunId)

    if (!run) {
      // The run record that would prove this ticket's outcome is gone —
      // deleted, corrupted past recovery, or lost with the disk. Leaving
      // the ticket `dispatched` forever would wedge it exactly like an
      // unnoticed dead run would; there is no way to distinguish "still
      // genuinely running" from "evidence destroyed" once the file is
      // gone. Treat it as a failed attempt: it lands back in `failed` (or
      // `escalated` at the cap) using the attempt already counted at
      // dispatch time, so it becomes eligible for a fresh, verifiable
      // attempt next cycle instead of sitting in limbo indefinitely.
      await recordFailure(watch.id, ticket.key, 'run record missing (lost or deleted)', MAX_ATTEMPTS)
      continue
    }

    if (run.status === 'completed') {
      await recordSuccess(watch.id, ticket.key)
    } else if (RUN_FAILURE_STATUSES.has(run.status)) {
      await recordFailure(
        watch.id,
        ticket.key,
        run.error ?? `run ended with status '${run.status}'`,
        MAX_ATTEMPTS,
      )
    }
    // 'running' or 'paused': the run is still in flight — leave it dispatched.
  }
}

export interface CycleResult {
  dispatched: string[]
  skipped: string[]
  failed: string[]
}

export type RunStarter = (watch: Watch, ticket: TicketRef) => Promise<{ runId: string }>

/** Dispositions that make a ticket permanently or currently ineligible for
 *  a fresh dispatch this cycle. */
const INELIGIBLE = new Set(['dispatched', 'done', 'escalated'])

let starter: RunStarter = async () => {
  throw new Error('no run starter configured — call setRunStarter first')
}

/** Swap the active run starter — this is how tests (and eventually the real
 *  workflow-run integration) drive the dispatch seam. */
export function setRunStarter(fn: RunStarter): void {
  starter = fn
}

/**
 * Runs one poll cycle for a single watch: fetch candidate tickets, drop the
 * ones already accounted for, respect the concurrency and daily caps, then
 * attempt to dispatch each remaining ticket in its own try/catch so that a
 * single poisoned ticket never costs the rest of the cycle.
 */
export async function runCycle(watch: Watch): Promise<CycleResult> {
  const dispatched: string[] = []
  const skipped: string[] = []
  const failed: string[] = []

  if (!watch.enabled) {
    return { dispatched, skipped, failed }
  }

  // Reconcile before fetching anything new: a run that finished (or died)
  // while the app was down must be accounted for before this cycle decides
  // what is eligible, or a ticket whose run actually completed hours ago
  // would still read as `dispatched` and be skipped forever.
  await reconcile(watch)

  let tickets: TicketRef[]
  try {
    tickets = await getTicketSource().fetch(watch)
  } catch {
    // A broken source degrades this one watch's cycle to empty; it must
    // never propagate and take the scheduler down with it.
    return { dispatched, skipped, failed }
  }

  const state = await getWatchState(watch.id)

  // Tickets already dispatched (in flight), done, or escalated are not
  // candidates this cycle — dedupe and permanent-skip both live here.
  const candidates: TicketRef[] = []
  for (const ticket of tickets) {
    const existing = state[ticket.key]
    if (existing && INELIGIBLE.has(existing.disposition)) {
      skipped.push(ticket.key)
    } else {
      candidates.push(ticket)
    }
  }

  // Concurrency cap: count tickets currently in flight for this watch, then
  // allow only enough new dispatches to reach the cap. Anything beyond that
  // is deferred to the next cycle, not dropped.
  const inFlight = Object.values(state).filter(s => s.disposition === 'dispatched').length
  const remainingConcurrency = Math.max(0, watch.maxConcurrentRuns - inFlight)

  // Daily dispatch cap: count attempts already recorded "today" (UTC day
  // boundary) across this watch's tickets, and allow only enough further
  // dispatches to reach the cap.
  const dayStart = new Date().setUTCHours(0, 0, 0, 0)
  const dispatchedToday = Object.values(state).filter(
    s => (s.disposition === 'dispatched' || s.disposition === 'done') && s.updatedAt >= dayStart,
  ).length
  const remainingDailyCap = Math.max(0, watch.dailyDispatchCap - dispatchedToday)

  const budget = Math.min(remainingConcurrency, remainingDailyCap)

  const eligible = candidates.slice(0, budget)
  for (const ticket of candidates.slice(budget)) {
    skipped.push(ticket.key)
  }

  for (const ticket of eligible) {
    try {
      // Count the attempt before calling the starter — a starter that
      // throws before a run exists is still an attempt, and must still
      // move the ticket toward escalation.
      await recordAttempt(watch.id, ticket.key)
      const { runId } = await starter(watch, ticket)
      await recordDispatch(watch.id, ticket.key, runId)
      dispatched.push(ticket.key)
    } catch (err) {
      // Isolation: this ticket's failure costs this ticket, not the cycle.
      await recordFailure(
        watch.id,
        ticket.key,
        err instanceof Error ? err.message : String(err),
        MAX_ATTEMPTS,
      )
      failed.push(ticket.key)
    }
  }

  return { dispatched, skipped, failed }
}

interface ScheduledTimer {
  timer: ReturnType<typeof setInterval>
  intervalSeconds: number
  /** The watch this timer last ticked against — kept fresh on every
   *  reconcile even when the interval itself is unchanged, so a field
   *  change (workflow slug, caps, query) that doesn't require retiming
   *  still reaches the next tick instead of the timer firing against a
   *  watch object frozen at schedule time. */
  watch: Watch
}

const timers = new Map<string, ScheduledTimer>()
let supervisor: ReturnType<typeof setInterval> | null = null

/**
 * Cadence at which the supervisor re-reads the watch list and reconciles
 * per-watch timers against it. A parameter to `startScheduler` (with this
 * as its default), not a hardcoded constant, so a test can drive it fast
 * without waiting on a production-sized interval.
 */
export const DEFAULT_SUPERVISOR_INTERVAL_MS = 1000

export type WatchSource = () => Promise<Watch[]> | Watch[]

/**
 * Supplies the watch list for `startScheduler` to schedule. The watch-store
 * (`listWatches`) that will normally back this is a later task's file and
 * does not exist yet, so this module takes no hard dependency on it — the
 * default source yields no watches (a no-op scheduler) until something
 * calls `setWatchSource`, the same seam shape as `setRunStarter`. This keeps
 * `startScheduler(): void` matching the interface exactly (no parameter)
 * while staying wireable from `server/plugins/watcher.ts` once it exists.
 */
let watchSource: WatchSource = () => []

/** Swap the active watch source — production wiring calls this with
 *  `listWatches` from the watch store once it exists; tests can too. */
export function setWatchSource(fn: WatchSource): void {
  watchSource = fn
}

/** Run one guarded cycle for a watch — never lets a rejection escape into
 *  the timer callback (an uncaught rejection there would crash the process). */
async function tick(watch: Watch): Promise<void> {
  try {
    await runCycle(watch)
  } catch {
    // runCycle already swallows its own failure modes; this is a last-resort
    // guard so a bug in the scheduler itself cannot take the process down.
  }
}

/**
 * Reconciles the live `timers` map against the current watch source. This is
 * the Part 1 fix: `startScheduler` used to read the watch list exactly once
 * at boot, so a watch created, enabled, disabled, or retimed afterward never
 * took effect until the process restarted — the manual `poll` endpoint was
 * the only thing that ever ran it. Called once immediately by
 * `startScheduler` and then on every supervisor tick.
 *
 *  - enabled + unscheduled (new, or just flipped on): gets a timer
 *  - enabled + `intervalSeconds` changed: old timer cleared, new one set —
 *    retimed, never accumulated into a second interval
 *  - enabled + unchanged: left running, but its captured `watch` is
 *    refreshed so other field edits still reach the next tick
 *  - disabled, or no longer returned by the source at all (deleted): timer
 *    stopped and removed — no orphaned timer survives a disable or delete
 */
async function reconcileTimers(): Promise<void> {
  const watches = await watchSource()
  const seen = new Set<string>()

  for (const watch of watches) {
    seen.add(watch.id)
    const existing = timers.get(watch.id)
    const intervalSeconds = Math.max(1, watch.intervalSeconds)

    if (!watch.enabled) {
      if (existing) {
        clearInterval(existing.timer)
        timers.delete(watch.id)
      }
      continue
    }

    if (existing) {
      existing.watch = watch
      if (existing.intervalSeconds === intervalSeconds) continue
      clearInterval(existing.timer) // retime: replace, never accumulate
    }

    const entry: ScheduledTimer = {
      watch,
      intervalSeconds,
      timer: setInterval(() => { void tick(entry.watch) }, intervalSeconds * 1000),
    }
    timers.set(watch.id, entry)
  }

  // A watch no longer returned by the source at all (deleted) must not
  // leave an orphaned timer running against a watch that no longer exists.
  for (const id of timers.keys()) {
    if (!seen.has(id)) {
      clearInterval(timers.get(id)!.timer)
      timers.delete(id)
    }
  }
}

/**
 * Starts the supervisor: reconciles timers immediately, then again every
 * `supervisorIntervalMs`. Re-entrant: calling this again first stops
 * everything (`stopScheduler`), so it is safe to call more than once.
 *
 * `supervisorIntervalMs` defaults to `DEFAULT_SUPERVISOR_INTERVAL_MS` so
 * every real caller — `server/plugins/watcher.ts` calls `startScheduler()`
 * with no arguments — still matches the watch source's own contract (no
 * parameter needed to react to changes); a test may pass a shorter value to
 * drive real timers without a production-sized wait.
 */
export function startScheduler(supervisorIntervalMs = DEFAULT_SUPERVISOR_INTERVAL_MS): void {
  stopScheduler()
  void reconcileTimers()
  supervisor = setInterval(() => { void reconcileTimers() }, supervisorIntervalMs)
}

/** Stops every timer started by `startScheduler`, including the supervisor
 *  itself. Safe to call when nothing is running. */
export function stopScheduler(): void {
  for (const entry of timers.values()) clearInterval(entry.timer)
  timers.clear()
  if (supervisor) {
    clearInterval(supervisor)
    supervisor = null
  }
}
