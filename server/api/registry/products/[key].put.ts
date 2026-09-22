import { StaleStoreError, writeProduct } from '../../../utils/productStore'
import { blocking, validateProduct } from '../../../utils/registryValidate'
import { requireUser, requireCapability } from '../../../utils/session'
import { createLogger } from '../../../utils/log'

const log = createLogger('registry')

/**
 * Update one product.
 *
 * Per product rather than a whole-table PUT, and that is not this app's usual
 * preference: `PUT /api/workflow-groups` deliberately saves its whole table so
 * a row with a bad cap is refused before anything is written. A concurrency
 * group is three scalar columns. A product entry sits in a file where roughly
 * forty per cent of the lines are the reasoning behind the entries, and a
 * whole-table save from a client that never saw those comments is exactly the
 * mechanism that would delete them.
 *
 * A validation error refuses the write outright. The runner reads this entry
 * as the repos to clone, the branch to cut from and the commands to run, so an
 * entry nothing can act on is a run that fails after standing a stack up.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const user = await requireUser(event)
  const key = getRouterParam(event, 'key')!
  const body = await readBody<{ product?: Record<string, any>, comment?: string, mtimeMs?: number }>(event)
  if (!body?.product || typeof body.product !== 'object' || Array.isArray(body.product)) {
    throw createError({ statusCode: 400, message: 'product must be an object' })
  }

  const problems = validateProduct(key, body.product)
  const errors = blocking(problems)
  if (errors.length) {
    throw createError({ statusCode: 400, message: errors.map(e => `${e.where}: ${e.message}`).join('; ') })
  }

  try {
    const mtimeMs = await writeProduct(key, body.product, { comment: body.comment, expectedMtimeMs: body.mtimeMs })
    log.info('product updated', { key, by: user.login })
    return { key, mtimeMs, problems }
  } catch (err) {
    if (err instanceof StaleStoreError) throw createError({ statusCode: 409, message: err.message, data: { mtimeMs: err.mtimeMs } })
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
