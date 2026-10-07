/**
 * A gate opened in the inbox is headed by its ticket's Jira title: from Jira,
 * cached, and from the intake step's context packet when Jira cannot answer.
 *
 *   node scripts/test-ticket-title.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ticket-title-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'ticket-title-runs-'))
process.env.JIRA_BASE_URL = 'https://jira.example.test'
process.env.JIRA_EMAIL = 'bot@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'

const t = await import('../server/utils/ticketTitle.ts')

let calls = 0
let answer = { status: 200, body: { key: 'ASECRM-1', fields: { summary: '  Tiered tariff stores the wrong tier  ' } } }
const fakeFetch = async (url) => {
  calls++
  assert.match(String(url), /\/rest\/api\/3\/issue\/ASECRM-1\?/)
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
}

// ── from Jira, trimmed, and cached ──
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 1000), 'Tiered tariff stores the wrong tier')
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 2000), 'Tiered tariff stores the wrong tier')
assert.equal(calls, 1, 'the second open is served from the cache')
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 1000 + 31 * 60 * 1000), 'Tiered tariff stores the wrong tier')
assert.equal(calls, 2, 'and asked again once the cache is old')

// ── Jira refuses: no title, never a throw, asked again soon ──
t._resetTicketTitles(); calls = 0
answer = { status: 503, body: { errorMessages: ['down'] } }
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 1000), null)
answer = { status: 200, body: { key: 'ASECRM-1', fields: { summary: 'Back again' } } }
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 1000 + 60 * 1000), null, 'a miss is remembered for a moment')
assert.equal(await t.jiraTicketTitle('ASECRM-1', fakeFetch, 1000 + 3 * 60 * 1000), 'Back again', 'but not for long')

// ── the intake packet stands in when Jira has nothing ──
t._resetTicketTitles()
answer = { status: 404, body: { errorMessages: ['gone'] } }
const dir = join(process.env.AGENT_RUNS_DIR, 'run-1', 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'context-packet.json'), JSON.stringify({ ticket_key: 'ASECRM-1', summary: 'From the intake packet' }))
assert.equal(await t.runTicketTitle({ id: 'run-1', ticketKey: 'ASECRM-1' }, fakeFetch), 'From the intake packet')
assert.equal(await t.runTicketTitle({ id: 'run-2', ticketKey: 'ASECRM-1' }, fakeFetch), null, 'no packet, no title: the key stands alone')
assert.equal(await t.runTicketTitle({ id: 'run-1' }, fakeFetch), null, 'a run without a ticket has no ticket title')

// ── no Jira configured: the packet, without trying the network ──
t._resetTicketTitles(); calls = 0
delete process.env.JIRA_API_TOKEN
assert.equal(await t.runTicketTitle({ id: 'run-1', ticketKey: 'ASECRM-1' }, fakeFetch), 'From the intake packet')
assert.equal(calls, 0)

console.log('ok - an opened gate is headed by its ticket\'s Jira title')
