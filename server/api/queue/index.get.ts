import { requireUser } from '../../utils/session'
import { reconcile, eligible } from '../../utils/taskQueue'

/** The whole project, always — the point of the queue is that nothing is hidden. */
export default defineEventHandler(async (event) => {
  await requireUser(event)
  const queue = await reconcile()
  const ready = new Set(eligible(queue).map(t => t.id))
  return {
    ...queue,
    // Computed here rather than in the page: "ready" is a dependency question,
    // and two implementations of it would eventually disagree.
    tasks: queue.tasks.map(t => ({ ...t, ready: ready.has(t.id) })),
  }
})
