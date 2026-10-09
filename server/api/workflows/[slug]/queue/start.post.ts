import { requireCapability } from '../../../../utils/session'
import { readQueue, resumeQueue } from '../../../../utils/workflowQueue'

/** Turn the queue on and start its next item, unless one is already running. */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const slug = getRouterParam(event, 'slug')!
  if (!await readQueue(slug)) throw createError({ statusCode: 404, message: `Workflow "${slug}" has no queue` })
  const started = await resumeQueue(slug)
  return { started, queue: await readQueue(slug) }
})
