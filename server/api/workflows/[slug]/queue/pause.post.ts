import { requireCapability } from '../../../../utils/session'
import { readQueue, writeQueue } from '../../../../utils/workflowQueue'

/** Start nothing new. A run already going finishes and is recorded. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const slug = getRouterParam(event, 'slug')!
  const queue = await readQueue(slug)
  if (!queue) throw createError({ statusCode: 404, message: `Workflow "${slug}" has no queue` })
  queue.enabled = false
  queue.pausedReason = 'paused by a person'
  await writeQueue(slug, queue)
  return { queue }
})
