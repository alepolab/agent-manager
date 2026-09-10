import { channelUrl, getChannel, getSmtp, type Channel } from './channels.ts'
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * Everything that leaves this app as a message to a person, and the one seam
 * that stubs it.
 *
 * Two callers: `notifyRunTransition`, when a run reaches a state somebody has to
 * act on (paused, awaiting review, completed, failed, stopped, interrupted), and
 * the notify step in notifySteps.ts, when a workflow says so at a point of its
 * own choosing. Both post through `poster`, so one `setPoster()` in a test
 * covers both. Nothing is sent while a run is merely running, and each status is
 * announced once per run so a burst of publishes does not become a burst of
 * messages. No channel and no webhook configured means no messages and no
 * errors.
 */
const NOTIFY_ON: WorkflowRun['status'][] = ['paused', 'awaiting_review', 'completed', 'failed', 'stopped', 'interrupted']
const lastNotified = new Map<string, WorkflowRun['status']>()

export type Poster = (url: string, body: unknown) => Promise<void>

let poster: Poster = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // A notify STEP awaits its own send, unlike a transition message, so an
    // unreachable host must stall one step briefly rather than a run for as
    // long as the platform's default timeout happens to be.
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`the webhook answered ${res.status}`)
}

/** Test seam. */
export function setPoster(fn: Poster) { poster = fn }

export function _resetNotified() { lastNotified.clear() }

export function baseUrl(): string {
  return (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
}

/** Where a person goes to act on this run: the only expression that knows the shape. */
export function runLink(run: Pick<WorkflowRun, 'id' | 'workflowSlug'>, base = baseUrl()): string {
  return `${base}/workflows/${run.workflowSlug}?run=${run.id}`
}

/**
 * The body a channel's product expects.
 *
 * Teams is two products behind one word. A URL issued by Power Automate
 * ("Workflows", the only kind Microsoft creates now) rejects a bare `{ text }`
 * and needs an Adaptive Card envelope; a surviving O365 connector URL on
 * outlook.office.com accepts `{ text }` as a MessageCard. Guessing wrong is the
 * worst failure a notification has — the POST returns 200 and no message ever
 * appears — so the host decides, rather than an operator having to know which
 * generation of webhook they were handed.
 */
export function bodyFor(kind: Channel['kind'], url: string, text: string): unknown {
  if (kind === 'slack') return { text }
  const host = (() => { try { return new URL(url).host } catch { return '' } })()
  if (!/\.logic\.azure\.com$|\.powerplatform\.com$|\.azure-api\.net$/.test(host)) return { text }
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: [{ type: 'TextBlock', text, wrap: true }],
      },
    }],
  }
}

export type Mailer = (
  smtp: { host: string, port: number, secure?: boolean, user?: string, password?: string, from: string },
  mail: { to: string[], subject: string, text: string },
) => Promise<void>

/**
 * Imported lazily so nodemailer is loaded only by an instance that actually
 * sends mail - the two webhook kinds are a bare fetch and should not pull an
 * SMTP client into the server's startup path.
 */
let mailer: Mailer = async (smtp, mail) => {
  const { createTransport } = await import('nodemailer')
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: !!smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
  })
  await transport.sendMail({ from: smtp.from, to: mail.to.join(', '), subject: mail.subject, text: mail.text })
}

/** Test seam, the twin of setPoster. */
export function setMailer(fn: Mailer) { mailer = fn }

/**
 * The subject line. A message is one sentence then its details, and an inbox
 * shows only the first line, so the subject is that sentence - not a fixed
 * banner that would make every escalation look identical in a mail list.
 */
function subjectFor(text: string): string {
  const first = (text.split('\n')[0] ?? '').trim()
  return first.slice(0, 120) || 'Agent Manager notification'
}

/** Posts one message to a channel. Throws on a delivery problem; the caller decides what that means. */
export async function sendToChannel(channel: Channel, text: string): Promise<void> {
  if (channel.kind === 'email') {
    const smtp = await getSmtp()
    if (!smtp) throw new Error('no SMTP relay is configured on this instance')
    const to = channel.to ?? []
    if (!to.length) throw new Error(`the channel "${channel.name}" has no recipients`)
    await mailer(smtp, { to, subject: subjectFor(text), text })
    return
  }
  const url = channelUrl(channel)
  await poster(url, bodyFor(channel.kind, url, text))
}

/** Posts to a channel by name. Throws when this instance configures no such channel. */
export async function sendToChannelNamed(name: string, text: string): Promise<void> {
  const channel = await getChannel(name)
  if (!channel) throw new Error(`no channel named "${name}" is configured on this instance`)
  await sendToChannel(channel, text)
}

export function runMessage(run: WorkflowRun, base: string): string {
  const step = run.steps.find(s => s.status === 'failed')?.label
    ?? run.steps.find(s => run.currentStepIds.includes(s.stepId))?.label
    ?? run.steps.find(s => run.nextStepIds.includes(s.stepId))?.label
  const what = (run.initialPrompt.split('\n')[0] ?? '').slice(0, 80)
  const why = run.error ? ` — ${run.error.slice(0, 160)}` : ''
  // What is being asked, when something is. Without it an awaiting_review
  // message reads only "AWAITING_REVIEW at <step>", which names the step but not
  // the decision — and the decision is the whole reason the message was sent.
  const asked = run.question?.text ? `
${run.question.text}` : ''
  return `${run.workflowName}: ${run.status.toUpperCase()}${step ? ` at ${step}` : ''} — ${what}${why}${asked}
${runLink(run, base)}`
}

/**
 * Where a run's transition messages go, in order: the channel its workflow
 * named, then a channel called `default`, then the legacy env webhook.
 *
 * `run.notifyChannel` is snapshotted onto the run at creation the way `group`
 * is, because publish() holds a run and never the workflow definition it came
 * from.
 *
 * SLACK_WEBHOOK_URL stays last, and stays: it is what existing deployments are
 * configured with, and migrating to a named channel is not something this
 * change should require of them.
 */
async function transitionPost(run: WorkflowRun): Promise<(() => Promise<void>) | null> {
  for (const name of [run.notifyChannel, 'default']) {
    if (!name) continue
    const channel = await getChannel(name).catch(() => null)
    if (channel) return () => sendToChannel(channel, runMessage(run, baseUrl()))
  }
  const url = process.env.SLACK_WEBHOOK_URL
  if (url) return () => poster(url, { text: runMessage(run, baseUrl()) })
  return null
}

/**
 * Returns the delivery promise, which no production caller awaits — publish()
 * must never block on a webhook. It is returned so a test can await the send
 * instead of racing it: resolving a NAMED channel reads from disk, so delivery
 * is no longer synchronous the way a bare env-var webhook was.
 */
export function notifyRunTransition(run: WorkflowRun): Promise<void> {
  if (!NOTIFY_ON.includes(run.status)) return Promise.resolve()
  if (lastNotified.get(run.id) === run.status) return Promise.resolve()
  // Claimed synchronously, before resolving the channel. Two publishes of the
  // same status can arrive in one tick, and a mark that waited for the await
  // would let both through.
  const previous = lastNotified.get(run.id)
  lastNotified.set(run.id, run.status)
  // Fire and forget: a notification that fails must never fail a run.
  return transitionPost(run)
    .then((post) => {
      if (post) return post()
      // Nothing configured. Release the claim, so an instance that gains a
      // channel later is not deduped against a message that was never sent.
      if (lastNotified.get(run.id) !== run.status) return
      if (previous === undefined) lastNotified.delete(run.id)
      else lastNotified.set(run.id, previous)
    })
    .catch((err) => {
      console.error('[notify] run transition message failed:', err instanceof Error ? err.message : err)
    })
}

/** Everything a transition should trigger; called from the runner's publish.
 *  The Jira write-back lives in ticketNotifier.ts, gated by JIRA_POST_ENABLED. */
export function onRunTransition(run: WorkflowRun): void {
  notifyRunTransition(run)
}
