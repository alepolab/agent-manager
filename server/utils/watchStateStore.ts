import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export async function saveTicketState(state: TicketState): Promise<void> {
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
 *  call already recorded. */
export async function recordFailure(
  watchId: string,
  key: string,
  reason: string,
  maxAttempts: number,
): Promise<TicketState> {
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
 * Clearing an escalation is a deliberate operator action, never something the
 * scheduler decides on its own. Returns null for an unknown ticket rather
 * than fabricating one.
 */
export async function clearEscalation(watchId: string, key: string): Promise<TicketState | null> {
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
