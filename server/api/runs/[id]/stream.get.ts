import { getRun } from '../../../utils/workflowRunStore'
import { subscribe } from '../../../utils/workflowRunner'
import type { WorkflowRun } from '~~/shared/types/run'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const initial = await getRun(id)
  if (!initial) throw createError({ statusCode: 404, message: 'Run not found' })

  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const send = (payload: unknown) => {
    event.node.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  // The full run first, so a late subscriber is immediately correct rather
  // than waiting for the next change.
  send({ type: 'run', run: initial })

  const finished = (r: WorkflowRun) =>
    r.status !== 'running' && r.status !== 'paused'

  if (finished(initial)) {
    send({ type: 'done' })
    event.node.res.end()
    return
  }

  await new Promise<void>((resolve) => {
    const unsubscribe = subscribe(id, (run) => {
      send({ type: 'run', run })
      if (finished(run)) { send({ type: 'done' }); cleanup(); resolve() }
    })
    const cleanup = () => { unsubscribe(); try { event.node.res.end() } catch { /* already closed */ } }
    // The run is not the connection: a client leaving must not affect it.
    event.node.req.on('close', () => { unsubscribe(); resolve() })
  })
})
