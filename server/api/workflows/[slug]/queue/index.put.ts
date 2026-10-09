import { requireCapability } from '../../../../utils/session'
import { readQueue, writeQueue, type WorkflowQueue } from '../../../../utils/workflowQueue'

const STATUSES = ['pending', 'running', 'done', 'stopped']

/**
 * Replace the queue. A running item's record is kept as the server has it:
 * only the server marks an item running or settled.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<WorkflowQueue>(event)
  if (!body || !Array.isArray(body.items) || body.items.some(i => !i?.prompt?.trim() || !STATUSES.includes(i.status))) {
    throw createError({ statusCode: 400, message: 'A queue needs items, each with a prompt and a status (pending, running, done, stopped)' })
  }
  const current = await readQueue(slug)
  const running = current?.items.filter(i => i.status === 'running') ?? []
  const items = body.items.map(i => running.find(r => r.runId && r.runId === i.runId) ?? (i.status === 'running' ? { ...i, status: 'pending' as const, runId: undefined } : i))
  const queue: WorkflowQueue = { enabled: !!body.enabled, pausedReason: body.pausedReason, defaults: body.defaults ?? {}, items }
  await writeQueue(slug, queue)
  return { queue }
})
