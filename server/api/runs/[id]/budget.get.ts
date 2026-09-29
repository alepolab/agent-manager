import { defaultBudget, getRun, listRuns } from '../../../utils/workflowRunStore.ts'
import { budgetBrief } from '../../../../shared/utils/budgetBrief.ts'

/** What a person needs to decide a budget pause - see shared/utils/budgetBrief.ts. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  const fresh = defaultBudget()
  return budgetBrief(run, await listRuns(run.workflowSlug), { minutes: fresh.maxMinutes, tokens: fresh.maxTokens })
})
