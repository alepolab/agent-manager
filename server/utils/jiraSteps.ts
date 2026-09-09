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

/**
 * Every Jira status belongs to one of three categories the product itself
 * fixes (To Do, In Progress, Done), whatever the project calls its statuses.
 * When no name or synonym matches, the category is what "start work" means
 * on that project — a board with Business Analysis and Under PdM Refinement
 * and no In Progress still has exactly one way of saying work has begun, or
 * none, and the category tells us which.
 */
const INTENT_CATEGORY: Record<string, 'indeterminate'> = { 'in progress': 'indeterminate' }
/** Among several in-progress statuses, the one that reads as development work. */
const WORK_WORDS = /progress|develop|\bdev\b|implement|start|work|doing/i

interface Transition { id: string, name: string, to?: { name?: string, statusCategory?: { key?: string } } }

/**
 * Is `target` reachable from where the ticket is now? The same question
 * `moveTicket` answers, exported so preflight can ask it before a run starts
 * instead of a step discovering it 40 minutes in.
 */
export async function transitionReachable(run: WorkflowRun, key: string, target: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean, detail: string }> {
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`
  const listed = await fetchImpl(`${issueUrl}/transitions`, { headers })
  if (!listed.ok) return { ok: false, detail: `could not read the transitions of ${key} (HTTP ${listed.status})` }
  const transitions = (((await listed.json()) as { transitions?: Transition[] })?.transitions) ?? []
  const current = await currentStatus(issueUrl, headers, fetchImpl)
  const hit = matchTransition(target, transitions)
  if (hit) return { ok: true, detail: `"${target}" reaches "${hit.to?.name ?? hit.name}" from "${current?.name ?? 'the current status'}"` }
  const want = target.trim().toLowerCase()
  const candidates = STATUS_SYNONYMS[want] ?? [want]
  if (current && (candidates.includes(current.name.toLowerCase()) || (INTENT_CATEGORY[want] && current.category === INTENT_CATEGORY[want]))) {
    return { ok: true, detail: `${key} is already in "${current.name}"` }
  }
  const inCategory = INTENT_CATEGORY[want] ? transitions.filter(t => t.to?.statusCategory?.key === INTENT_CATEGORY[want]) : []
  if (inCategory.length === 1) return { ok: true, detail: `"${target}" resolves by status category to "${inCategory[0]!.to?.name}"` }
  const working = inCategory.filter(t => WORK_WORDS.test(t.to?.name ?? '') || WORK_WORDS.test(t.name))
  if (working.length === 1) return { ok: true, detail: `"${target}" resolves to "${working[0]!.to?.name}"` }
  const available = transitions.map(t => t.to?.name ?? t.name).join(', ') || 'none'
  return { ok: false, detail: `${key} is in "${current?.name ?? 'an unknown status'}" and offers no transition to "${target}" or a known synonym; available: ${available}` }
}

/** The configured name, then its synonyms, against the target status and then the transition name. */
function matchTransition(target: string, transitions: Transition[]): Transition | undefined {
  const want = target.trim().toLowerCase()
  const candidates = STATUS_SYNONYMS[want] ?? [want]
  const byTo = (n: string) => transitions.find(t => (t.to?.name ?? '').toLowerCase() === n)
  const byName = (n: string) => transitions.find(t => t.name.toLowerCase() === n)
  for (const n of candidates) { const hit = byTo(n) ?? byName(n); if (hit) return hit }
  return undefined
}

async function moveTicket(run: WorkflowRun, key: string, target: string, fetchImpl: FetchLike): Promise<string> {
  if (!isJiraPostingEnabled()) return `Would move ${key} to "${target}"; not done: JIRA_POST_ENABLED is not 1 on this instance.`
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`
  const url = `${issueUrl}/transitions`
  const listed = await fetchImpl(url, { headers })
  if (!listed.ok) return `Could not read the transitions of ${key} (HTTP ${listed.status}); the ticket was not moved.`
  const transitions = (((await listed.json()) as { transitions?: Transition[] })?.transitions) ?? []
  const want = target.trim().toLowerCase()
  // The configured name first, then its synonyms, matching each against the
  // target status and then the transition name. This is how "Dev Done" lands
  // on a project whose workflow calls the same state "Ready for Review".
  const candidates = STATUS_SYNONYMS[want] ?? [want]
  let hit: Transition | undefined = matchTransition(target, transitions)
  const category = INTENT_CATEGORY[want]
  if (!hit && category) {
    // Already there? A ticket a developer moved to In Development by hand has
    // no transition back to it, and needs none.
    const current = await currentStatus(issueUrl, headers, fetchImpl)
    if (current && (candidates.includes(current.name.toLowerCase()) || current.category === category)) {
      return `${key} is already in "${current.name}", an in-progress status; left as is.`
    }
    const inCategory = transitions.filter(t => t.to?.statusCategory?.key === category)
    const working = inCategory.filter(t => WORK_WORDS.test(t.to?.name ?? '') || WORK_WORDS.test(t.name))
    hit = inCategory.length === 1 ? inCategory[0] : working.length === 1 ? working[0] : undefined
    if (!hit && inCategory.length > 1) {
      return `${key} offers no transition to "${target}" (or a known synonym) from "${current?.name ?? 'its current status'}", and ${inCategory.length} of its transitions lead to an in-progress status (${inCategory.map(t => `"${t.to?.name ?? t.name}"`).join(', ')}), none of them unambiguously the start of development; left as is. Name the one this project uses on the step's status in the workflow builder.`
    }
  }
  if (!hit) {
    const available = transitions.map(t => t.to?.name ?? t.name).join(', ') || 'none'
    return `${key} offers no transition to "${target}" (or a known synonym) from its current status; available: ${available}. Left as is; edit the step's status in the workflow builder if this project names it differently.`
  }
  const to = hit.to?.name ?? hit.name
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ transition: { id: hit.id } }) })
  if (!res.ok) return `Moving ${key} to "${to}" failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}. The ticket was not moved.`
  return `Moved ${key} to "${to}" (transition "${hit.name}"${hit.to?.name?.toLowerCase() !== want && !candidates.includes((hit.to?.name ?? '').toLowerCase()) ? ', the only in-progress status this project offers from here' : ''}).`
}

/** The ticket's status now, with Jira's category key; null when it cannot be read. */
async function currentStatus(issueUrl: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<{ name: string, category?: string } | null> {
  try {
    const res = await fetchImpl(`${issueUrl}?fields=status`, { headers })
    if (!res.ok) return null
    const status = ((await res.json()) as { fields?: { status?: { name?: string, statusCategory?: { key?: string } } } })?.fields?.status
    return status?.name ? { name: status.name, category: status.statusCategory?.key } : null
  } catch { return null }
}
