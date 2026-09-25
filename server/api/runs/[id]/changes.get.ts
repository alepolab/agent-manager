import { getRun } from '../../../utils/workflowRunStore.ts'
import { computeChangeSummary } from '../../../utils/gitFacts.ts'

/** The files and commits a run made since its own baseline, measured from git.
 *  `null` when nothing is measurable - see computeChangeSummary. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  return await computeChangeSummary(run.projectDir, run.baseCommit)
})
