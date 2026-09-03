/**
 * The ticket-source seam.
 *
 * The app has no Jira integration today, and the Atlassian MCP tools this
 * session can see are bound to an interactive Claude Code session, not to
 * this server process — there is no way for a background poller to call
 * them. Rather than block the watcher on that integration, it is built
 * against this `TicketSource` interface, backed for now by a file-based
 * stub that reads `~/.claude/watch-tickets/<watchId>.json`. That makes the
 * scheduling, dedupe, failure-isolation and cap logic (Task 3) real and
 * testable today — editing a JSON file drives the whole loop, including
 * failure paths — and a Jira-backed `TicketSource` slots in later via
 * `setTicketSource` with no redesign of anything downstream.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolveClaudePath } from './claudeDir.ts'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'

export const WATCH_TICKETS_DIR_NAME = 'watch-tickets'

export interface TicketSource {
  /**
   * Tickets currently matching this watch. Returning the same ticket on
   * every call is expected and harmless — dedupe against tickets already
   * seen or dispatched is the scheduler's job, not the source's. Splitting
   * that responsibility across both places would make it possible for a
   * ticket to be silently dropped by one and picked up by the other.
   */
  fetch(watch: Watch): Promise<TicketRef[]>
}

/**
 * File-backed stub source. A missing, unreadable, or malformed source file
 * yields `[]`, never an exception — a broken source must not stop the
 * scheduler; it degrades only that one watch's cycle.
 */
export function createFileTicketSource(): TicketSource {
  return {
    async fetch(watch: Watch): Promise<TicketRef[]> {
      const path = resolveClaudePath(WATCH_TICKETS_DIR_NAME, `${watch.id}.json`)
      if (!existsSync(path)) return []
      try {
        const parsed = JSON.parse(await readFile(path, 'utf-8'))
        return Array.isArray(parsed) ? (parsed as TicketRef[]) : []
      } catch {
        // Malformed JSON, permission error, etc. — degrade to empty rather
        // than throwing out of the poll cycle.
        return []
      }
    },
  }
}

let current: TicketSource = createFileTicketSource()

/** Swap the active source at runtime — this is how tests drive the seam,
 *  and how a Jira source will replace the stub in production later. */
export function setTicketSource(source: TicketSource): void {
  current = source
}

export function getTicketSource(): TicketSource {
  return current
}
