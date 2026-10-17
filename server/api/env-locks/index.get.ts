import { listEnvLocks, toView } from '../../utils/envLocks.ts'

/** Every environment lock in force, for an operator to see who holds what. Tokens are shown by their last four characters only. */
export default defineEventHandler(async () => {
  const locks = await listEnvLocks()
  return { locks: locks.map(toView) }
})
