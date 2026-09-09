import { getSchedule } from '../../../utils/scheduleConfig.ts'
import { fireSchedule } from '../../../utils/scheduleRunner.ts'

/**
 * Fires one schedule now — the "Run now" button.
 *
 * Deliberately works on a DISABLED schedule: firing by hand is how an operator
 * checks that a schedule does what they meant before they let it loose at 2am,
 * and requiring them to enable it first would defeat the point of new
 * schedules starting disabled.
 *
 * Mirrors POST /api/watches/[id]/poll: returns the outcome rather than a bare
 * 204, so the caller sees whether a run started, was skipped, or errored.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const schedule = await getSchedule(id)
  if (!schedule) throw createError({ statusCode: 404, message: 'Schedule not found' })

  return await fireSchedule(schedule)
})
