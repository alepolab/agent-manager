import { requireCapability } from '../../../../utils/session'
import { readQueue, writeQueue, type WorkflowQueue } from '../../../../utils/workflowQueue'

const STATUSES = ['pending', 'running', 'done', 'stopped']

/**
 * Replace the queue. An item the server has a run for is kept as the server
 * has it whenever either side says it is running: only the server marks an
 * item running or settled. A page loaded before a run settled still shows it
 * running; saving that page must not reset the item to pending and drop its
 * run, or the run can no longer settle it (Bank_Adjustment, 2026-10-14).
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'startRun')
  const slug = getRouterParam(event, 'slug')!
  const body = await readBody<WorkflowQueue>(event)
  if (!body || !Array.isArray(body.items) || body.items.some(i => !i?.prompt?.trim() || !STATUSES.includes(i.status))) {
    throw createError({ statusCode: 400, message: 'A queue needs items, each with a prompt and a status (pending, running, done, stopped)' })
  }
  const current = await readQueue(slug)
  const byRun = new Map((current?.items ?? []).filter(i => i.runId).map(i => [i.runId!, i]))
  const items = body.items.map((i) => {
    const known = i.runId ? byRun.get(i.runId) : undefined
    if (known && (known.status === 'running' || i.status === 'running')) return known
    return i.status === 'running' ? { ...i, status: 'pending' as const, runId: undefined } : i
  })
  const queue: WorkflowQueue = { enabled: !!body.enabled, pausedReason: body.pausedReason, defaults: body.defaults ?? {}, items }
  await writeQueue(slug, queue)
  return { queue }
})
