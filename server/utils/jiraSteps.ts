import { isJiraPostingEnabled, jiraAuthHeader } from './jiraCredentials.ts'
import { credentialsFor, notifyTicketOutcome } from './ticketNotifier.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run'

/** A workflow step the runner executes itself: move the ticket, post the outcome comment, or both. */
export interface JiraStepConfig {
  /** Target status name, matched case-insensitively against the transitions the ticket offers right now. */
  transition?: string
  /** Post the run's outcome comment (the same one the notifier renders when a run settles). */
  comment?: boolean
}

/**
 * Runs one Jira step and returns what happened, one sentence per action, as
 * the step's output. Nothing here throws for a Jira problem: a ticket that
 * cannot be moved is reported in the output and the run goes on, because the
 * code work is done whatever Jira says. Writes need JIRA_POST_ENABLED=1, the
 * same opt-in the settle-time comment needs; without it the step records what
 * it would have done.
 */
export async function runJiraStep(run: WorkflowRun, cfg: JiraStepConfig, fetchImpl: FetchLike = fetch): Promise<string> {
  const key = run.ticketKey
  if (!key) return 'PIPELINE-SKIP: this run has no ticket key, so there is nothing in Jira to move or to comment on.'
  const lines: string[] = []
  if (cfg.transition) lines.push(await moveTicket(run, key, cfg.transition, fetchImpl))
  if (cfg.comment) {
    // The notifier renders, records the artifact and posts only when enabled.
    // The run is still 'running' while this step executes; every step of work
    // before it has completed, which is what the comment describes.
    const result = await notifyTicketOutcome({ id: run.watch, name: run.workflowName }, key, { ...run, status: 'completed' }, {}, fetchImpl)
    lines.push(result.posted ? `Comment posted on ${key}.` : `Comment recorded, not posted: ${result.reason}.`)
    run.ticketCommented = true
  }
  return lines.join('\n') || 'Nothing configured for this Jira step: set a status to move to, or the outcome comment, in the workflow builder.'
}

async function moveTicket(run: WorkflowRun, key: string, target: string, fetchImpl: FetchLike): Promise<string> {
  if (!isJiraPostingEnabled()) return `Would move ${key} to "${target}"; not done: JIRA_POST_ENABLED is not 1 on this instance.`
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`
  const listed = await fetchImpl(url, { headers })
  if (!listed.ok) return `Could not read the transitions of ${key} (HTTP ${listed.status}); the ticket was not moved.`
  const transitions = (((await listed.json()) as { transitions?: { id: string, name: string, to?: { name?: string } }[] })?.transitions) ?? []
  const want = target.trim().toLowerCase()
  const hit = transitions.find(t => (t.to?.name ?? '').toLowerCase() === want) ?? transitions.find(t => t.name.toLowerCase() === want)
  if (!hit) {
    const available = transitions.map(t => t.to?.name ?? t.name).join(', ') || 'none'
    return `${key} offers no transition to "${target}" from its current status; available: ${available}. Edit the step's status in the workflow builder.`
  }
  const to = hit.to?.name ?? hit.name
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ transition: { id: hit.id } }) })
  if (!res.ok) return `Moving ${key} to "${to}" failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}. The ticket was not moved.`
  return `Moved ${key} to "${to}" (transition "${hit.name}").`
}
