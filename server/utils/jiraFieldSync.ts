/**
 * Jira custom-field sync: the ticket says what the pipeline knows.
 *
 * A Jira step moves a ticket between statuses and posts the outcome comment.
 * What neither did was fill the fields a ticket about agent work needs to carry
 * - which stage the agent is at, which risk class the change is, where the
 * session and the evidence are, and whether the gates behind "code reviewed"
 * were actually passed. Those used to be filled by hand, or not at all.
 *
 * Nothing is written unless `agentManager.jiraFieldMap` in settings.json names
 * the custom-field id for a logical field: a mapping this instance has not
 * configured is a field this code never touches. Posting still needs
 * JIRA_POST_ENABLED (isJiraPostingEnabled), the same opt-in every other Jira
 * write has. Without it the sync computes what it would set and says so.
 *
 * The Yes/No gate fields (codeCommitted, ciApproved, codeReviewed,
 * atddReviewed) are set only when the corresponding evidence EXISTS on the
 * run; "No" is never written, because a missing fact and a negative fact are
 * not the same thing and a ticket that says "CI approved: No" reads as a verdict.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentManagerSettings, type JiraLogicalField } from './appSettings.ts'
import { isJiraPostingEnabled, jiraAuthHeader } from './jiraCredentials.ts'
import { credentialsFor } from './ticketNotifier.ts'
import { PLACEHOLDER_PR, runArtifactsDir } from './runArtifacts.ts'
import { baseUrl, runLink } from './notify.ts'
import { humanMinutes } from '../../shared/utils/runDecisions.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run'
import { createLogger } from './log.ts'

const log = createLogger('jira')

export type AgentStage = 'NEW' | 'TRIAGED' | 'AGENT IN PROGRESS' | 'SME REVIEW' | 'PR READY' | 'MERGED' | 'NEEDS HUMAN'
export type RiskClass = 'A' | 'B' | 'C'

/** What a sync is told about the run, beyond the run itself. */
export interface SyncChanges {
  /** The status the run has just reached. Defaults to `run.status`. */
  status?: WorkflowRun['status']
  /** The pull request(s) this run has opened, when the caller already knows. */
  prUrls?: string[]
  /** The PR was merged (the CI poller or a later step knows; the run record does not). */
  merged?: boolean
}

/** The field map as configured, with blanks dropped. */
export function jiraFieldMap(): Partial<Record<JiraLogicalField, string>> {
  const raw = agentManagerSettings().jiraFieldMap
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' && v.trim())) as Partial<Record<JiraLogicalField, string>>
}

/**
 * The stage a run's status maps to. `awaiting_review` and a `paused` run
 * stopped on a review-type gate are SME REVIEW; any other pause is NEEDS HUMAN
 * (budget, quota, auth, a question). A completed run is PR READY only when a
 * real PR exists, MERGED when told so; completed with no PR is NEEDS HUMAN,
 * since a run that finished without shipping anything is somebody's problem.
 */
export function agentStageFor(run: Pick<WorkflowRun, 'status' | 'question' | 'blastRadius'>, changes: SyncChanges = {}): AgentStage | undefined {
  const status = changes.status ?? run.status
  switch (status) {
    case 'queued': return run.blastRadius ? 'TRIAGED' : 'NEW'
    case 'running': case 'joining': return 'AGENT IN PROGRESS'
    case 'awaiting_review': return 'SME REVIEW'
    case 'paused': {
      const q = run.question
      if (q?.kind === 'approval' && !q.reason) return 'SME REVIEW'
      return 'NEEDS HUMAN'
    }
    case 'completed': {
      if (changes.merged) return 'MERGED'
      return (changes.prUrls?.length ?? 0) > 0 ? 'PR READY' : 'NEEDS HUMAN'
    }
    case 'failed': case 'stopped': case 'interrupted': return 'NEEDS HUMAN'
    default: return undefined
  }
}

/**
 * Risk class from blast radius. `deployment` is A when the defect was found in
 * production (origin), B otherwise; an unclassified run gets nothing rather
 * than a guess.
 */
export function riskClassFor(run: Pick<WorkflowRun, 'blastRadius' | 'origin'>): RiskClass | undefined {
  switch (run.blastRadius) {
    case 'protocol': case 'money': case 'schema': return 'A'
    case 'deployment': return /prod/i.test(run.origin ?? '') ? 'A' : 'B'
    case 'ui_parsing': return 'B'
    case 'docs': return 'C'
    default: return undefined
  }
}

/** The PR links meta.json records, placeholder excluded. */
async function prUrlsOf(run: WorkflowRun): Promise<string[]> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    const repos = Array.isArray(meta?.fix?.repos) ? meta.fix.repos : []
    return repos.map((r: any) => r?.pr).filter((u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u) && u !== PLACEHOLDER_PR)
  } catch {
    return []
  }
}

/** Has anything on this run been committed? From meta.json's fix facts, which the runner re-asserts from git. */
async function committed(run: WorkflowRun): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    const fix = meta?.fix
    if (!fix) return false
    if (Array.isArray(fix.commits) && fix.commits.length) return true
    return typeof fix.files_changed === 'number' && fix.files_changed > 0
  } catch {
    return false
  }
}

/** The values to set, by LOGICAL name. Pure apart from reading the run's own artifacts. */
export async function fieldValuesFor(run: WorkflowRun, changes: SyncChanges = {}): Promise<Partial<Record<JiraLogicalField, string>>> {
  const out: Partial<Record<JiraLogicalField, string>> = {}
  const prUrls = changes.prUrls ?? await prUrlsOf(run)
  const stage = agentStageFor(run, { ...changes, prUrls })
  if (stage) out.agentStage = stage
  const risk = riskClassFor(run)
  if (risk) out.riskClass = risk
  if (run.workType) out.changeType = run.workType
  if (run.product?.name) out.product = run.product.name
  const repos = [...new Set([...(run.product?.repos ?? []), ...(run.product?.alsoInScope ?? []).flatMap(p => p.repos)])]
  if (repos.length) out.impactedRepos = repos.join(', ')
  out.agentSession = runLink(run, baseUrl())
  out.evidenceManifest = `${baseUrl()}/api/runs/${encodeURIComponent(run.id)}/artifacts`
  const minutes = humanMinutes(run)
  if (minutes > 0) out.smeMinutes = String(minutes)
  // Yes only when the evidence exists; never No.
  if (await committed(run)) out.codeCommitted = 'Yes'
  if (run.ci?.status === 'passing' && run.ci.final) out.ciApproved = 'Yes'
  const approvedReview = (run.decisions ?? []).some(d => d.verdict === 'approved' && !d.auto)
  if (approvedReview) out.codeReviewed = 'Yes'
  const atdd = run.steps.some(s => s.status === 'completed' && /atdd|accept/i.test(`${s.label} ${s.agentSlug}`))
  if (atdd) out.atddReviewed = 'Yes'
  return out
}

/** A Yes/No or option field takes `{ value }`; everything else a string. Decided by the field's editmeta schema. */
function shapeFor(schema: { type?: string, custom?: string } | undefined, value: string): unknown {
  if (schema?.type === 'option' || schema?.custom?.includes('select') || schema?.custom?.includes('radiobuttons')) return { value }
  if (schema?.type === 'number') return Number(value)
  if (schema?.type === 'array') return value.split(',').map(v => v.trim()).filter(Boolean)
  return value
}

export interface SyncResult {
  /** Logical name -> value, as computed, whether or not it was sent. */
  computed: Partial<Record<JiraLogicalField, string>>
  /** Custom-field id -> value, as sent (or as would have been sent). */
  fields: Record<string, unknown>
  posted: boolean
  reason?: string
}

/**
 * Sets the mapped fields on the run's ticket. Never throws for a Jira problem:
 * the result says what happened and the run goes on. Nothing configured means
 * `posted: false` with the reason, and no request.
 */
export async function syncJiraFields(run: WorkflowRun, changes: SyncChanges = {}, fetchImpl: FetchLike = fetch): Promise<SyncResult> {
  const computed = await fieldValuesFor(run, changes)
  const map = jiraFieldMap()
  const fields: Record<string, unknown> = {}
  for (const [name, id] of Object.entries(map) as [JiraLogicalField, string][]) {
    const v = computed[name]
    if (v !== undefined) fields[id] = v
  }
  if (!Object.keys(map).length) return { computed, fields, posted: false, reason: 'no jiraFieldMap is configured on this instance' }
  if (!run.ticketKey) return { computed, fields, posted: false, reason: 'this run has no ticket key' }
  if (!Object.keys(fields).length) return { computed, fields, posted: false, reason: 'nothing the field map names has a value yet' }
  if (!isJiraPostingEnabled()) return { computed, fields, posted: false, reason: 'JIRA_POST_ENABLED is not 1 on this instance' }

  try {
    const creds = await credentialsFor(run)
    const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
    const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(run.ticketKey)}`
    // The edit screen decides the shape (an option field wants `{ value }`),
    // and drops a mapped field this project does not expose rather than
    // failing the whole PUT on it.
    let editable: Record<string, { schema?: { type?: string, custom?: string } }> = {}
    const meta = await fetchImpl(`${issueUrl}/editmeta`, { headers })
    if (meta.ok) editable = ((await meta.json()) as { fields?: typeof editable })?.fields ?? {}
    const shaped: Record<string, unknown> = {}
    for (const [id, v] of Object.entries(fields)) {
      if (meta.ok && !(id in editable)) continue
      shaped[id] = shapeFor(editable[id]?.schema, String(v))
    }
    if (!Object.keys(shaped).length) return { computed, fields, posted: false, reason: `none of the mapped fields is editable on ${run.ticketKey}` }
    const res = await fetchImpl(issueUrl, { method: 'PUT', headers, body: JSON.stringify({ fields: shaped }) })
    if (!res.ok) return { computed, fields: shaped, posted: false, reason: `Jira answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }
    log.info('jira fields synced', { runId: run.id, ticketKey: run.ticketKey, fields: Object.keys(shaped) })
    return { computed, fields: shaped, posted: true }
  } catch (err) {
    return { computed, fields, posted: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The runner's hook: once per status a run reaches, in the background, and
 * only when a field map is configured - so an instance without one pays one
 * settings read per publish and nothing else. Never awaited by publish(); a
 * Jira outage must not slow a run.
 */
const lastSynced = new Map<string, string>()
export function _resetSynced() { lastSynced.clear() }
export function syncJiraFieldsOnTransition(run: WorkflowRun): void {
  if (!run.ticketKey || !Object.keys(jiraFieldMap()).length) return
  const key = `${run.status}:${run.question?.stepId ?? ''}`
  if (lastSynced.get(run.id) === key) return
  lastSynced.set(run.id, key)
  void syncJiraFields(run).then((r) => {
    if (!r.posted) log.debug('jira field sync not posted', { runId: run.id, reason: r.reason })
  }).catch(err => log.warn('jira field sync failed', { runId: run.id, error: err instanceof Error ? err.message : String(err) }))
}
