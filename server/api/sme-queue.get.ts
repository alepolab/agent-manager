import { isTestRun, isWaitingOnAPerson } from '../../shared/types/run.ts'
import { currentUser } from '../utils/session.ts'
import { currentAssignment } from '../utils/smeDirectory.ts'
import { listRuns } from '../utils/workflowRunStore.ts'

/**
 * The gates routed to one person, oldest due first: `?assignee=me` for the
 * caller, or a login. Every role may read it - it names who is waiting on whom,
 * which is what a manager's board exists to show - and the routes that take the
 * decision still enforce the role.
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const user = await currentUser(event)
  const who = String(q.assignee ?? 'me')
  const assignee = who === 'me' ? user?.login : who
  if (!assignee) throw createError({ statusCode: 400, message: 'Say whose queue: ?assignee=me needs a signed-in user, or name a login.' })
  const now = Date.now()
  const items = (await listRuns())
    .filter(r => !isTestRun(r) && !r.dismissed && isWaitingOnAPerson(r.status) && r.question?.assignee === assignee)
    .map((r) => {
      const a = currentAssignment(r)
      return {
        runId: r.id,
        workflowName: r.workflowName,
        ticketKey: r.ticketKey,
        product: r.product?.name,
        blastRadius: r.blastRadius,
        gate: r.question!.stepId,
        label: r.steps.find(s => s.stepId === r.question!.stepId)?.label ?? r.question!.stepId,
        ask: r.question!.text,
        assignedAt: a?.assignedAt ?? r.question!.askedAt,
        dueAt: a?.dueAt,
        overdue: !!a && now > a.dueAt,
        delegatedFrom: a?.delegatedFrom,
        escalatedTo: a?.escalatedTo,
      }
    })
    .sort((x, y) => (x.dueAt ?? x.assignedAt) - (y.dueAt ?? y.assignedAt))
  return { assignee, items }
})
