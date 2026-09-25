import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJiraPostingEnabled, jiraAuthHeader } from './jiraCredentials.ts'
import { credentialsFor, notifyTicketOutcome } from './ticketNotifier.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import { createFromArtifact } from './jiraCreate.ts'
import { plainTextToAdf } from './adf.ts'
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
  /**
   * Create one issue per entry of `source`, stamping the key back onto the
   * entry (server/utils/jiraCreate.ts).
   *
   * Spelled as an action rather than a boolean because the workflows already
   * declare it that way and have since they were written — they were simply
   * never read, since this interface modelled only the three fields above.
   * Matching the declaration is what makes those files start working with no
   * migration and no edit to a workflow definition.
   */
  action?: 'create'
  /** The artifact `action: 'create'` reads its drafts from. */
  source?: string
  /**
   * Fields to fill, by field name. One on the transition's screen is sent with
   * the move - ASECRM refuses "Ready For QA" with "Add CI Release Details"
   * otherwise - and any other is set on the issue itself, so a later step can
   * replace what an earlier one wrote. Names match loosely ("CI Release
   * Details" finds "CI-Release Details").
   *
   * Placeholders: `{pr}` the run's pull request link(s) from meta.json;
   * `{branch}` the run branch on GitHub; `{pr_or_branch}` the PR when there is
   * one, else the branch. A field whose value needs something the run does not
   * have yet is left alone and the step says so.
   */
  fields?: Record<string, string>
}

/**
 * Synonyms the estate's projects use for the states this pipeline moves a
 * ticket through. A step configured for "Dev Done" still lands the transition
 * on a project that calls it "Ready for Review", "In Review" or "Resolved",
 * because the intent is the same and only the label differs per Jira workflow.
 * Ordered: the closest name is tried first. A configured name not in a group
 * is matched on its own, exactly as before.
 *
 * Matching is case-insensitive on both sides, which is why ASECRM's ALL-CAPS
 * "DEV DONE", "READY FOR QA" and "QA DONE" need no entry of their own.
 */
/**
 * Status names for comparison: lowercased, punctuation flattened to spaces.
 *
 * Projects spell the same status differently — CSUP's is "Dev. Done", with a
 * period, against a runbook that asks for "Dev Done". An exact lowercase
 * compare misses that and the step reports "offers no transition to Dev Done or
 * a known synonym" while listing "Dev. Done" among the available ones, which
 * reads as a bug in the matcher because it is one. Adding "dev. done" to the
 * synonyms below would fix that project and wait to be rediscovered on the next
 * one; normalising fixes the class.
 */
const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const STATUS_SYNONYMS: Record<string, string[]> = {
  'dev done': ['dev done', 'development done', 'ready for review', 'in review', 'code review', 'review', 'resolved', 'fixed'],
  'in progress': ['in progress', 'in development', 'in dev', 'start progress', 'doing'],
  'ready for qa': ['ready for qa', 'ready for test', 'ready for testing', 'awaiting qa', 'ready for verification'],
  'qa in progress': ['qa in progress', 'in qa', 'qa', 'testing', 'in testing', 'under test', 'start qa'],
  'qa done': ['qa done', 'qa complete', 'qa completed', 'qa passed', 'tested', 'verified'],
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
  const lines: string[] = []
  // Creation runs first, and outside the ticket-key guard below: a step that
  // CREATES tickets is the one kind that legitimately starts without one. That
  // guard is about a run whose own ticket is missing, which says nothing about
  // drafts this step is about to file — and returning early on it is why the
  // create action, once declared, would still have produced nothing.
  if (cfg.action === 'create') {
    if (!cfg.source) return 'Nothing created: this step is set to create tickets but names no artifact to create them from.'
    lines.push(await createFromArtifact(run, cfg.source, fetchImpl))
  }

  const key = run.ticketKey
  if (!key) {
    return lines.length
      ? lines.join('\n')
      : 'PIPELINE-SKIP: this run has no ticket key, so there is nothing in Jira to move or to comment on.'
  }
  let rest = cfg.fields
  if (cfg.transition) {
    const moved = await moveTicket(run, key, cfg.transition, fetchImpl, cfg.fields)
    lines.push(moved.line)
    rest = moved.rest
  }
  if (rest && Object.keys(rest).length) lines.push(await setIssueFields(run, key, rest, fetchImpl))
  if (cfg.attach) lines.push(await attachArtifacts(run, key, fetchImpl))
  if (cfg.comment) {
    // The notifier renders, records the artifact and posts only when enabled.
    // The run is still 'running' while this step executes; every step of work
    // before it has completed, which is what the comment describes.
    const result = await notifyTicketOutcome({ id: run.watch, name: run.workflowName }, key, { ...run, status: 'completed' }, {}, fetchImpl)
    lines.push(result.posted ? `Comment posted on ${key}.` : `Comment recorded, not posted: ${result.reason}.`)
    run.ticketCommented = true
  }
  return lines.join('\n') || 'Nothing configured for this Jira step: set a status to move to, the outcome comment, or ticket creation, in the workflow builder.'
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
const INTENT_CATEGORY: Record<string, 'indeterminate'> = {
  'in progress': 'indeterminate',
  // "Dev Done" had no category, so it was matched by name alone: a project
  // spelling it anything unexpected got "offers no transition to Dev Done"
  // and the ticket sat where it was. It resolves by category now, like the
  // start intent.
  //
  // 'indeterminate' for BOTH, deliberately, and this is the safety property
  // of the whole resolver: Jira sorts every status into new / indeterminate /
  // done, and nothing here may ever auto-select a `done` one. CSUP-7516 sits
  // in "New" offering exactly two transitions — "Close as invalid" and
  // "Cancel" — both `done`. A resolver that "tried harder" on a done-category
  // fallback would close a customer's ticket as invalid because a pipeline
  // could not find a status it liked. Handing work over is an in-progress
  // move; closing a ticket is a person's decision.
  'dev done': 'indeterminate',
}
/** Among several in-progress statuses, the one that reads as development work. */
const WORK_WORDS = /progress|develop|\bdev\b|implement|start|work|doing/i
/** And the one that reads as work handed on for checking. */
const REVIEW_WORDS = /review|dev\s*\.?\s*done|development done|resolved|fixed|verif|\bqa\b|test/i
/** The disambiguator for each intent, when a project offers several in-progress statuses. */
const WORDS_FOR: Record<string, RegExp> = { 'in progress': WORK_WORDS, 'dev done': REVIEW_WORDS }

interface Transition {
  id: string
  name: string
  to?: { name?: string, statusCategory?: { key?: string } }
  /** The transition's screen, present when listed with `expand=transitions.fields`. */
  fields?: Record<string, { name?: string, schema?: { type?: string, custom?: string } }>
}

/**
 * What this step should do with the ticket, decided from the ticket's OWN
 * workflow rather than from a status name someone typed into a runbook.
 *
 * One resolver, two callers: preflight asks it before the run starts and the
 * step asks it again when it runs. They used to implement the same chain
 * separately, which is how they came to disagree — the step treats "nothing to
 * do" as a normal outcome and carries on, while preflight failed the whole run
 * for it.
 *
 * Order: the configured name or one of its synonyms; then the one transition
 * whose target is in the intent's category; then the one whose name reads like
 * the intent. Anything ambiguous, and anything that would land in `done`,
 * resolves to nothing — and nothing is a legitimate answer, not an error.
 */
export function resolveTransition(
  target: string,
  transitions: Transition[],
  current?: { name: string, category?: string } | null,
): { hit?: Transition, already?: boolean, needsCurrent?: boolean, why: string } {
  const want = norm(target)
  const candidates = (STATUS_SYNONYMS[want] ?? [want]).map(norm)
  const named = matchTransition(target, transitions)
  if (named) return { hit: named, why: `"${target}" reaches "${named.to?.name ?? named.name}"` }

  const category = INTENT_CATEGORY[want]
  // Past the name match, the current status is load-bearing: a ticket already
  // in the target state has no transition back to it, and the category
  // fallback would move it a second time. `needsCurrent` lets the caller fetch
  // it only on this path — see moveTicket, which spends one request on the
  // name-match path and two here.
  if (category && current === undefined) return { needsCurrent: true, why: 'the current status decides this one' }
  // "Already there" has to mean already in THIS intent's half of the work, not
  // merely somewhere in `indeterminate`. Both intents share that category, so
  // a bare category compare made a Dev Done step no-op on every ticket sitting
  // in In Progress — which is every ticket a run has just worked on.
  const intentWords = WORDS_FOR[want]
  const alreadyByCategory = (name: string) => !intentWords || intentWords.test(name)
  if (current && (candidates.includes(norm(current.name))
    || (category && current.category === category && alreadyByCategory(current.name)))) {
    return { already: true, why: `already in "${current.name}"` }
  }
  const available = () => transitions.map(t => t.to?.name ?? t.name).join(', ') || 'none'
  if (!category) {
    return { why: `no transition named "${target}" (or a known synonym), and no category is registered for that intent; available: ${available()}` }
  }
  const inCategory = transitions.filter(t => t.to?.statusCategory?.key === category)
  const words = WORDS_FOR[want]
  // Jira's `indeterminate` covers both "work started" and "work handed on", so
  // the category alone cannot tell the two intents apart. A project offering a
  // single in-progress transition to "In Progress" would otherwise satisfy a
  // "Dev Done" step by category and report the work handed over when it had
  // only been started. When the sole candidate reads as the OTHER intent, that
  // is no answer at all.
  const other = want === 'dev done' ? WORK_WORDS : REVIEW_WORDS
  const readsAsOther = (t: Transition) => other.test(t.to?.name ?? '') || other.test(t.name)
  const plausible = inCategory.filter(t => !readsAsOther(t) || (words ? words.test(t.to?.name ?? '') || words.test(t.name) : false))
  if (plausible.length === 1) return { hit: plausible[0], why: `"${target}" resolves by status category to "${plausible[0]!.to?.name}"` }
  if (inCategory.length >= 1 && plausible.length === 0) {
    const names = inCategory.map(t => `"${t.to?.name ?? t.name}"`).join(', ')
    return { why: `the in-progress transitions from here (${names}) read as the other half of the work, not as "${target}"` }
  }
  const worded = words ? plausible.filter(t => words.test(t.to?.name ?? '') || words.test(t.name)) : []
  if (worded.length === 1) return { hit: worded[0], why: `"${target}" resolves to "${worded[0]!.to?.name}"` }
  if (inCategory.length > 1) {
    return { why: `${inCategory.length} transitions lead to an in-progress status (${inCategory.map(t => `"${t.to?.name ?? t.name}"`).join(', ')}), none of them unambiguously "${target}"` }
  }
  return { why: `no transition from here leads anywhere safe to move it to; available: ${available()}` }
}

/**
 * Is `target` reachable from where the ticket is now? The same question
 * `moveTicket` answers, exported so preflight can ask it before a run starts
 * instead of a step discovering it 40 minutes in.
 */
export async function transitionReachable(run: WorkflowRun, key: string, target: string, fetchImpl: FetchLike = fetch): Promise<{ ok: boolean, detail: string, already?: boolean }> {
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`
  const listed = await fetchImpl(`${issueUrl}/transitions`, { headers })
  if (!listed.ok) return { ok: false, detail: `could not read the transitions of ${key} (HTTP ${listed.status})` }
  const transitions = (((await listed.json()) as { transitions?: Transition[] })?.transitions) ?? []
  const current = await currentStatus(issueUrl, headers, fetchImpl)
  const r = resolveTransition(target, transitions, current)
  if (r.hit) return { ok: true, detail: `${r.why} from "${current?.name ?? 'the current status'}"` }
  if (r.already) return { ok: true, already: true, detail: `${key} is ${r.why}` }
  // Not reachable is not a failure of the run. The step reports it and the
  // work goes on: fixing the bug never depended on the bookkeeping.
  return { ok: false, detail: `${key} is in "${current?.name ?? 'an unknown status'}" and ${r.why}; the step will leave the ticket where it is and say so.` }
}

/** The configured name, then its synonyms, against the target status and then the transition name. */
function matchTransition(target: string, transitions: Transition[]): Transition | undefined {
  const want = norm(target)
  const candidates = (STATUS_SYNONYMS[want] ?? [want]).map(norm)
  const byTo = (n: string) => transitions.find(t => norm(t.to?.name ?? '') === n)
  const byName = (n: string) => transitions.find(t => norm(t.name) === n)
  for (const n of candidates) { const hit = byTo(n) ?? byName(n); if (hit) return hit }
  return undefined
}

/**
 * Moves the ticket, sending whichever of `fields` sit on the transition's
 * screen. `rest` is what it did not send - every field, when no move was
 * made - for the caller to set on the issue instead.
 */
async function moveTicket(run: WorkflowRun, key: string, target: string, fetchImpl: FetchLike, fields?: Record<string, string>): Promise<{ line: string, rest?: Record<string, string> }> {
  const line = (l: string) => ({ line: l, rest: fields })
  if (!isJiraPostingEnabled()) return { line: `Would move ${key} to "${target}"; not done: JIRA_POST_ENABLED is not 1 on this instance.` }
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`
  const url = `${issueUrl}/transitions`
  const listed = await fetchImpl(fields ? `${url}?expand=transitions.fields` : url, { headers })
  if (!listed.ok) return line(`Could not read the transitions of ${key} (HTTP ${listed.status}); the ticket was not moved.`)
  const transitions = (((await listed.json()) as { transitions?: Transition[] })?.transitions) ?? []
  // The same resolver preflight used, so the two cannot drift apart.
  //
  // The current status is read only when a category is registered for this
  // intent, and then BEFORE resolving rather than as a retry: a ticket a
  // developer already moved by hand has no transition back to where it is, and
  // the category fallback would otherwise resolve past that fact and move it a
  // second time. Where no category applies, the status cannot change the answer
  // and the read is skipped.
  let r = resolveTransition(target, transitions, undefined)
  if (r.needsCurrent) r = resolveTransition(target, transitions, await currentStatus(issueUrl, headers, fetchImpl))
  if (r.already) return line(`${key} is ${r.why}; left as is.`)
  if (!r.hit) {
    return line(`${key} could not be moved to "${target}": ${r.why}. Left as is - the ticket's own workflow offers no safe next step, which is not a problem with this run. Name the status this project uses on the step, or move it by hand.`)
  }
  const hit = r.hit
  const to = hit.to?.name ?? hit.name
  const filled = fields ? await fillFields(run, Object.entries(hit.fields ?? {}), fields) : { values: {}, notes: [], rest: {} }
  const body = { transition: { id: hit.id }, ...(Object.keys(filled.values).length ? { fields: filled.values } : {}) }
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const noted = filled.notes.length ? ` ${filled.notes.join(' ')}` : ''
  if (!res.ok) return { line: `Moving ${key} to "${to}" failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}. The ticket was not moved.${noted}`, rest: filled.rest }
  // Why this status, in the resolver's own words: a move that came from the
  // category rather than the configured name must say so, or a reader cannot
  // tell a deliberate resolution from a coincidence.
  return { line: `Moved ${key} to "${to}" (transition "${hit.name}"; ${r.why}).${noted}`, rest: filled.rest }
}

/** Sets `fields` on the issue itself, for those its edit screen offers. */
async function setIssueFields(run: WorkflowRun, key: string, fields: Record<string, string>, fetchImpl: FetchLike): Promise<string> {
  const names = Object.keys(fields).map(n => `"${n}"`).join(', ')
  if (!isJiraPostingEnabled()) return `Would set ${names} on ${key}; not done: JIRA_POST_ENABLED is not 1 on this instance.`
  const creds = await credentialsFor(run)
  const headers = { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' }
  const issueUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}`
  const meta = await fetchImpl(`${issueUrl}/editmeta`, { headers })
  if (!meta.ok) return `Could not read what ${key} lets you edit (HTTP ${meta.status}); ${names} not set.`
  const editable = ((await meta.json()) as { fields?: Transition['fields'] })?.fields ?? {}
  const filled = await fillFields(run, Object.entries(editable), fields)
  const unreachable = Object.keys(filled.rest).map(n => `"${n}" is not editable on ${key}, so it was not set.`)
  const notes = [...filled.notes, ...unreachable].join(' ')
  if (!Object.keys(filled.values).length) return notes
  const res = await fetchImpl(issueUrl, { method: 'PUT', headers, body: JSON.stringify({ fields: filled.values }) })
  if (!res.ok) return `Setting fields on ${key} failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}.`
  return notes
}

const fieldKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The run's pull request and branch links. Placeholders are not links, and a branch needs a repo to live in. */
async function runLinks(run: WorkflowRun): Promise<{ prs: string[], branches: string[] }> {
  let repos: { repo?: unknown, pr?: unknown }[] = []
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    if (Array.isArray(meta?.fix?.repos)) repos = meta.fix.repos
  } catch { /* no meta yet */ }
  const prs = repos.map(r => r.pr).filter((p): p is string => typeof p === 'string' && /^https?:\/\//.test(p) && !p.includes('example.invalid'))
  const names = [...new Set([...repos.map(r => r.repo), ...(run.product?.repos ?? [])].filter((r): r is string => typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r)))]
  const branch = run.branch?.split('/').map(encodeURIComponent).join('/')
  return { prs, branches: branch ? names.map(n => `https://github.com/${n}/tree/${branch}`) : [] }
}

/** A field's value with its placeholders filled, or why it cannot be yet. */
function resolveTemplate(template: string, links: { prs: string[], branches: string[] }): { value: string } | { missing: string } {
  const pick: Record<string, string[]> = {
    '{pr_or_branch}': links.prs.length ? links.prs : links.branches,
    '{pr}': links.prs,
    '{branch}': links.branches,
  }
  let value = template
  for (const [token, found] of Object.entries(pick)) {
    if (!value.includes(token)) continue
    if (!found.length) return { missing: token === '{pr}' ? 'this run has not opened a pull request yet' : 'this run has no branch in a known repository yet' }
    value = value.replaceAll(token, found.join('\n'))
  }
  return { value }
}

/**
 * The configured fields that `available` offers, resolved and shaped for it.
 * `rest` is every field `available` does not offer, for another route to set.
 */
async function fillFields(run: WorkflowRun, available: [string, { name?: string, schema?: { type?: string, custom?: string } }][], wanted: Record<string, string>): Promise<{ values: Record<string, unknown>, notes: string[], rest: Record<string, string> }> {
  const values: Record<string, unknown> = {}
  const notes: string[] = []
  const rest: Record<string, string> = {}
  let links: Awaited<ReturnType<typeof runLinks>> | undefined
  for (const [name, template] of Object.entries(wanted)) {
    const found = available.find(([id, f]) => fieldKey(f.name ?? '') === fieldKey(name) || id === name)
    if (!found) { rest[name] = template; continue }
    links ??= await runLinks(run)
    const resolved = resolveTemplate(template, links)
    if ('missing' in resolved) {
      notes.push(`"${name}" was left as it is: ${resolved.missing}.`)
      continue
    }
    const [id, f] = found
    const richText = f.schema?.custom?.includes('textarea') || f.schema?.type === 'doc'
    values[id] = richText ? plainTextToAdf(resolved.value) : resolved.value
    notes.push(`Set "${f.name ?? name}" to ${resolved.value}.`)
  }
  return { values, notes, rest }
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
