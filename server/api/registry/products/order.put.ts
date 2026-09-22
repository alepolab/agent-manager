import { reorder, StaleStoreError } from '../../../utils/productStore'
import { requireUser } from '../../../utils/session'
import { createLogger } from '../../../utils/log'

const log = createLogger('registry')

/**
 * Reorder the products. This IS a routing change: file order is the final
 * tie-break in `resolveProduct`, so moving one product above another decides
 * which of them takes a ticket that names neither specifically.
 *
 * The body must be a permutation of the keys present. A partial list would
 * drop whatever it left out, and a dropped product is a ticket that silently
 * stops resolving.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<{ keys?: unknown, mtimeMs?: number }>(event)
  if (!Array.isArray(body?.keys) || body.keys.some(k => typeof k !== 'string')) {
    throw createError({ statusCode: 400, message: 'keys must be an array of product keys' })
  }
  try {
    const mtimeMs = await reorder(body.keys as string[], body.mtimeMs)
    log.info('products reordered', { by: user.login })
    return { mtimeMs }
  } catch (err) {
    if (err instanceof StaleStoreError) throw createError({ statusCode: 409, message: err.message, data: { mtimeMs: err.mtimeMs } })
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
