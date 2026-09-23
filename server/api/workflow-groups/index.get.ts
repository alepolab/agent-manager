import { listGroups } from '../../utils/workflowGroups.ts'
import { groupLoad } from '../../utils/runQueue.ts'
import { DEFAULT_GROUP_ID } from '../../../shared/types/workflowGroup.ts'

/**
 * Every concurrency group with what it is doing right now, plus the implicit
 * default group.
 *
 * The occupancy is here rather than left to the client because it is derived
 * from the run list and the cap together, and the page's job is to answer "why
 * is my run waiting?" — a cap with no "2 of 2 running" beside it does not.
 *
 * The default group is always listed, whether or not the registry names it: it
 * is where every ungrouped workflow's runs count, and an operator who cannot
 * see it cannot understand a queued run that belongs to no group they created.
 */
export default defineEventHandler(async () => {
  const groups = await listGroups()
  const ids = [...new Set([DEFAULT_GROUP_ID, ...groups.map(g => g.id)])]
  return await Promise.all(ids.map(async (id) => {
    const configured = groups.find(g => g.id === id)
    const load = await groupLoad(id)
    return {
      id,
      name: configured?.name ?? 'Ungrouped',
      maxConcurrent: load.maxConcurrent,
      inFlight: load.inFlight,
      waiting: load.waiting,
      /** True for the default group when nothing in the registry names it —
       *  the page shows it, but there is no row in the file to edit. */
      implicit: !configured,
    }
  }))
})
