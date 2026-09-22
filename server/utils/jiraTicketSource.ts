/**
 * The Jira-backed `TicketSource` (B5, half one: "a ticket in Jira reaches
 * the pipeline without a human copying it").
 *
 * Implements the same `TicketSource` interface `ticketSource.ts`'s
 * file-backed stub does, so `watchScheduler.ts` never needs to know which
 * one it has — swap it in with `setTicketSource(createJiraTicketSource())`
 * (done in `server/plugins/watcher.ts`, only when Jira credentials are
 * actually configured) and every scheduling, dedupe, cap and
 * failure-isolation behavior `watchScheduler.ts` already has stays
 * unchanged. The stub keeps working for tests and offline work regardless.
 *
 * Uses Jira Cloud's current issue-search endpoint, `POST
 * /rest/api/3/search/jql` — the GET/POST `/rest/api/{2,3}/search` endpoints
 * this replaced were fully removed by Atlassian on 2025-05-01, so the old
 * `startAt`-paginated form is not an option here. Pagination uses the
 * documented `nextPageToken` field, bounded by `MAX_PAGES` — Atlassian's own
 * community has reported `isLast`/`nextPageToken` looping without ever
 * settling on some Jira instances, and a watcher polling on a fixed interval
 * must not be able to spend an entire cycle (or hang) chasing that.
 *
 * `fetch()` never degrades an auth or HTTP failure to `[]` — it throws. An
 * empty array from a working query and a broken query/credential must never
 * look the same to a caller; `watchScheduler.ts`'s per-watch try/catch is
 * where that throw is intentionally swallowed into "this cycle found
 * nothing", the same tolerance it already gives the file-backed stub.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adfToPlainText } from './adf.ts'
import { planBriefFor } from './planBrief.ts'
import { resolveJiraCredentials, jiraAuthHeader } from './jiraCredentials.ts'
import type { TicketSource } from './ticketSource.ts'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'

export type FetchLike = typeof fetch

const SEARCH_PATH = '/rest/api/3/search/jql'
const PAGE_SIZE = 50
/** Hard cap on pages per watch per cycle — see file docstring on why
 *  `nextPageToken` cannot be trusted to terminate on its own. Exported so
 *  a test can assert termination without asserting the literal value. */
export const MAX_PAGES = 10
const REQUESTED_FIELDS = ['summary', 'description', 'updated', 'assignee', 'reporter']

interface JiraUser {
  displayName?: string
}

interface JiraIssue {
  key: string
  fields?: {
    summary?: string
    description?: unknown
    updated?: string
    assignee?: JiraUser | null
    reporter?: JiraUser | null
  }
}

interface JiraSearchResponse {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

function toTicketRef(issue: JiraIssue, baseUrl: string): TicketRef | null {
  if (!issue?.key?.trim()) return null
  const f = issue.fields ?? {}
  const updatedAt = f.updated ? Date.parse(f.updated) : NaN
  return {
    key: issue.key,
    summary: f.summary ?? '',
    description: adfToPlainText(f.description),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    assignee: f.assignee?.displayName || undefined,
    reporter: f.reporter?.displayName || undefined,
    url: `${baseUrl}/browse/${issue.key}`,
  }
}

/** Reads the body defensively for an error message — Jira's error payload
 *  shape varies (`errorMessages: string[]`, `errors: {...}`, or plain text)
 *  and must never be the reason this throws a SECOND, less useful error. */
async function describeError(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.slice(0, 500) || res.statusText
  } catch {
    return res.statusText
  }
}

/**
 * Builds the Jira-backed `TicketSource`. `fetchImpl` defaults to the global
 * `fetch` (Node 24) and is overridable for tests — no network, no
 * credentials required to exercise the mapping, pagination, or error-surfacing
 * logic.
 */
export function createJiraTicketSource(fetchImpl: FetchLike = fetch): TicketSource {
  return {
    async fetch(watch: Watch): Promise<TicketRef[]> {
      const jql = watch.query?.trim()
      if (!jql) {
        // Opaque to the scheduler, but not opaque to us: a Jira watch with
        // no JQL configured is a misconfigured watch, not "zero tickets
        // currently match" — the two must not read the same. Matches the
        // "clear, early failure" bar credentials get.
        throw new Error(
          `Watch '${watch.id}' has no JQL query configured — nothing for the Jira source to search for.`,
        )
      }

      const creds = resolveJiraCredentials()
      const headers = {
        Authorization: jiraAuthHeader(creds),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      }

      const refs: TicketRef[] = []
      let nextPageToken: string | undefined
      let page = 0

      do {
        page += 1
        const res = await fetchImpl(`${creds.baseUrl}${SEARCH_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jql,
            fields: REQUESTED_FIELDS,
            maxResults: PAGE_SIZE,
            ...(nextPageToken ? { nextPageToken } : {}),
          }),
        })

        if (!res.ok) {
          const detail = await describeError(res)
          throw new Error(
            `Jira search failed for watch '${watch.id}' (HTTP ${res.status}): ${detail}`,
          )
        }

        const body = await res.json() as JiraSearchResponse
        for (const issue of body.issues ?? []) {
          const ref = toTicketRef(issue, creds.baseUrl)
          if (ref) refs.push(ref)
        }

        nextPageToken = body.isLast ? undefined : body.nextPageToken
      } while (nextPageToken && page < MAX_PAGES)

      return refs
    },
  }
}

/**
 * Credentials for one request: the starter's own Jira identity when their
 * profile carries one (server/utils/users.ts puts it in `env`), else the
 * instance's. `JIRA_BASE_URL` is instance-wide either way.
 */
function credentialsFrom(env: Record<string, string>) {
  if (env.JIRA_EMAIL && env.JIRA_API_TOKEN) {
    const baseUrl = (env.JIRA_BASE_URL || process.env.JIRA_BASE_URL || '').replace(/\/+$/, '')
    if (baseUrl) return { baseUrl, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN }
  }
  return resolveJiraCredentials()
}

export interface JiraAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  /** Jira's authenticated download URL. Not fetchable without the same credentials. */
  content: string
}

export interface JiraIssueView {
  key: string
  summary: string
  description: string
  labels: string[]
  url: string
  /**
   * What is attached to the ticket.
   *
   * A screenshot on a ticket is frequently the whole specification — the
   * defect, the layout, the error dialog — and the run never saw it: the
   * issue fetch asked for summary, description and labels, so an agent
   * working a ticket whose description says "see attached" was working from
   * nothing.
   */
  attachments: JiraAttachment[]
}

/** One issue by key, as the pipeline wants to read it. Throws on any HTTP or credential failure. */
export async function viewIssue(key: string, env: Record<string, string> = {}, fetchImpl: FetchLike = fetch): Promise<JiraIssueView> {
  const creds = credentialsFrom(env)
  const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,labels,attachment`, {
    headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Jira issue ${key} failed (HTTP ${res.status}): ${await describeError(res)}`)
  const issue = await res.json() as JiraIssue & { fields?: { labels?: string[], attachment?: JiraAttachment[] } }
  const f = issue.fields ?? {}
  return {
    key: issue.key ?? key,
    summary: f.summary ?? '',
    description: adfToPlainText(f.description).trim(),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    url: `${creds.baseUrl}/browse/${issue.key ?? key}`,
    attachments: (Array.isArray(f.attachment) ? f.attachment : []).map(a => ({
      id: String(a.id), filename: String(a.filename), mimeType: String(a.mimeType ?? ''),
      size: Number(a.size ?? 0), content: String(a.content ?? ''),
    })).filter(a => a.filename && a.content),
  }
}

/**
 * The text a run should start from for one ticket: key, summary, labels and
 * description — plus the implementation brief, where a plan has one.
 *
 * The brief is appended here rather than written back to Jira. The ticket
 * belongs to the customer and states the outcome they want; the sequencing,
 * the dependencies, what closes each task and which pairs must ship together
 * are ours, change once a sprint, and are exactly what a run otherwise has to
 * rediscover from a summary and a description.
 */
export function ticketText(issue: JiraIssueView): string {
  const brief = planBriefFor(issue.key)
  return [
    `${issue.key}: ${issue.summary}`,
    `URL: ${issue.url}`,
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : '',
    '',
    issue.description,
    ...(issue.attachments?.length
      ? ['', `Attachments (${issue.attachments.length}) — downloaded into ${TICKET_FILES_DIR}/ in this run's working directory, read them before you start:`,
         ...issue.attachments.map(a => `  ${TICKET_FILES_DIR}/${a.filename.replace(/[/\\]/g, '_')}  (${a.mimeType}, ${Math.round(a.size / 1024)} KB)`)]
      : []),
    ...(brief ? [brief] : []),
  ].filter((l, i) => l !== '' || i === 3).join('\n')
}

/** For a manual run started with only a key: the ticket text, or null when Jira cannot serve it. */
/**
 * The Jira key a piece of text is about, or undefined.
 *
 * A manually started run carried no ticketKey at all - startRun accepts one and
 * only watchRunStarter passed it - so notifyTicketOutcome never fired for a run
 * anyone kicked off by hand, whatever JIRA_POST_ENABLED said. The prompt began
 * "DEVOPS-15: Support running post-migrate script..." and the key was sitting
 * in plain sight.
 *
 * The FIRST match wins: a ticket body often quotes other issues, and the one it
 * is about is the one it opens with.
 */
export function ticketKeyFrom(text: string | undefined): string | undefined {
  return text?.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0]
}

/**
 * The ticket behind a prompt, wherever the key sits in it: "SCN-402 Selfcare
 * now" is about SCN-402 as much as the bare key is. Returns the text to start
 * from, or the reason it could not be read, so the intake agent is told why
 * instead of being left to reach Jira itself, which it cannot: agents have no
 * shell and no Jira access, and a real run halted trying.
 */
export async function fetchTicketForPrompt(prompt: string, env: Record<string, string> = {}, fetchImpl: FetchLike = fetch): Promise<{ key?: string, text: string | null, reason?: string }> {
  const key = ticketKeyFrom(prompt)
  if (!key) return { text: null }
  try {
    return { key, text: ticketText(await viewIssue(key, env, fetchImpl)) }
  } catch (err) {
    return { key, text: null, reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function expandTicketKey(prompt: string, env: Record<string, string> = {}, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const key = prompt.trim()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return null
  try {
    return ticketText(await viewIssue(key, env, fetchImpl))
  } catch {
    return null
  }
}

/** Where a run keeps the ticket's own files. Git-excluded by ensureRunBranch's `.agent/*`. */
export const TICKET_FILES_DIR = '.agent/ticket'

export interface DownloadedAttachment { filename: string, path: string, mimeType: string, size: number }

/**
 * Pull a ticket's attachments into the run's worktree so an agent can open them.
 *
 * A screenshot is often the whole specification — the defect, the layout, the
 * error dialog — and it was unreachable: agents have no shell and no Jira
 * access, and Jira's attachment URLs need the same credentials the fetch
 * needed. So a ticket whose description said "see attached" gave the run
 * nothing, and nothing anywhere said a file had been skipped.
 *
 * Written under `.agent/ticket/`, which `ensureRunBranch` already excludes
 * from git, so a screenshot can never be committed into the customer's
 * repository by a step that runs `git add -A`.
 *
 * Best effort per file and never throws: one unreadable attachment must not
 * fail a run, and a partial set is worth more than none. What failed is
 * returned as a reason so the prompt can say so rather than leaving a silent
 * gap.
 */
export async function downloadAttachments(
  issue: JiraIssueView,
  worktree: string,
  env: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ saved: DownloadedAttachment[], failed: { filename: string, reason: string }[] }> {
  const saved: DownloadedAttachment[] = []
  const failed: { filename: string, reason: string }[] = []
  if (!issue.attachments?.length) return { saved, failed }

  const creds = credentialsFrom(env)
  const dir = join(worktree, TICKET_FILES_DIR)
  await mkdir(dir, { recursive: true })

  for (const a of issue.attachments) {
    // A filename from a ticket is untrusted input: it reaches a path join, so
    // a traversal in it would write outside the run's own directory.
    const safe = a.filename.replace(/[/\\]/g, '_').replace(/\.\.+/g, '_').replace(/^[.\s]+/, '_') || 'attachment'
    try {
      const res = await fetchImpl(a.content, {
        headers: { Authorization: jiraAuthHeader(creds) },
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) { failed.push({ filename: a.filename, reason: `HTTP ${res.status}` }); continue }
      const path = join(dir, safe)
      await writeFile(path, Buffer.from(await res.arrayBuffer()))
      saved.push({ filename: safe, path, mimeType: a.mimeType, size: a.size })
    } catch (err) {
      failed.push({ filename: a.filename, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { saved, failed }
}
