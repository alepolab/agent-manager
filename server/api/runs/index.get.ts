import { listRuns } from '../../utils/workflowRunStore'
export default defineEventHandler(async () => listRuns())
