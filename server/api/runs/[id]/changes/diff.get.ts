import { getRun } from '../../../../utils/workflowRunStore.ts'
import { computeFileDiff } from '../../../../utils/gitFacts.ts'

/** One changed file's diff since the run's baseline: `?path=` as the change list names it. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  const path = getQuery(event).path
  if (typeof path !== 'string' || !path) throw createError({ statusCode: 400, message: 'path is required' })
  const diff = await computeFileDiff(run.projectDir, run.baseCommit, path)
  if (!diff) throw createError({ statusCode: 404, message: "No diff for that file: it is not one this run changed, or the run's checkout is gone" })
  return diff
})
