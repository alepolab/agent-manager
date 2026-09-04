import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import type { TicketState } from '~~/shared/types/watch'

export const WATCH_STATE_DIR_NAME = 'watch-state'

/** Attempts before a ticket is permanently escalated and left alone. */
export const MAX_ATTEMPTS = 3

const watchStateDir = () => resolveClaudePath(WATCH_STATE_DIR_NAME)
const watchStatePath = (watchId: string) => join(watchStateDir(), `${watchId}.json`)

async function ensureDir() {
  const dir = watchStateDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/**
 * All ticket state for one watch, keyed by ticket key. A corrupt or missing
 * file reads back as empty rather than throwing — the watcher should never
 * be wedged by a bad state file.
 */
export async function getWatchState(watchId: string): Promise<Record<string, TicketState>> {
  const path = watchStatePath(watchId)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, TicketState>
  } catch {
    return {}
  }
}

async function saveWatchState(watchId: string, state: Record<string, TicketState>): Promise<void> {
  await ensureDir()
  await writeFile(watchStatePath(watchId), JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * True when `key` can serve as state identity: a non-empty string after
 * trimming. `TicketRef.key` is typed as `string`, but a malformed ticket
 * from a broken source can still produce `undefined`, `null`, or `''` at
 * runtime — `createFileTicketSource`'s `JSON.parse(...) as TicketRef[]`
 * does not enforce the type, so a hand-edited or upstream-malformed ticket
 * file sails straight through.
 *
 * Every function below used to index a plain object by `key` with no
 * check at all: `all[key] = next` on `key === undefined` silently coerces
 * to the property `"undefined"`, and on `key === ''` to the property
 * `""`. Two DIFFERENT keyless tickets therefore collided on that one
 * shared property, across cycles, sharing attempts and disposition — one
 * malformed ticket could push a different malformed ticket to `escalated`
 * without it ever having been attempted `MAX_ATTEMPTS` times itself. See
 * `scripts/watch-state-collision-baseline.mjs` for the empirical
 * reproduction against the un-fixed store.
 *
 * The fix is not to synthesize a stable identity for a keyless ticket —
 * every function here receives only `key` (never the ticket's summary,
 * description, or other content), so there is nothing to hash that would
 * actually distinguish one keyless ticket from another — but to refuse to
 * track it at all: a ticket with no key cannot be reconciled against on a
 * later cycle regardless, so recording state for it under a fabricated or
 * coerced identity would just be trading one kind of misattribution for
 * another. See `recordAttempt` (throws) and `recordFailure` (does not —
 * it is the scheduler's catch-all for an attempt that already failed to
 * start) for how that plays out.
 */
function isTrackableKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.trim().length > 0
}

const UNTRACKABLE_KEY_MESSAGE =
  'ticket has no key — refusing to track state for it (a keyless ticket cannot be reconciled across cycles)'

export async function saveTicketState(state: TicketState): Promise<void> {
  if (!isTrackableKey(state.key)) throw new Error(UNTRACKABLE_KEY_MESSAGE)
  const all = await getWatchState(state.watchId)
  all[state.key] = state
  await saveWatchState(state.watchId, all)
}

function getOrInit(all: Record<string, TicketState>, watchId: string, key: string): TicketState {
  return all[key] ?? {
    key,
    watchId,
    disposition: 'new',
    attempts: 0,
    firstSeenAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * Marks that a dispatch attempt is being made, before the run starter is
 * invoked — this is the ONLY place `attempts` is incremented. A starter that
 * throws before a run exists is still an attempt: if it weren't counted
 * here, a ticket whose dispatch always fails would never reach
 * `MAX_ATTEMPTS` and would be retried forever, spending tokens on every
 * cycle with no escalation. `recordDispatch` and `recordFailure` report the
 * *outcome* of the attempt this call already counted, so they never touch
 * `attempts` themselves — call this once per attempt, then exactly one of
 * the other two.
 */
export async function recordAttempt(watchId: string, key: string): Promise<TicketState> {
  if (!isTrackableKey(key)) throw new Error(UNTRACKABLE_KEY_MESSAGE)
  const all = await getWatchState(watchId)
  const current = getOrInit(all, watchId, key)
  const next: TicketState = {
    ...current,
    attempts: current.attempts + 1,
    updatedAt: Date.now(),
  }
  all[key] = next
  await saveWatchState(watchId, all)
  return next
}

/** Records that the attempt already counted by `recordAttempt` produced a
 *  running dispatch. Does not itself bump `attempts`. */
export async function recordDispatch(watchId: string, key: string, runId: string): Promise<TicketState> {
  if (!isTrackableKey(key)) throw new Error(UNTRACKABLE_KEY_MESSAGE)
  const all = await getWatchState(watchId)
  const current = getOrInit(all, watchId, key)
  const next: TicketState = {
    ...current,
    disposition: 'dispatched',
    lastRunId: runId,
    updatedAt: Date.now(),
  }
  all[key] = next
  await saveWatchState(watchId, all)
  return next
}

/** Records that the attempt already counted by `recordAttempt` failed. Does
 *  not itself bump `attempts` — escalation is decided from the count that
 *  call already recorded.
 *
 *  For a keyless ticket this is reached ONLY via `watchScheduler.ts`'s
 *  dispatch catch block, immediately after `recordAttempt` above refused
 *  the same ticket by throwing — that catch block calls `recordFailure`
 *  unconditionally, with nothing further wrapping it, so this must not
 *  throw a second time (doing so would escape as an unhandled rejection
 *  and cost the REST of the cycle, exactly the blast radius this store
 *  exists to contain). Instead it reports the failure without persisting
 *  it: there is no stable identity to reconcile against later, so nothing
 *  is written to disk. The ticket is simply retried, and re-refused, every
 *  cycle it keeps reappearing — see the fix's report for why that is the
 *  chosen tradeoff over fabricating an identity for it. */
export async function recordFailure(
  watchId: string,
  key: string,
  reason: string,
  maxAttempts: number,
): Promise<TicketState> {
  if (!isTrackableKey(key)) {
    return {
      key: key ?? '',
      watchId,
      disposition: 'failed',
      attempts: 0,
      lastError: reason,
      firstSeenAt: Date.now(),
      updatedAt: Date.now(),
    }
  }
  const all = await getWatchState(watchId)
  const current = getOrInit(all, watchId, key)
  const next: TicketState = {
    ...current,
    disposition: current.attempts >= maxAttempts ? 'escalated' : 'failed',
    lastError: reason,
    updatedAt: Date.now(),
  }
  all[key] = next
  await saveWatchState(watchId, all)
  return next
}

export async function recordSuccess(watchId: string, key: string): Promise<TicketState> {
  if (!isTrackableKey(key)) throw new Error(UNTRACKABLE_KEY_MESSAGE)
  const all = await getWatchState(watchId)
  const current = getOrInit(all, watchId, key)
  const next: TicketState = {
    ...current,
    disposition: 'done',
    updatedAt: Date.now(),
  }
  all[key] = next
  await saveWatchState(watchId, all)
  return next
}

/**
 * Removes a watch's entire ticket-state file. Called only from
 * `DELETE /api/watches/[id]` — see that route's docstring for why state is
 * deleted rather than orphaned when a watch is deleted: leaving it behind
 * would let a later watch reusing the same id silently inherit old
 * dispositions, including `escalated` tickets that would then never be
 * picked up again. Returns whether a file actually existed to remove, so
 * the caller can report explicitly rather than silently no-op.
 */
export async function deleteWatchState(watchId: string): Promise<boolean> {
  const path = watchStatePath(watchId)
  if (!existsSync(path)) return false
  await unlink(path)
  return true
}

/**
 * Clearing an escalation is a deliberate operator action, never something the
 * scheduler decides on its own. Returns null for an unknown ticket rather
 * than fabricating one.
 */
export async function clearEscalation(watchId: string, key: string): Promise<TicketState | null> {
  if (!isTrackableKey(key)) return null
  const all = await getWatchState(watchId)
  const current = all[key]
  if (!current) return null
  const next: TicketState = {
    ...current,
    disposition: 'new',
    attempts: 0,
    updatedAt: Date.now(),
  }
  all[key] = next
  await saveWatchState(watchId, all)
  return next
}
