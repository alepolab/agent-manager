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
  MAX_ATTEMPTS,
} from './watchStateStore.ts'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'

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

const timers = new Map<string, ReturnType<typeof setInterval>>()

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
 * Starts a `setInterval` per enabled watch returned by the current watch
 * source. Re-entrant: calling this again first stops any previously
 * scheduled timers, so it is safe to call after the watch list changes.
 */
export function startScheduler(): void {
  stopScheduler()
  const boot = async () => {
    const watches = await watchSource()
    for (const watch of watches) {
      if (!watch.enabled) continue
      const timer = setInterval(() => {
        void tick(watch)
      }, Math.max(1, watch.intervalSeconds) * 1000)
      timers.set(watch.id, timer)
    }
  }
  void boot()
}

/** Stops every timer started by `startScheduler`. Safe to call when nothing
 *  is running. */
export function stopScheduler(): void {
  for (const timer of timers.values()) clearInterval(timer)
  timers.clear()
}
