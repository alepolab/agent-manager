import { getSchedule, deleteSchedule } from '../../utils/scheduleConfig.ts'
import { deleteScheduleState } from '../../utils/scheduleState.ts'

/**
 * Deletes a schedule and its state file together.
 *
 * State is removed rather than orphaned for the reason DELETE /api/watches/[id]
 * gives: the id is slugified from the name, so re-creating a schedule under the
 * same name plausibly lands on the same id and would silently inherit the old
 * one's last-fire record.
 *
 * No orphaned job: scheduleRunner's supervisor reconciles against
 * listSchedules() on every tick, so the next tick (1s by default) stops this
 * schedule's croner job on its own. Nothing here touches a job directly.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const schedule = await getSchedule(id)
  if (!schedule) throw createError({ statusCode: 404, message: 'Schedule not found' })

  const deleted = await deleteSchedule(id)
  const stateDeleted = await deleteScheduleState(id)

  return { deleted, id, stateDeleted }
})
