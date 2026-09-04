import { getWatch } from '../../../utils/watchConfig.ts'
import { runCycle } from '../../../utils/watchScheduler.ts'

/**
 * Forces one poll cycle for a single watch right now — the way an operator
 * tests a watch without waiting for `intervalSeconds` to elapse.
 * `runCycle` (T3/T4) already reconciles in-flight tickets against their
 * runs' real outcomes before fetching anything new, so this route does not
 * need to call `reconcile` separately.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const watch = await getWatch(id)
  if (!watch) throw createError({ statusCode: 404, message: 'Watch not found' })
  return await runCycle(watch)
})
