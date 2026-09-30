import { defaultBudget, getRun, listRuns } from '../../../utils/workflowRunStore.ts'
import { budgetBrief } from '../../../../shared/utils/budgetBrief.ts'
import { computeUsage } from '../../../utils/workflowRunner.ts'

/** What a person needs to decide a budget pause - see shared/utils/budgetBrief.ts. */
export default defineEventHandler(async (event) => {
  const run = await getRun(getRouterParam(event, 'id')!)
  if (!run) throw createError({ statusCode: 404, message: 'Run not found' })
  const fresh = defaultBudget()
  // From the steps, as the budget check counts it: run.usage is only as fresh
  // as the last publish, and a brief read later would show a stale figure.
  return budgetBrief({ ...run, usage: computeUsage(run) }, await listRuns(run.workflowSlug), { minutes: fresh.maxMinutes, tokens: fresh.maxTokens })
})
