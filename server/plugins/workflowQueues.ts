/**
 * Moves workflow run queues on after a restart (see reconcileQueues).
 *
 * After resumeInterrupted's own delay, so a run it resumes is already running
 * again and its queue item is not mistaken for one that needs starting.
 * WORKFLOW_QUEUE_DISABLED=1 turns it off.
 */
import { reconcileQueues } from '../utils/workflowQueue.ts'

export default defineNitroPlugin(() => {
  if (process.env.WORKFLOW_QUEUE_DISABLED === '1') return
  setTimeout(() => {
    reconcileQueues()
      .then((lines) => { for (const l of lines) console.log(`[queue] ${l}`) })
      .catch(err => console.error('[queue] could not reconcile workflow queues:', err?.message ?? err))
  }, 15000)
})
