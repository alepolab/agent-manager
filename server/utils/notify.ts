import type { WorkflowRun } from '~~/shared/types/run'

/**
 * Posts a one-line message to a Slack incoming webhook when a run reaches a
 * state a person has to act on: paused, completed, failed, stopped or
 * interrupted. Nothing is sent while a run is merely running, and each status
 * is announced once per run so a burst of publishes does not become a burst of
 * messages. No webhook configured means no messages and no errors.
 */
const NOTIFY_ON: WorkflowRun['status'][] = ['paused', 'completed', 'failed', 'stopped', 'interrupted']
const lastNotified = new Map<string, WorkflowRun['status']>()

export type Poster = (url: string, body: unknown) => Promise<void>

let poster: Poster = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Slack webhook answered ${res.status}`)
}

/** Test seam. */
export function setPoster(fn: Poster) { poster = fn }
export function _resetNotified() { lastNotified.clear() }

export function runMessage(run: WorkflowRun, baseUrl: string): string {
  const step = run.steps.find(s => s.status === 'failed')?.label
    ?? run.steps.find(s => run.currentStepIds.includes(s.stepId))?.label
    ?? run.steps.find(s => run.nextStepIds.includes(s.stepId))?.label
  const what = run.initialPrompt.split('\n')[0].slice(0, 80)
  const cost = run.usage ? ` · $${run.usage.usd.toFixed(2)}` : ''
  const why = run.error ? ` — ${run.error.slice(0, 160)}` : ''
  return `${run.workflowName}: ${run.status.toUpperCase()}${step ? ` at ${step}` : ''} — ${what}${cost}${why}\n${baseUrl}/workflows/${run.workflowSlug}?run=${run.id}`
}

export function notifyRunTransition(run: WorkflowRun): void {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url || !NOTIFY_ON.includes(run.status)) return
  if (lastNotified.get(run.id) === run.status) return
  lastNotified.set(run.id, run.status)
  const baseUrl = (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
  // Fire and forget: a notification that fails must never fail a run.
  void poster(url, { text: runMessage(run, baseUrl) }).catch((err) => {
    console.error('[notify] Slack webhook failed:', err instanceof Error ? err.message : err)
  })
}
