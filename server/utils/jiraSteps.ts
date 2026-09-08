import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJiraPostingEnabled, jiraAuthHeader } from './jiraCredentials.ts'
import { credentialsFor, notifyTicketOutcome } from './ticketNotifier.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run'

/** A workflow step the runner executes itself: move the ticket, post the outcome comment, or both. */
export interface JiraStepConfig {
  /** Target status name, matched case-insensitively (with common synonyms) against the transitions the ticket offers right now. */
  transition?: string
  /** Post the run's outcome comment (the same one the notifier renders when a run settles). */
  comment?: boolean
  /** Attach the run's evidence files to the ticket. */
  attach?: boolean
}

/**
 * Synonyms the estate's projects use for the two states this pipeline moves a
 * ticket through. A step configured for "Dev Done" still lands the transition
 * on a project that calls it "Ready for Review", "In Review" or "Resolved",
 * because the intent is the same and only the label differs per Jira workflow.
 * Ordered: the closest name is tried first. A configured name not in a group
 * is matched on its own, exactly as before.
 */
const STATUS_SYNONYMS: Record<string, string[]> = {
  'dev done': ['dev done', 'development done', 'ready for review', 'in review', 'code review', 'review', 'resolved', 'fixed'],
  'in progress': ['in progress', 'in development', 'in dev', 'start progress', 'doing'],
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
  if (cfg.attach) lines.push(await attachArtifacts(run, key, fetchImpl))
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

/**
 * Attaches the run's top-level evidence files to the ticket (the bundle, the
 * reports, the oracle XML), so a reviewer sees the proof on the ticket itself.
 * The per-step logs under steps/ stay in Agent Manager; they are noise on a
 * ticket. Best effort per file; the sentence says how many landed.
 */
async function attachArtifacts(run: WorkflowRun, key: string, fetchImpl: FetchLike): Promise<string> {
  if (!isJiraPostingEnabled()) return `Would attach the run's evidence to ${key}; not done: JIRA_POST_ENABLED is not 1 on this instance.`
  const dir = runArtifactsDir(run.id)
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name)
  } catch {
    return `No evidence directory to attach for ${key}.`
  }
  if (!names.length) return `No evidence files to attach to ${key}.`
  const creds = await credentialsFor(run)
  const url = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`
  const headers = { Authorization: jiraAuthHeader(creds), 'X-Atlassian-Token': 'no-check', Accept: 'application/json' }
  let done = 0
  const failed: string[] = []
  for (const name of names) {
    try {
      const form = new FormData()
      form.append('file', new Blob([await readFile(join(dir, name))]), name)
      const res = await fetchImpl(url, { method: 'POST', headers, body: form })
      if (res.ok) done++
      else failed.push(`${name} (HTTP ${res.status})`)
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return `Attached ${done} of ${names.length} evidence file(s) to ${key}${failed.length ? `; failed: ${failed.slice(0, 3).join(', ')}` : ''}.`
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
  // The configured name first, then its synonyms, matching each against the
  // target status and then the transition name. This is how "Dev Done" lands
  // on a project whose workflow calls the same state "Ready for Review".
  const candidates = STATUS_SYNONYMS[want] ?? [want]
  const byTo = (n: string) => transitions.find(t => (t.to?.name ?? '').toLowerCase() === n)
  const byName = (n: string) => transitions.find(t => t.name.toLowerCase() === n)
  let hit
  for (const n of candidates) { hit = byTo(n) ?? byName(n); if (hit) break }
  if (!hit) {
    const available = transitions.map(t => t.to?.name ?? t.name).join(', ') || 'none'
    return `${key} offers no transition to "${target}" (or a known synonym) from its current status; available: ${available}. Edit the step's status in the workflow builder.`
  }
  const to = hit.to?.name ?? hit.name
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ transition: { id: hit.id } }) })
  if (!res.ok) return `Moving ${key} to "${to}" failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}. The ticket was not moved.`
  return `Moved ${key} to "${to}" (transition "${hit.name}").`
}
