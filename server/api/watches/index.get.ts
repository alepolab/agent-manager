import { listWatches } from '../../utils/watchConfig.ts'

export default defineEventHandler(async () => {
  return await listWatches()
})
