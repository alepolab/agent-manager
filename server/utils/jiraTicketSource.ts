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
import { adfToPlainText } from './adf.ts'
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

export interface JiraIssueView { key: string, summary: string, description: string, labels: string[], url: string }

/** One issue by key, as the pipeline wants to read it. Throws on any HTTP or credential failure. */
export async function viewIssue(key: string, env: Record<string, string> = {}, fetchImpl: FetchLike = fetch): Promise<JiraIssueView> {
  const creds = credentialsFrom(env)
  const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,labels`, {
    headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Jira issue ${key} failed (HTTP ${res.status}): ${await describeError(res)}`)
  const issue = await res.json() as JiraIssue & { fields?: { labels?: string[] } }
  const f = issue.fields ?? {}
  return {
    key: issue.key ?? key,
    summary: f.summary ?? '',
    description: adfToPlainText(f.description).trim(),
    labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
    url: `${creds.baseUrl}/browse/${issue.key ?? key}`,
  }
}

/** The text a run should start from for one ticket: key, summary, labels and description. */
export function ticketText(issue: JiraIssueView): string {
  return [
    `${issue.key}: ${issue.summary}`,
    `URL: ${issue.url}`,
    issue.labels.length ? `Labels: ${issue.labels.join(', ')}` : '',
    '',
    issue.description,
  ].filter((l, i) => l !== '' || i === 3).join('\n')
}

/** For a manual run started with only a key: the ticket text, or null when Jira cannot serve it. */
export async function expandTicketKey(prompt: string, env: Record<string, string> = {}, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const key = prompt.trim()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return null
  try {
    return ticketText(await viewIssue(key, env, fetchImpl))
  } catch {
    return null
  }
}
