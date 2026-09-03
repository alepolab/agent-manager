import { listRuns } from '../../../utils/workflowRunStore'
export default defineEventHandler(async (event) =>
  listRuns(getRouterParam(event, 'slug')!))
