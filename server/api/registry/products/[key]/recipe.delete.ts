import { deleteRecipe } from '../../../../utils/recipeStore'
import { requireUser } from '../../../../utils/session'
import { createLogger } from '../../../../utils/log'

const log = createLogger('registry')

/** Remove the local recipe, so whatever it shadowed is live again. Never the
 *  plugin's copy or the shipped one; those are not this app's to delete. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const key = getRouterParam(event, 'key')!
  try {
    const { fellBackTo } = await deleteRecipe(key)
    log.info('local recipe removed', { key, by: user.login })
    return { key, fellBackTo }
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
