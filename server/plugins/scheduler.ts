import { listSchedules } from '../utils/scheduleConfig.ts'
import { setScheduleSource, setScheduleStarter, startScheduleRunner } from '../utils/scheduleRunner.ts'
import { realScheduleStarter } from '../utils/scheduleRunStarter.ts'

export default defineNitroPlugin(() => {
  if (process.env.SCHEDULER_DISABLED === '1') return

  setScheduleSource(listSchedules)
  setScheduleStarter(realScheduleStarter)
  startScheduleRunner()
})
