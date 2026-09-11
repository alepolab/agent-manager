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
 * What a project will actually accept for one issue type: the priorities it
 * offers, and the fields it refuses to create without.
 *
 * Read before the first POST rather than discovered by it. A real run drafted
 * three good tickets, sent priority "High" to a project whose scheme is
 * Blocker/Critical/Major/Minor, and had all three refused - along with two
 * required custom fields nobody knew about. Every one of those is a question
 * Jira answers in one GET, before anything is filed.
 *
 * A lookup that fails returns null, and the caller files exactly as it did
 * before: the schema makes failures legible, it must not become a new way for
 * creation to stop working.
 */
export interface CreateSchema {
  /** Priority names the project offers, empty when the field is not on the screen. */
  priorities: string[]
  /** Fields with no default that the project will not create without, by id and human name. */
  required: { id: string, name: string }[]
}

const NEVER_ASK = new Set(['project', 'issuetype', 'summary', 'description', 'reporter'])

export async function createSchemaFor(
  creds: { baseUrl: string, email: string, apiToken: string },
  project: string,
  issueType: string,
  fetchImpl: FetchLike = fetch,
): Promise<CreateSchema | null> {
  try {
    const url = `${creds.baseUrl}/rest/api/3/issue/createmeta`
      + `?projectKeys=${encodeURIComponent(project)}`
      + `&issuetypeNames=${encodeURIComponent(issueType)}`
      + `&expand=projects.issuetypes.fields`
    const res = await fetchImpl(url, { headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json() as {
      projects?: { issuetypes?: { fields?: Record<string, { name?: string, required?: boolean, hasDefaultValue?: boolean, allowedValues?: { name?: string, value?: string }[] }> }[] }[]
    }
    const fields = body.projects?.[0]?.issuetypes?.[0]?.fields
    if (!fields) return null
    const priorities = (fields.priority?.allowedValues ?? [])
      .map(v => v.name ?? v.value)
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    const required = Object.entries(fields)
      .filter(([id, f]) => f.required && !f.hasDefaultValue && !NEVER_ASK.has(id))
      .map(([id, f]) => ({ id, name: f.name?.trim() || id }))
    return { priorities, required }
  } catch {
    return null
  }
}


/**
 * Every issue type a project offers, with the priorities and required fields of
 * each. Written to the run's artifacts by preflight so the DRAFTING agent can
 * read it: that agent holds Read, Write, Grep and Glob and no network at all,
 * so anything it must know about Jira has to arrive as a file.
 */
export async function projectCreateSchema(
  creds: { baseUrl: string, email: string, apiToken: string },
  project: string,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, CreateSchema> | null> {
  try {
    const url = `${creds.baseUrl}/rest/api/3/issue/createmeta`
      + `?projectKeys=${encodeURIComponent(project)}`
      + `&expand=projects.issuetypes.fields`
    const res = await fetchImpl(url, { headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json() as {
      projects?: { issuetypes?: { name?: string, fields?: Record<string, { name?: string, required?: boolean, hasDefaultValue?: boolean, allowedValues?: { name?: string, value?: string }[] }> }[] }[]
    }
    const types = body.projects?.[0]?.issuetypes
    if (!types?.length) return null
    const out: Record<string, CreateSchema> = {}
    for (const t of types) {
      if (!t.name || !t.fields) continue
      out[t.name] = {
        priorities: (t.fields.priority?.allowedValues ?? [])
          .map(v => v.name ?? v.value)
          .filter((n): n is string => typeof n === 'string' && n.trim().length > 0),
        required: Object.entries(t.fields)
          .filter(([id, f]) => f.required && !f.hasDefaultValue && !NEVER_ASK.has(id))
          .map(([id, f]) => ({ id, name: f.name?.trim() || id })),
      }
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/**
 * The values a draft supplies for fields beyond the fixed few, keyed by field
 * id or by the human name the schema reports. Names are accepted because that
 * is what a person (or a drafting agent) writes; ids are what Jira takes.
 */
function customValues(fields: Record<string, unknown>, schema: CreateSchema | null): Record<string, unknown> {
  const raw = (fields.custom && typeof fields.custom === 'object' && !Array.isArray(fields.custom))
    ? fields.custom as Record<string, unknown>
    : {}
  const byName = new Map((schema?.required ?? []).map(f => [f.name.toLowerCase(), f.id]))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue
    const id = byName.get(k.trim().toLowerCase()) ?? k
    out[id] = typeof v === 'string' ? plainTextToAdf(v) : v
  }
  return out
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
  // One lookup per (project, issue type) for the whole batch.
  const schemas = new Map<string, CreateSchema | null>()
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

    // What this project will take, read once per (project, issue type) and
    // shared across the batch: three drafts for one project ask Jira once.
    const schemaKey = `${project}::${issueType}`
    if (!schemas.has(schemaKey)) schemas.set(schemaKey, await createSchemaFor(creds, project, issueType, fetchImpl))
    const schema = schemas.get(schemaKey) ?? null

    const custom = customValues(fields, schema)
    const unmet = (schema?.required ?? []).filter(f => custom[f.id] === undefined)
    if (unmet.length) {
      const why = `${project}/${issueType} requires ${unmet.map(f => `${f.name} (${f.id})`).join(', ')}, and the draft supplies no value for ${unmet.length === 1 ? 'it' : 'them'}`
      out.push({ index, key, error: why, line: `Could not create an issue for ${key}: ${why}.` })
      continue
    }

    const wanted = typeof fields.priority === 'string' && fields.priority.trim() ? fields.priority.trim() : ''
    // A priority the scheme does not offer is dropped, not sent: Jira refuses
    // the whole issue over it, and the ticket matters more than the field.
    const priority = (schema && wanted && !schema.priorities.includes(wanted)) ? '' : wanted
    const droppedPriority = wanted && !priority ? wanted : ''
    const labels = Array.isArray(fields.labels) ? fields.labels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0) : []
    const payload = {
      fields: {
        project: { key: project },
        issuetype: { name: issueType },
        summary,
        description: plainTextToAdf(bodyOf(fields, entry)),
        ...(priority ? { priority: { name: priority } } : {}),
        ...(labels.length ? { labels } : {}),
        ...custom,
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
      out.push({ index, key, jiraKey: created.key, line: `Created ${created.key} in ${project} for ${key}${droppedPriority ? `, without priority "${droppedPriority}" (${project} does not offer it${schema?.priorities.length ? `; it offers ${schema.priorities.join(', ')}` : ''})` : ''}.` })
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
  const lines = outcomes.map(o => o.line).join('\n')

  // A create step that created nothing has not done its job, and everything
  // downstream of it addresses tickets that do not exist. A real run filed none
  // of three (an invalid priority and two required custom fields), reported
  // itself completed, and dispatched three child pipelines at the tickets it had
  // failed to create. A dry run is excluded: it creates nothing by design.
  const created = outcomes.filter(o => o.jiraKey).length
  const refused = outcomes.filter(o => o.error).length
  if (isJiraPostingEnabled() && !created && refused) {
    return `PIPELINE-HALT: Jira refused every one of the ${outcomes.length} ${outcomes.length === 1 ? 'issue' : 'issues'} this step tried to create from ${source}; nothing downstream has a ticket to work on.\n${lines}`
  }
  return lines
}
