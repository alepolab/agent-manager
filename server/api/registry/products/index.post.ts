import { createProduct } from '../../../utils/productStore'
import { blocking, validateProduct } from '../../../utils/registryValidate'
import { requireUser, requireCapability } from '../../../utils/session'
import { createLogger } from '../../../utils/log'

const log = createLogger('registry')
const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Add a product. It appends: file order decides routing ties, so where a new
 *  entry lands is a routing decision, and the end is the only place that
 *  changes nothing about the products already there. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const user = await requireUser(event)
  const body = await readBody<{ key?: string, product?: Record<string, any>, comment?: string, mtimeMs?: number }>(event)
  const key = body?.key?.trim()
  if (!key || !KEY.test(key)) {
    throw createError({ statusCode: 400, message: 'A product key is required, in lowercase words separated by hyphens' })
  }
  if (!body?.product || typeof body.product !== 'object' || Array.isArray(body.product)) {
    throw createError({ statusCode: 400, message: 'product must be an object' })
  }
  const errors = blocking(validateProduct(key, body.product))
  if (errors.length) {
    throw createError({ statusCode: 400, message: errors.map(e => `${e.where}: ${e.message}`).join('; ') })
  }
  // The "is it taken?" question is asked inside createProduct, against the
  // same document it is about to write. Asked here, against a readStore() of
  // its own, it was two file reads away from the write: two creates of one key
  // both saw it free and the second overwrote the first. expectedMtimeMs does
  // not cover it either - a create has no prior mtime to send.
  const mtimeMs = await createProduct(key, body.product, { comment: body.comment, expectedMtimeMs: body.mtimeMs })
  if (mtimeMs === null) {
    throw createError({ statusCode: 409, message: `A product called "${key}" is already registered` })
  }
  log.info('product added', { key, by: user.login })
  return { key, mtimeMs }
})
