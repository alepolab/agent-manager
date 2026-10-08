import { getRun } from '../../../utils/workflowRunStore.ts'
import { runTicketTitle } from '../../../utils/ticketTitle.ts'

/** The run's ticket key and its Jira title, for the top of an opened gate. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return { key: run.ticketKey ?? null, title: await runTicketTitle(run) }
})
