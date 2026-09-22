import { deleteProduct, StaleStoreError } from '../../../utils/productStore'
import { requireUser } from '../../../utils/session'
import { createLogger } from '../../../utils/log'

const log = createLogger('registry')

/** Remove a product. Every ticket that resolved through it stops resolving, so
 *  the page asks for the key to be typed before it calls this. */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const key = getRouterParam(event, 'key')!
  const mtimeMs = Number(getQuery(event).mtimeMs) || undefined
  try {
    const next = await deleteProduct(key, mtimeMs)
    if (next === null) throw createError({ statusCode: 404, message: `No product called "${key}" is registered` })
    log.info('product removed', { key, by: user.login })
    return { key, mtimeMs: next }
  } catch (err) {
    if (err instanceof StaleStoreError) throw createError({ statusCode: 409, message: err.message, data: { mtimeMs: err.mtimeMs } })
    throw err
  }
})
