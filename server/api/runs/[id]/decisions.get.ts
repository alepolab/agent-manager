import { getRun } from '../../../utils/workflowRunStore'
import { loadReviewQueue, ReviewError } from '../../../utils/runReview'

/** The entries a run is waiting on a person to decide about. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  try {
    return await loadReviewQueue(run)
  } catch (err) {
    if (err instanceof ReviewError) throw createError({ statusCode: err.statusCode, message: err.message })
    throw err
  }
})
