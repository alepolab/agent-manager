import { isTestRun } from '../../../../shared/types/run.ts'
import { listRuns } from '../../../utils/workflowRunStore'

/** A workflow's runs, newest first. Test runs are left out, as on /api/runs,
 *  unless `?tests=1` asks for them: the builder finds its current run here. */
export default defineEventHandler(async (event) => {
  const runs = await listRuns(getRouterParam(event, 'slug')!)
  return getQuery(event).tests === '1' ? runs : runs.filter(r => !isTestRun(r))
})
