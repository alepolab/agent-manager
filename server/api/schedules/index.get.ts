import { listSchedules } from '../../utils/scheduleConfig.ts'
import { getScheduleState } from '../../utils/scheduleState.ts'
import { nextFireAt } from '../../utils/scheduleRunner.ts'
import { scheduleProjectDir } from '../../utils/scheduleRunStarter.ts'

/**
 * Every schedule with the two things a reader cannot work out from the record:
 * when it fires next (an operator should not have to parse `0 2 * * *` in their
 * head) and what happened last time.
 *
 * `nextFireAt` is null for an expression croner will not parse - a schedule
 * hand-edited into that state is exactly what the page has to be able to show.
 *
 * `workspace` is the EFFECTIVE directory its runs work in - the one it states,
 * else the derived one - resolved through the same function the starter and
 * the save pre-check use, so the page cannot report a directory the run will
 * not use.
 */
export default defineEventHandler(async () => {
  const schedules = await listSchedules()
  return await Promise.all(schedules.map(async schedule => ({
    ...schedule,
    nextFireAt: nextFireAt(schedule)?.toISOString() ?? null,
    workspace: scheduleProjectDir(schedule),
    state: await getScheduleState(schedule.id),
  })))
})
