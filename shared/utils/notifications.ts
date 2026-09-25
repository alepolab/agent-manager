import type { WorkflowRun } from '../types/run'
import type { NotificationItem, PendingPermissionSummary } from '../types/notification'
import { can, type Role } from '../types/role.ts'
import { isWaitingOnAPerson } from '../types/run.ts'

/**
 * Every decision a person owes, in one list: the gates runs are stopped on and
 * the tool-permission prompts /cli chats are stopped on.
 *
 * Pure and free of Vue, Nuxt aliases and I/O, so /api/notifications and
 * scripts/test-notifications.mjs read one implementation.
 */

/** A run's open gate, in one line. The dashboard's queue words its gates with this too. */
export function gateAsk(run: Pick<WorkflowRun, 'status' | 'question'>): string {
  if (run.status === 'awaiting_review') return `${run.question?.artifact ?? 'Its drafts'} is waiting on your decisions`
  if (run.question?.reason === 'budget') return 'Out of budget - approve more, or stop it'
  if (run.question?.reason === 'auth') return 'Could not reach the model - fix the server\'s credentials, then retry'
  if (run.question?.reason === 'rework') return 'Out of send-backs - grant another, or stop it'
  return run.question?.text || 'Paused - open it to see why'
}

/**
 * Is this gate the viewer's to answer? A gate that names no role is everyone's,
 * and an operator is the backstop for all of them. The same rule as
 * `mineToAnswer` on the dashboard and in WorkflowRunPanel.
 */
export function gateIsMine(gateRole: Role | undefined, viewer: Role | undefined | null): boolean {
  // A manager holds no answerGate, so no gate is theirs however it is labelled.
  if (viewer && !can(viewer, 'answerGate')) return false
  return !gateRole || !viewer || viewer === 'operator' || viewer === gateRole
}

/** The one thing a person needs to see first about a tool call. */
export function permissionAsk(p: Pick<PendingPermissionSummary, 'toolName' | 'toolInput'>): string {
  const input = (p.toolInput ?? {}) as Record<string, unknown>
  const first = [input.command, input.file_path, input.path, input.url, input.pattern]
    .find(v => typeof v === 'string' && v)
  if (typeof first === 'string') return first.split('\n')[0]!
  const questions = input.questions
  if (Array.isArray(questions) && typeof questions[0]?.question === 'string') return questions[0].question
  return `Allow ${p.toolName}?`
}

export function buildNotifications(
  runs: WorkflowRun[],
  permissions: PendingPermissionSummary[],
  viewer: Role | undefined | null,
): NotificationItem[] {
  const gates: NotificationItem[] = runs
    .filter(r => !r.dismissed && isWaitingOnAPerson(r.status))
    .map(r => ({
      kind: 'gate',
      id: `run:${r.id}`,
      runId: r.id,
      title: r.ticketKey || (r.initialPrompt.split('\n')[0] ?? '').slice(0, 80) || r.workflowName,
      workflowName: r.workflowName,
      ask: gateAsk(r),
      askedAt: r.question?.askedAt ?? r.startedAt,
      role: r.question?.role,
      mine: gateIsMine(r.question?.role, viewer),
      blastRadius: r.blastRadius,
      review: r.status === 'awaiting_review',
    }))
  // Only the people allowed to answer a prompt are handed any, so each one is theirs.
  const prompts: NotificationItem[] = permissions.map(p => ({
    kind: 'permission',
    id: `permission:${p.id}`,
    title: p.toolName,
    ask: permissionAsk(p),
    askedAt: p.askedAt,
    mine: true,
    permission: p,
  }))
  // A prompt denies itself within minutes, so it goes ahead of any gate. Then
  // what is mine before what is someone else's, and the longest wait first.
  const rank = (n: NotificationItem) => n.kind === 'permission' ? 0 : n.mine ? 1 : 2
  return [...prompts, ...gates].sort((a, b) => rank(a) - rank(b) || a.askedAt - b.askedAt)
}
