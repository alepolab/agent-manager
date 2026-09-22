import { StaleRecipeError, writeRecipe } from '../../../../utils/recipeStore'
import { requireUser } from '../../../../utils/session'
import { createLogger } from '../../../../utils/log'

const log = createLogger('registry')

/**
 * Write a product's recipe. Always to the local copy — see recipeStore.ts for
 * why the plugin's is never written through here.
 *
 * `mtimeMs` may legitimately be absent (the caller is writing the first recipe
 * this product has ever had) or null (the caller was shown none), and the two
 * are different: absent skips the check, null asserts there was nothing there.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const key = getRouterParam(event, 'key')!
  const body = await readBody<{ content?: string, mtimeMs?: number | null }>(event)
  if (typeof body?.content !== 'string') {
    throw createError({ statusCode: 400, message: 'content must be a string' })
  }

  try {
    const { path, mtimeMs } = await writeRecipe(key, body.content, { expectedMtimeMs: body.mtimeMs })
    log.info('recipe saved', { key, by: user.login })
    return { key, path, mtimeMs }
  } catch (err) {
    if (err instanceof StaleRecipeError) throw createError({ statusCode: 409, message: err.message, data: { mtimeMs: err.mtimeMs } })
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
