import { getWatch } from '../../../utils/watchConfig.ts'
import { getWatchState } from '../../../utils/watchStateStore.ts'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const watch = await getWatch(id)
  if (!watch) throw createError({ statusCode: 404, message: 'Watch not found' })
  return await getWatchState(id)
})
