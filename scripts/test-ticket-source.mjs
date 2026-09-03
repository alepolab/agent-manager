/**
 * Self-check for server/utils/ticketSource.ts. Plain asserts, no framework.
 * Uses a temp CLAUDE_DIR so it never touches the real ~/.claude.
 *
 *   node scripts/test-ticket-source.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ticketsrc-'))
const { createFileTicketSource, setTicketSource, getTicketSource } =
  await import('../server/utils/ticketSource.ts')

const watch = {
  id: 'w1', name: 'W1', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 2, dailyDispatchCap: 10, autoRun: false,
}

// ── 1. No file yet → no tickets, never an error ───────────────────────────
const src = createFileTicketSource()
assert.deepEqual(await src.fetch(watch), [], 'a missing ticket file is empty, not fatal')

// ── 2. Tickets are read from disk ─────────────────────────────────────────
mkdirSync(join(process.env.CLAUDE_DIR, 'watch-tickets'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'watch-tickets', 'w1.json'), JSON.stringify([
  { key: 'CSUP-1', summary: 'one', description: 'first', updatedAt: 1 },
  { key: 'CSUP-2', summary: 'two', description: 'second', updatedAt: 2 },
]))
const tickets = await src.fetch(watch)
assert.equal(tickets.length, 2)
assert.equal(tickets[0].key, 'CSUP-1')

// ── 3. Malformed content is empty, not a crash ────────────────────────────
writeFileSync(join(process.env.CLAUDE_DIR, 'watch-tickets', 'w1.json'), 'not json')
assert.deepEqual(await src.fetch(watch), [], 'a broken source file must not stop the scheduler')

// ── 4. The seam is swappable — this is how Jira arrives later ─────────────
setTicketSource({ fetch: async () => [{ key: 'X-1', summary: 's', description: 'd', updatedAt: 0 }] })
assert.equal((await getTicketSource().fetch(watch))[0].key, 'X-1')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('ticketSource: all assertions passed')
