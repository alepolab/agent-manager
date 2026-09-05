import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runArtifactsDir } from './runArtifacts.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const execFileP = promisify(execFile)

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

export type Commenter = (key: string, body: string) => Promise<void>
let commenter: Commenter = async (key, body) => {
  await execFileP('jira', ['issue', 'comment', 'add', key, body], { timeout: 60_000 })
}
export function setCommenter(fn: Commenter) { commenter = fn }
const lastCommented = new Map<string, WorkflowRun['status']>()

/** The ticket key a run was started for, if its prompt names one. */
export function ticketKeyOf(run: WorkflowRun): string | null {
  return run.initialPrompt.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1] ?? null
}

async function prUrlOf(run: WorkflowRun): Promise<string | null> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    const repos = Array.isArray(meta?.fix?.repos) ? meta.fix.repos : []
    const pr = repos.map((r: any) => r?.pr).find((u: unknown) => typeof u === 'string' && u.startsWith('http') && !u.includes('example.invalid'))
    return pr ?? null
  } catch {
    return null
  }
}

/**
 * Writes the outcome back to the Jira ticket as a comment when the jira CLI
 * is the ticket source: a person watching the ticket learns the run ended,
 * what it produced and where to look, without opening Agent Manager. Only
 * terminal statuses are commented; a pause is the operator's own business.
 */
export async function commentTicket(run: WorkflowRun): Promise<void> {
  if (process.env.JIRA_TICKET_SOURCE !== 'cli') return
  if (!['completed', 'failed', 'stopped'].includes(run.status)) return
  const key = ticketKeyOf(run)
  if (!key || lastCommented.get(run.id) === run.status) return
  lastCommented.set(run.id, run.status)
  const baseUrl = (process.env.AGENT_MANAGER_URL || 'http://localhost:3030').replace(/\/$/, '')
  const pr = await prUrlOf(run)
  const lines = [
    `Agent Manager run ${run.status}: ${run.workflowName}`,
    pr ? `PR: ${pr}` : '',
    run.error ? `Reason: ${run.error.slice(0, 200)}` : '',
    run.usage ? `Cost: $${run.usage.usd.toFixed(2)}` : '',
    `Run: ${baseUrl}/workflows/${run.workflowSlug}?run=${run.id}`,
  ].filter(Boolean)
  try {
    await commenter(key, lines.join('\n'))
  } catch (err) {
    console.error(`[notify] jira comment on ${key} failed:`, err instanceof Error ? err.message : err)
  }
}
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

/** Everything a transition should trigger; called from the runner's publish. */
export function onRunTransition(run: WorkflowRun): void {
  notifyRunTransition(run)
  void commentTicket(run)
}
