import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentRunsRoot } from './runArtifacts.ts'
import type { WorkflowRun, RunCi } from '~~/shared/types/run'

/**
 * Tells a person a run needs them: paused, completed, failed, stopped,
 * interrupted, or a pull request that went red after the run ended.
 *
 * Two sinks, deliberately, because for six weeks there was one and it was off.
 * A platform review of thirteen real runs found the Slack path code-complete
 * and never once fired: it returns early unless SLACK_WEBHOOK_URL is set, and
 * the container running the pipeline has no such variable. A run that sat
 * paused on its budget for twenty hours and a gate that went fifteen hours
 * unanswered notified nobody, and nothing anywhere recorded that a
 * notification had been due. So:
 *
 *  - notifications.jsonl under the runs root is appended to ALWAYS, webhook or
 *    not. It is the record that survives "alerting was never wired up", and it
 *    is how the next review can count what a person should have been told.
 *  - The webhook is still best-effort and still optional. Its absence is now
 *    VISIBLE instead of silent: preflight reports it as a warn-level check.
 *    No webhook is invented here — an unset variable means an unset variable.
 *
 * Every notification carries WHY it fired. "Runbook: PAUSED" reads the same
 * whether a person has to approve more budget, answer a gate, restart a dead
 * process or look at a red check — four different reactions, and the message
 * used to leave the reader to work out which.
 */
const NOTIFY_ON: WorkflowRun['status'][] = ['paused', 'completed', 'failed', 'stopped', 'interrupted']

export type NotifyReason =
  | 'paused-on-budget'
  | 'paused-on-gate'
  | 'failed'
  | 'interrupted'
  | 'stopped'
  | 'completed'
  | 'ci-failing'

/** What the reader is expected to DO about it. One line per reason, because a
 *  reason nobody can act on is a status line with extra words. */
const REACTION: Record<NotifyReason, string> = {
  'paused-on-budget': 'Nothing is running: the budget is spent. Grant more on the run page, or stop the run.',
  'paused-on-gate': 'Nothing is running: it is waiting for an answer at a gate on the run page.',
  'failed': 'The run stopped on an error. Read the failed step before restarting it.',
  'interrupted': 'The process that owned this run died. It stays frozen until someone restarts it.',
  'stopped': 'A person stopped this run.',
  'completed': 'Finished. Check the pull request and its checks.',
  'ci-failing': 'A check on the pull request this run opened is red. Nothing re-runs it automatically.',
}

/**
 * Announced-once bookkeeping, keyed by SINK as well as run, on purpose: the
 * ledger and the webhook are independent. A run whose status was recorded while
 * no webhook existed must still be messaged if one is configured later in the
 * same process, and a webhook that is up must not be silenced by a ledger line.
 */
const lastNotified = new Map<string, string>()

export type Poster = (url: string, body: unknown) => Promise<void>

let poster: Poster = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`)
}

/** Test seam. */
export function setPoster(fn: Poster) { poster = fn }

export function _resetNotified() { lastNotified.clear() }

/** The sink that works with nothing configured. One JSON line per notification. */
export function notificationsLogPath(): string {
  return join(agentRunsRoot(), 'notifications.jsonl')
}

/** Best-effort by design: a notification that cannot be written must never
 *  fail a run, and a full or read-only disk is not this module's to solve. */
async function record(entry: Record<string, unknown>): Promise<void> {
  const path = notificationsLogPath()
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`)
  } catch (err) {
    // A runs root that vanished under the append — a test's temp directory, a
    // volume being recreated — is not this module's problem and must not print
    // an error path of its own into every log. Anything else (a full disk, a
    // read-only mount) is worth one line.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[notify] could not append to notifications.jsonl:', err instanceof Error ? err.message : err)
    }
  }
}

/** Why a transition is worth a person's attention, from the run itself.
 *  `question.reason === 'budget'` is the runner's own marker for "the budget is
 *  spent and continuing grants another allowance" — the twenty-hour pause. */
export function reasonFor(run: WorkflowRun): NotifyReason | null {
  switch (run.status) {
    case 'paused': return run.question?.reason === 'budget' ? 'paused-on-budget' : 'paused-on-gate'
    case 'failed': return 'failed'
    case 'interrupted': return 'interrupted'
    case 'stopped': return 'stopped'
    case 'completed': return 'completed'
    default: return null
  }
}

function baseUrlOf(): string {
  return (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
}

export function runMessage(run: WorkflowRun, baseUrl: string): string {
  const step = run.steps.find(s => s.status === 'failed')?.label
    ?? run.steps.find(s => run.currentStepIds.includes(s.stepId))?.label
    ?? run.steps.find(s => run.nextStepIds.includes(s.stepId))?.label
  const what = (run.initialPrompt.split('\n')[0] ?? '').slice(0, 80)
  const why = run.error ? ` — ${run.error.slice(0, 160)}` : ''
  return `${run.workflowName}: ${run.status.toUpperCase()}${step ? ` at ${step}` : ''} — ${what}${why}\n${baseUrl}/workflows/${run.workflowSlug}?run=${run.id}`
}

/** Both sinks, each deduplicated on its own key. Never throws, never awaits. */
function announce(run: WorkflowRun, reason: NotifyReason, text: string, extra: Record<string, unknown> = {}, keySuffix = ''): void {
  const key = `${run.id}:${reason}${keySuffix}`
  const url = process.env.SLACK_WEBHOOK_URL

  if (lastNotified.get(`log:${key}`) !== reason) {
    lastNotified.set(`log:${key}`, reason)
    void record({
      at: Date.now(),
      runId: run.id,
      workflow: run.workflowName,
      ticket: run.ticketKey,
      status: run.status,
      reason,
      reaction: REACTION[reason],
      text,
      url: `${baseUrlOf()}/workflows/${run.workflowSlug}?run=${run.id}`,
      delivered: url ? 'webhook+log' : 'log-only (SLACK_WEBHOOK_URL is unset)',
      ...extra,
    })
  }

  if (!url) return
  if (lastNotified.get(`post:${key}`) === reason) return
  lastNotified.set(`post:${key}`, reason)
  // Fire and forget: a notification that fails must never fail a run.
  void poster(url, { text: `${text}\n${REACTION[reason]}`, reason, runId: run.id, ...extra }).catch((err) => {
    console.error('[notify] Slack webhook failed:', err instanceof Error ? err.message : err)
  })
}

export function notifyRunTransition(run: WorkflowRun): void {
  const reason = NOTIFY_ON.includes(run.status) ? reasonFor(run) : null
  if (!reason) return
  announce(run, reason, runMessage(run, baseUrlOf()))
}

/**
 * A pull request this run opened has gone red. Called by the CI poller, which
 * runs long after the run itself settled — the state nobody in the pipeline was
 * ever told about, because the poller recorded the verdict on the run record
 * and stopped there.
 */
export function notifyCiFailing(run: WorkflowRun, ci: RunCi): void {
  const bad = ci.checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
  const text = `${run.workflowName}: CI FAILING on ${ci.pr}${bad.length ? ` — ${bad.slice(0, 5).join(', ')}` : ''}`
    + `\n${baseUrlOf()}/workflows/${run.workflowSlug}?run=${run.id}`
  // Keyed by pull request as well as run: a multi-repo run has one bucket per
  // repo, and the second one going red is news the first one does not carry.
  announce(run, 'ci-failing', text, { pr: ci.pr, failing: bad }, `:${ci.pr}`)
}

/**
 * A gate has been waiting for a person longer than anyone intended.
 *
 * Called from the CI poller's tick, which is the only clock this app has. One
 * run sat 16.8 hours on an unanswered question against 104 minutes of work, and
 * across thirteen runs three quarters of the calendar time is this. A reminder,
 * not an escalation: nothing here answers a gate or stops a run.
 */
export function notifyGateWaiting(run: WorkflowRun, waitedMinutes: number): void {
  const label = run.steps.find(s => s.stepId === run.question?.stepId)?.label ?? 'a gate'
  const hours = waitedMinutes >= 90 ? `${Math.round(waitedMinutes / 60)}h` : `${waitedMinutes} min`
  const text = `${run.workflowName}: waiting ${hours} for a decision on "${label}"`
    + `${run.ticketKey ? ` (${run.ticketKey})` : ''}\n${baseUrlOf()}/runs/${run.id}`
  announce(run, 'paused-on-gate', text, { waitedMinutes, step: label }, `:gate:${run.question?.stepId ?? ''}`)
}

/** Everything a transition should trigger; called from the runner's publish.
 *  The Jira write-back lives in ticketNotifier.ts, gated by JIRA_POST_ENABLED. */
export function onRunTransition(run: WorkflowRun): void {
  notifyRunTransition(run)
}
