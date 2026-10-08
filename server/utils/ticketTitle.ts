/**
 * A run's ticket by its Jira title, for the inbox: a person opening a gate
 * should see which ticket it is, not only its key.
 *
 * Jira is the source, with the title cached in memory, since the inbox opens
 * the same few gates over and over. When Jira cannot be asked or does not
 * answer, the summary the intake step copied into context-packet.json stands
 * in. Never throws: a missing title only leaves the key on its own.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasJiraCredentialsConfigured } from './jiraCredentials.ts'
import { viewIssue, type FetchLike } from './jiraTicketSource.ts'
import { runArtifactsDir } from './runArtifacts.ts'

const FOUND_MS = 30 * 60 * 1000
// A failed lookup is asked again soon, so a Jira blip does not hide the title for long.
const MISSED_MS = 2 * 60 * 1000

const cache = new Map<string, { title: string | null, at: number }>()

export async function jiraTicketTitle(key: string, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<string | null> {
  const hit = cache.get(key)
  if (hit && now - hit.at < (hit.title ? FOUND_MS : MISSED_MS)) return hit.title
  let title: string | null = null
  if (hasJiraCredentialsConfigured()) {
    try {
      title = (await viewIssue(key, {}, fetchImpl)).summary.trim() || null
    } catch { /* stays null: the packet, or the key alone */ }
  }
  cache.set(key, { title, at: now })
  return title
}

/** The summary the intake step recorded, when it ran and wrote one. */
export async function packetTicketTitle(runId: string): Promise<string | null> {
  try {
    const packet = JSON.parse(await readFile(join(runArtifactsDir(runId), 'context-packet.json'), 'utf-8'))
    const summary = typeof packet?.summary === 'string' ? packet.summary.trim() : ''
    return summary || null
  } catch {
    return null
  }
}

export async function runTicketTitle(run: { id: string, ticketKey?: string }, fetchImpl: FetchLike = fetch): Promise<string | null> {
  if (!run.ticketKey) return null
  return (await jiraTicketTitle(run.ticketKey, fetchImpl)) ?? packetTicketTitle(run.id)
}

/** For tests. */
export function _resetTicketTitles() { cache.clear() }
