/**
 * The SME SLA clock: say when an assigned gate is due, and escalate when it has
 * waited a day.
 *
 * One pass per ciPoller tick (server/utils/ciPoller.ts, 60s by default), the
 * same cadence and the same shape as `requestReviewsOnce`: read the runs, act
 * on the ones that need it, record on the run that the notice went so the next
 * tick never repeats it. A run whose gate has been answered is skipped - its
 * assignment is history, not a debt.
 *
 * Business hours are ignored for now, as the brief says: dueAt is four wall
 * clock hours after assignment. A gate assigned on Friday evening is "overdue"
 * on Friday night. That is the honest state of the clock until a calendar is
 * configured; the message says "due", not "late".
 */
import { isTestRun, isWaitingOnAPerson, type WorkflowRun } from '../../shared/types/run.ts'
import { SME_ESCALATION_MS } from '../../shared/types/sme.ts'
import { notifyAboutRun } from './notify.ts'
import { currentAssignment, podLeadFor } from './smeDirectory.ts'
import { getRun, listRuns, saveRun } from './workflowRunStore.ts'
import { createLogger } from './log.ts'

const log = createLogger('sme')

export type SlaNotifier = (run: WorkflowRun, text: string) => Promise<boolean>
let notifier: SlaNotifier = notifyAboutRun
/** Test seam. */
export function setSlaNotifier(fn: SlaNotifier) { notifier = fn }

const title = (run: WorkflowRun) => run.ticketKey || (run.initialPrompt.split('\n')[0] ?? '').slice(0, 80) || run.workflowName
const gateLabel = (run: WorkflowRun) => run.steps.find(s => s.stepId === run.question?.stepId)?.label ?? run.question?.stepId ?? 'a gate'
const hours = (ms: number) => `${Math.round(ms / 36_000) / 100}h`

/** One pass. Returns how many notices went out (due + escalations). */
export async function smeSlaTick(now = Date.now()): Promise<{ due: number, escalated: number }> {
  let due = 0, escalated = 0
  for (const run of await listRuns()) {
    if (isTestRun(run) || !isWaitingOnAPerson(run.status) || run.dismissed) continue
    const a = currentAssignment(run)
    if (!a) continue
    const waited = now - a.assignedAt
    const wantsDue = !a.notifiedDueAt && now >= a.dueAt
    const lead = podLeadFor(run.product?.name)
    const wantsEscalation = !a.escalatedAt && waited >= SME_ESCALATION_MS && !!lead
    if (!wantsDue && !wantsEscalation) continue

    // Re-read before writing: the listing may be stale and the record is shared.
    const fresh = await getRun(run.id)
    const current = fresh ? currentAssignment(fresh) : undefined
    if (!fresh || !current || current.assignedAt !== a.assignedAt) continue

    if (wantsDue) {
      const sent = await notifier(fresh, `@${current.assignee}: "${gateLabel(fresh)}" on ${title(fresh)} has waited ${hours(waited)} and is due.`)
      if (sent) { current.notifiedDueAt = now; due++ }
    }
    if (wantsEscalation && lead) {
      const sent = await notifier(fresh, `@${lead}: "${gateLabel(fresh)}" on ${title(fresh)} has waited ${hours(waited)} on @${current.assignee} without an answer. Escalated to you as ${fresh.product?.name}'s pod lead.`)
      if (sent) { current.escalatedAt = now; current.escalatedTo = lead; escalated++ }
    }
    if (current.notifiedDueAt === now || current.escalatedAt === now) {
      await saveRun(fresh)
      log.info('sme sla notice', { runId: fresh.id, assignee: current.assignee, due: current.notifiedDueAt === now, escalated: current.escalatedAt === now })
    }
  }
  return { due, escalated }
}
