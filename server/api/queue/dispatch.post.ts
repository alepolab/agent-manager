import { requireCapability } from '../../utils/session'
import { dispatchQueue } from '../../utils/queueDispatcher'

/** Start whatever the instance will carry right now. Safe to call repeatedly. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  return dispatchQueue(event)
})
