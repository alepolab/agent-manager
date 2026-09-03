import { getWatch } from '../../../../../utils/watchConfig.ts'
import { clearEscalation } from '../../../../../utils/watchStateStore.ts'

/**
 * Clears an escalation — a deliberate operator action. The scheduler never
 * does this on its own (see `watchStateStore.clearEscalation`); this route
 * is the only path that resets a ticket back to `new` so it becomes
 * eligible for a fresh attempt on the next cycle.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const key = getRouterParam(event, 'key')!
  const watch = await getWatch(id)
  if (!watch) throw createError({ statusCode: 404, message: 'Watch not found' })

  const state = await clearEscalation(id, key)
  if (!state) throw createError({ statusCode: 404, message: 'Ticket not found' })
  return state
})
