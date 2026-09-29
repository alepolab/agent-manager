/**
 * The tickets a scan's findings may already be tracked by, fetched before any
 * agent runs and written where the scanner and triage can read them.
 *
 * Neither agent has the network - Read, Write, Grep, Glob and a shell with no
 * Jira credentials - so triage marked "dedup against Jira: not checked" on
 * every run, and a nightly scan with no review filed the same findings again
 * each night. This is the list it checks against.
 *
 * Open tickets, plus ones resolved in the last 30 days: a fix that is resolved
 * in Jira but not yet on the scanned branch is still found, and is not new.
 * Except those resolved Invalid: that is how a ticket filed in error is
 * retracted, and counting it would hide the real finding it was mistaken for.
 */
import { adfToPlainText } from './adf.ts'
import { jiraAuthHeader } from './jiraCredentials.ts'
import type { FetchLike } from './jiraTicketSource.ts'

export const EXISTING_TICKETS_ARTIFACT = 'existing-tickets.json'

export interface ExistingTicket {
  key: string
  summary: string
  status: string
  labels: string[]
  /** The description's first few hundred characters, as plain text. */
  excerpt: string
}

const PAGE_SIZE = 100
const MAX_PAGES = 5
const EXCERPT_CHARS = 400

/** Throws on any refusal: "no tickets" and "could not ask" must never look alike. */
export async function fetchExistingTickets(
  creds: { baseUrl: string, email: string, apiToken: string },
  project: string,
  fetchImpl: FetchLike = fetch,
): Promise<ExistingTicket[]> {
  const jql = `project = "${project.replace(/"/g, '')}" AND (statusCategory != Done OR resolved >= -30d) AND (resolution is EMPTY OR resolution != Invalid) ORDER BY created DESC`
  const out: ExistingTicket[] = []
  let nextPageToken: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${creds.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Authorization: jiraAuthHeader(creds), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, fields: ['summary', 'status', 'labels', 'description'], maxResults: PAGE_SIZE, ...(nextPageToken ? { nextPageToken } : {}) }),
    })
    if (!res.ok) throw new Error(`Jira answered ${res.status} to the search for ${project}'s existing tickets`)
    const body = await res.json() as {
      issues?: { key: string, fields?: { summary?: string, status?: { name?: string }, labels?: string[], description?: unknown } }[]
      nextPageToken?: string
      isLast?: boolean
    }
    for (const i of body.issues ?? []) {
      const text = typeof i.fields?.description === 'string' ? i.fields.description : adfToPlainText(i.fields?.description)
      out.push({
        key: i.key,
        summary: i.fields?.summary?.trim() ?? '',
        status: i.fields?.status?.name ?? '',
        labels: i.fields?.labels ?? [],
        excerpt: (text ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
      })
    }
    if (body.isLast !== false || !body.nextPageToken) break
    nextPageToken = body.nextPageToken
  }
  return out
}
