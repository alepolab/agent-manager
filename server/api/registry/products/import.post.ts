import { importFromSource, StaleStoreError } from '../../../utils/productStore'
import { requireUser } from '../../../utils/session'
import { createLogger } from '../../../utils/log'

const log = createLogger('registry')

/**
 * Copy named products from the plugin (or the shipped copy) into the store,
 * with the comments attached to them.
 *
 * Explicit, never automatic. An automatic import is one step from an automatic
 * overwrite, which is the every-boot rewrite the store exists to avoid.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ keys?: unknown, mtimeMs?: number }>(event)
  if (!Array.isArray(body?.keys) || !body.keys.length || body.keys.some(k => typeof k !== 'string')) {
    throw createError({ statusCode: 400, message: 'keys must be a non-empty array of product keys' })
  }
  try {
    const result = await importFromSource(body.keys as string[], body.mtimeMs)
    log.info('products imported from the seed source', { keys: result.imported, by: user.login })
    return result
  } catch (err) {
    if (err instanceof StaleStoreError) throw createError({ statusCode: 409, message: err.message, data: { mtimeMs: err.mtimeMs } })
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
