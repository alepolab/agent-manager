import { readQueue } from '../../../../utils/workflowQueue'

/** The workflow's run queue, or null when it has none. */
export default defineEventHandler(async (event) => {
  return { queue: await readQueue(getRouterParam(event, 'slug')!) }
})
