/**
 * A gate in the inbox names the scan that filed its ticket: by the run's
 * trigger when a scan dispatched it, by the ticket key when someone started it
 * by hand, and not at all when no scan was involved.
 *
 *   node scripts/test-notification-scan-origin.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'scan-origin-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'scan-origin-runs-'))

const { scanOriginIndex, _resetScanOrigins } = await import('../server/utils/scanOrigins.ts')
const { buildNotifications } = await import('../shared/utils/notifications.ts')
const { scanLabel } = await import('../shared/utils/scanOrigin.ts')

const filed = (runId, keys) => {
  const dir = join(process.env.AGENT_RUNS_DIR, runId, 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tickets-created.json'), JSON.stringify(keys.map((k, i) => ({ jira_key: k, entry: `entry ${i + 1}`, runId, createdAt: '2026-10-09T05:43:46Z' }))))
  return join(dir, 'tickets-created.json')
}
const OCT9 = Date.UTC(2026, 9, 8, 13, 30)
const scan = (id, slug, name, startedAt = OCT9) => ({
  id, workflowSlug: slug, workflowName: name, status: 'awaiting_review', startedAt, initialPrompt: 'scan',
  steps: [], question: { kind: 'approval', text: 'Decide which entries', askedAt: startedAt },
})
const gate = (id, ticketKey, watch) => ({
  id, ticketKey, watch, workflowSlug: 'runbook-a-ticket-to-evidence-backed-pr', workflowName: 'Runbook A — Ticket to Evidence-Backed PR',
  status: 'paused', startedAt: OCT9 + 1000, initialPrompt: ticketKey, steps: [],
  question: { kind: 'approval', text: `${ticketKey}: approve "Jira: Dev Done" to run it.`, askedAt: OCT9 + 2000 },
})

// ── the label ──
assert.equal(scanLabel('Scan Performance — Findings to Dispatch'), 'Performance scan')
assert.equal(scanLabel('Scan Test Gaps — Findings to Dispatch'), 'Test Gaps scan')
assert.equal(scanLabel('Nightly audit'), 'Nightly audit', 'a name that is not "Scan X" is left as it is')

const perf = scan('perf-1', 'scan-performance-to-dispatch', 'Scan Performance — Findings to Dispatch')
const func = scan('func-1', 'scan-functional-to-dispatch', 'Scan Functional — Findings to Dispatch')
const file = filed('perf-1', ['ASECRM-583', 'ASECRM-584'])
filed('func-1', ['ASECRM-590'])

const runs = [
  perf, func,
  gate('child', 'ASECRM-583', 'workflow-trigger:perf-1'), // dispatched by the scan
  gate('by-hand', 'ASECRM-584', 'direct-invocation'), // a scan-filed ticket started by hand
  gate('plain', 'ASECRM-243', 'direct-invocation'), // no scan involved
  gate('trigger-only', 'ASECRM-999', 'workflow-trigger:func-1'), // dispatched, though not in the file
]
const byRun = items => Object.fromEntries(items.filter(i => i.kind === 'gate').map(i => [i.runId, i.scan]))

const items = byRun(buildNotifications(runs, [], 'operator', await scanOriginIndex(runs)))
assert.deepEqual(items.child, { runId: 'perf-1', label: 'Performance scan', at: OCT9 }, 'a dispatched run names its scan')
assert.deepEqual(items['by-hand'], { runId: 'perf-1', label: 'Performance scan', at: OCT9 },
  'THE GAP: a scan-filed ticket started by hand names the scan too, found by its key')
assert.equal(items.plain, undefined, 'a ticket no scan filed names none')
assert.equal(items['trigger-only']?.runId, 'func-1', 'the trigger alone is enough')
assert.equal(items['perf-1'], undefined, 'a scan waiting on its own review is not "from" a scan')
assert.ok(!('scan' in buildNotifications(runs, [], 'operator').find(i => i.runId === 'plain')), 'without the index, no field at all')

// ── the file is read again only when it changes ──
_resetScanOrigins()
await scanOriginIndex(runs)
writeFileSync(file, JSON.stringify([{ jira_key: 'ASECRM-583' }, { jira_key: 'ASECRM-584' }, { jira_key: 'ASECRM-243' }]))
utimesSync(file, new Date(), new Date(Date.now() + 5000))
const after = byRun(buildNotifications(runs, [], 'operator', await scanOriginIndex(runs)))
assert.equal(after.plain?.runId, 'perf-1', 'a ticket filed since the last poll is picked up')

// ── a half-written file is nothing filed, not a broken inbox ──
writeFileSync(join(process.env.AGENT_RUNS_DIR, 'func-1', 'artifacts', 'tickets-created.json'), '[{"jira_key": "ASEC')
const broken = byRun(buildNotifications(runs, [], 'operator', await scanOriginIndex(runs)))
assert.equal(broken['trigger-only']?.runId, 'func-1', 'the trigger still names it')
assert.equal(broken.child?.runId, 'perf-1')

console.log('ok - an inbox gate names the scan that filed its ticket')
