/**
 * Sweeps the run queue at boot and on a slow timer.
 *
 * A settling run already hands its slot straight to the next waiter — publish()
 * drains the moment a run reaches a terminal status. This exists for the case
 * where nothing settles: a run whose owning process died never publishes
 * anything, because the writer is the thing that died. Its slot IS freed, since
 * workflowRunStore's applyInterrupted derives `interrupted` on read, but nobody
 * is left to notice, and every run queued behind it would wait for the life of
 * the instance. The boot sweep is the same case one restart later.
 *
 * A minute, not a second, and short-circuited on mightHaveWaiting(): a sweep
 * costs a listRuns(), which parses every run record and signals every owning
 * pid, and the normal state of an instance is nothing queued at all.
 *
 * RUN_QUEUE_DISABLED=1 keeps a test or smoke boot from starting runs on a
 * timer, matching SCHEDULER_DISABLED and CI_POLLER_DISABLED.
 */
import { drainRunQueue, mightHaveWaiting } from '../utils/runQueue.ts'
import { launchQueuedRun } from '../utils/workflowRunner.ts'
import { createLogger } from '../utils/log.ts'

const log = createLogger('runner')
const TICK_MS = 60_000

export default defineNitroPlugin(() => {
  if (process.env.RUN_QUEUE_DISABLED === '1') return

  const sweep = () => {
    if (!mightHaveWaiting()) return
    void drainRunQueue(launchQueuedRun)
      .then(started => { if (started) log.info('run queue swept', { started }) })
      .catch(err => log.warn('sweeping the run queue failed', { error: err instanceof Error ? err.message : String(err) }))
  }

  // At boot, before the first tick: runs queued by the process that is being
  // replaced are waiting for exactly this.
  sweep()
  const timer = setInterval(sweep, TICK_MS)
  timer.unref?.()
  log.info('run queue sweeper started', { tickMs: TICK_MS })
})
