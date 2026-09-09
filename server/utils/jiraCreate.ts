/**
 * Creates one Jira issue per entry of a run artifact.
 *
 * This is the half of the scan pipeline that was declared but never
 * implemented: the workflows have carried `jira: { action: "create", source:
 * "..." }` on both Create Jira steps since they were written, and
 * `JiraStepConfig` modelled only transition/comment/attach - so `runJiraStep`
 * returned "Nothing configured for this Jira step", the step completed, and no
 * ticket existed. A pipeline whose whole purpose is turning findings into
 * tickets was silently creating none.
 *
 * Shared by the step and by the review endpoint on purpose. The auto-approved
 * branch and the escalated branch create tickets from identically shaped
 * drafts, and a second implementation for the reviewed ones would be a second
 * set of field rules to keep in step.
 *
 * Nothing here throws. Every problem becomes a sentence against the entry it
 * happened to, exactly as runJiraStep and runDispatchStep report theirs: a
 * batch of twenty drafts must not lose nineteen tickets because the twentieth
 * names a project this Jira cannot see.
 */

import { isJiraPostingEnabled, jiraAuthHeader } from './jiraCredentials.ts'
import { credentialsFor } from './ticketNotifier.ts'
import { plainTextToAdf } from './adf.ts'
import { readArtifactEntries, writeArtifactJson } from './runArtifacts.ts'
import { entryKey } from '../../shared/utils/workflowGraph.ts'
import { TICKETS_CREATED_FILE } from '../../shared/types/runReview.ts'
import { createLogger } from './log.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run'

const log = createLogger('jira')

/** What became of one entry. `jiraKey` present means an issue exists. */
export interface CreateOutcome {
  index: number
  key: string
  jiraKey?: string
  error?: string
  /** One sentence, for the step's output and the endpoint's response. */
  line: string
}

/**
 * `work_type` is what a dispatch step routes on, and only the entry itself can
 * say it honestly.
 *
 * Preferred from the entry, because triage classified the finding and the
 * drafter derives `issue_type` FROM that classification - the mapping runs that
 * way round, so inverting it is guesswork. Only the issue types that invert
 * unambiguously are inferred; a "Task" could have come from infra or from a
 * change request, and picking one would route the child pipeline to a runbook
 * nobody chose. An entry left without a work_type makes the dispatch step say
 * so by name, which is the honest failure and a fixable one.
 */
const WORK_TYPE_FROM_ISSUE_TYPE: Record<string, string> = { bug: 'bug', security: 'security', vulnerability: 'security' }

function workTypeOf(entry: Record<string, unknown>, fields: Record<string, unknown>): string | undefined {
  const stated = entry.work_type
  if (typeof stated === 'string' && stated.trim()) return stated.trim()
  const issueType = typeof fields.issue_type === 'string' ? fields.issue_type.trim().toLowerCase() : ''
  return WORK_TYPE_FROM_ISSUE_TYPE[issueType]
}

/**
 * The issue body: the draft's description, with its acceptance criteria
 * appended.
 *
 * Appended rather than dropped because Jira has no acceptance-criteria field
 * and the reviewer approved the draft including them - losing them at the
 * moment of creation would mean the ticket a developer picks up is not the
 * thing that was signed off.
 */
function bodyOf(fields: Record<string, unknown>, entry: Record<string, unknown>): string {
  const description = typeof entry.description === 'string' ? entry.description : ''
  const criteria = Array.isArray(entry.acceptance_criteria)
    ? entry.acceptance_criteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : []
  // The code location the scanner found, which is NOT a Jira component: the
  // drafter writes a path like billing/charge.py, and sending that as
  // `components` fails against any project that has not defined one by that
  // name. It belongs in the body a person reads.
  const component = typeof fields.component === 'string' && fields.component.trim() ? fields.component.trim() : ''
  return [
    description,
    component ? `Component: ${component}` : '',
    criteria.length ? ['Acceptance criteria:', ...criteria.map(c => `- ${c}`)].join('\n') : '',
  ].filter(Boolean).join('\n\n')
}

/**
 * Creates an issue per entry, stamping `jira_key` and `work_type` onto the
 * entries it created.
 *
 * The entries are mutated in place, which is what makes the artifact the
 * caller writes back carry the keys: `jira_key` is the first of
 * workflowGraph's ENTRY_KEY_FIELDS, so a dispatch step downstream names its
 * child run after the real ticket and passes it as that run's `ticketKey`
 * instead of "entry 2".
 */
export async function createIssuesFrom(
  run: WorkflowRun,
  entries: { index: number, entry: Record<string, unknown> }[],
  fetchImpl: FetchLike = fetch,
): Promise<CreateOutcome[]> {
  if (!entries.length) return []

  const posting = isJiraPostingEnabled()
  let creds: { baseUrl: string, email: string, apiToken: string } | null = null
  if (posting) {
    try {
      creds = await credentialsFor(run)
    } catch (err) {
      // One sentence per entry rather than one for the batch: the caller
      // records an outcome against every entry it was asked about.
      const why = err instanceof Error ? err.message : String(err)
      return entries.map(({ index, entry }) => {
        const key = entryKey(entry, index)
        return { index, key, error: why, line: `Could not create an issue for ${key}: ${why}` }
      })
    }
  }

  const out: CreateOutcome[] = []
  for (const { index, entry } of entries) {
    const key = entryKey(entry, index)
    const fields = (entry.fields && typeof entry.fields === 'object' && !Array.isArray(entry.fields))
      ? entry.fields as Record<string, unknown>
      : {}
    const project = typeof fields.project === 'string' ? fields.project.trim() : ''
    const issueType = typeof fields.issue_type === 'string' ? fields.issue_type.trim() : ''
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : ''

    // Never guessed. A ticket filed into the wrong project is visible, wrong,
    // and awkward to undo, and this app's standing rule is that a missing
    // credential or a missing field is a named failure rather than a default.
    const missing = [!project && 'project', !issueType && 'issue_type', !summary && 'summary'].filter(Boolean)
    if (missing.length) {
      const why = `it is missing ${missing.join(', ')}`
      out.push({ index, key, error: why, line: `Could not create an issue for ${key}: ${why}.` })
      continue
    }

    if (!posting || !creds) {
      out.push({ index, key, line: `Would create a ${issueType} in ${project} for ${key}; not done: JIRA_POST_ENABLED is not 1 on this instance.` })
      continue
    }

    const priority = typeof fields.priority === 'string' && fields.priority.trim() ? fields.priority.trim() : ''
    const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0) : []
    const payload = {
      fields: {
        project: { key: project },
        issuetype: { name: issueType },
        summary,
        description: plainTextToAdf(bodyOf(fields, entry)),
        ...(priority ? { priority: { name: priority } } : {}),
        ...(labels.length ? { labels } : {}),
      },
    }

    try {
      const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: { Authorization: jiraAuthHeader(creds), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300)
        const why = `Jira refused it (HTTP ${res.status})${detail ? `: ${detail}` : ''}`
        out.push({ index, key, error: why, line: `Could not create an issue for ${key}: ${why}.` })
        continue
      }
      const created = await res.json() as { key?: string }
      if (!created?.key) {
        const why = 'Jira accepted it but returned no issue key'
        out.push({ index, key, error: why, line: `Could not create an issue for ${key}: ${why}.` })
        continue
      }
      entry.jira_key = created.key
      const workType = workTypeOf(entry, fields)
      if (workType) entry.work_type = workType
      log.info('created a jira issue', { runId: run.id, jiraKey: created.key, project })
      out.push({ index, key, jiraKey: created.key, line: `Created ${created.key} in ${project} for ${key}.` })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      out.push({ index, key, error: why, line: `Could not create an issue for ${key}: ${why}.` })
    }
  }
  return out
}

/**
 * Appends what was created to the run's running list of tickets.
 *
 * Appended, not replaced: the auto-approved branch and the reviewed escalated
 * branch both create tickets in the same run, and the second writer must not
 * erase the first one's record of what it filed.
 */
export async function recordCreatedTickets(runId: string, outcomes: CreateOutcome[]): Promise<void> {
  const created = outcomes.filter(o => o.jiraKey)
  if (!created.length) return
  const existing = await readArtifactEntries(runId, TICKETS_CREATED_FILE)
  // A corrupt or unreadable list starts a fresh one rather than throwing: the
  // tickets exist in Jira either way, and losing the run's note of them must
  // not also fail the step that created them.
  const before = existing && 'entries' in existing ? existing.entries : []
  await writeArtifactJson(runId, TICKETS_CREATED_FILE, [
    ...before,
    ...created.map(o => ({ jira_key: o.jiraKey, entry: o.key, runId, createdAt: new Date().toISOString() })),
  ])
}

/**
 * Creates an issue per entry of `source`, writes the stamped entries back, and
 * records the keys.
 *
 * Writing the artifact back is the load-bearing part: `jira_key` on an entry is
 * how every step after this one refers to the thing that was filed, so an
 * issue created but not stamped is an issue no dispatch can name and no
 * reviewer can trace.
 */
export async function createFromArtifact(run: WorkflowRun, source: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const read = await readArtifactEntries(run.id, source)
  if (read === null) return `Created nothing: ${source} was not written.`
  if ('error' in read) return `Created nothing: ${read.error}.`
  if (!read.entries.length) return `Created nothing: ${source} holds no entries.`

  const outcomes = await createIssuesFrom(run, read.entries.map((entry, index) => ({ index, entry })), fetchImpl)
  await writeArtifactJson(run.id, source, read.entries)
  await recordCreatedTickets(run.id, outcomes)
  return outcomes.map(o => o.line).join('\n')
}
