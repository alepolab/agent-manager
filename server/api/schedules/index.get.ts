import { listSchedules } from '../../utils/scheduleConfig.ts'
import { getScheduleState } from '../../utils/scheduleState.ts'
import { nextFireAt } from '../../utils/scheduleRunner.ts'
import { scheduleWorkspace } from '../../utils/scheduleRunStarter.ts'

/**
 * Every schedule with the two things a reader cannot work out from the record:
 * when it fires next (an operator should not have to parse `0 2 * * *` in their
 * head) and what happened last time.
 *
 * `nextFireAt` is null for an expression croner will not parse - a schedule
 * hand-edited into that state is exactly what the page has to be able to show.
 */
export default defineEventHandler(async () => {
  const schedules = await listSchedules()
  return await Promise.all(schedules.map(async schedule => ({
    ...schedule,
    nextFireAt: nextFireAt(schedule)?.toISOString() ?? null,
    workspace: scheduleWorkspace(schedule),
    state: await getScheduleState(schedule.id),
  })))
})
