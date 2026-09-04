import { getWatch, deleteWatch } from '../../utils/watchConfig.ts'
import { deleteWatchState } from '../../utils/watchStateStore.ts'

/**
 * Deletes a watch and its per-ticket state together.
 *
 * Decision — ticket state (`watch-state/<id>.json`) is deleted, not left
 * orphaned: `POST /api/watches` slugifies the name into the id, so an
 * operator re-creating a watch under the same name plausibly lands on the
 * same id. An orphaned state file would then be silently inherited by that
 * new watch, including any `escalated` tickets — which would never be
 * picked up again, with no visible reason why. That silent-inheritance
 * failure mode is worse than losing the audit trail of what was escalated
 * and when, so this route removes both files and reports exactly what
 * happened in the response (`stateDeleted`) rather than leaving it implicit.
 *
 * No orphaned timer: the scheduler's supervisor (`reconcileTimers` in
 * `watchScheduler.ts`, commit 376ccd2) reconciles its live timers against
 * `listWatches()` on every tick — once this watch is gone from
 * `watches.json`, the very next supervisor tick (`DEFAULT_SUPERVISOR_INTERVAL_MS`,
 * 1s by default) clears its timer on its own; nothing here needs to touch a
 * timer directly, and no server restart is required. See
 * scripts/test-watch-scheduler.mjs for a test against real timers proving this.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const watch = await getWatch(id)
  if (!watch) throw createError({ statusCode: 404, message: 'Watch not found' })

  const deleted = await deleteWatch(id)
  const stateDeleted = await deleteWatchState(id)

  return { deleted, id, stateDeleted }
})
