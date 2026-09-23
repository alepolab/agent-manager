import { getRun } from '../../../utils/workflowRunStore'
import { subscribe, subscribeLog, getLiveLog } from '../../../utils/workflowRunner'
import { isLiveStatus } from '../../../../shared/types/run.ts'
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
  send({ type: 'log-snapshot', logs: await getLiveLog(id) })

  // isLiveStatus, so a `queued` run is not "finished": the stream stays open
  // and follows it into `running` when the queue launches it. Ending it here
  // would tell every watcher the run was over before it had begun.
  const finished = (r: WorkflowRun) => !isLiveStatus(r.status)

  if (finished(initial)) {
    send({ type: 'done' })
    event.node.res.end()
    return
  }

  await new Promise<void>((resolve) => {
    const unsubscribeLog = subscribeLog(id, (stepId, line) => send({ type: 'log', stepId, line }))
    const unsubscribe = subscribe(id, (run) => {
      send({ type: 'run', run })
      if (finished(run)) { send({ type: 'done' }); cleanup(); resolve() }
    })
    const cleanup = () => { unsubscribe(); unsubscribeLog(); try { event.node.res.end() } catch { /* already closed */ } }
    // The run is not the connection: a client leaving must not affect it.
    event.node.req.on('close', () => { unsubscribe(); unsubscribeLog(); resolve() })
  })
})
