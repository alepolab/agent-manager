/**
 * An entry the decision gate wrote is completed from ticket-drafts.json all the
 * way down before anything is filed from it.
 *
 * A re-run gate wrote approved-drafts.json with `fields` kept but `custom`
 * dropped, and with no description or acceptance criteria. Completion only ran
 * for an entry with no `fields` at all, so it did nothing: ten Bug drafts whose
 * Steps to Reproduce and Business Value sat in ticket-drafts.json were refused
 * by Jira, and the two Tasks were filed with an empty body.
 *
 *   node scripts/test-gate-entries-complete-from-drafts.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'complete-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'complete-artifacts-'))
const { completeFromDrafts } = await import('../server/utils/jiraCreate.ts')
const { writeArtifactJson } = await import('../server/utils/runArtifacts.ts')

const runId = 'run-complete-1'
await writeArtifactJson(runId, 'ticket-drafts.json', [{
  draft_id: 'DRAFT-001',
  work_type: 'bug',
  summary: 'Tiered-tariff unit conversion has no tests',
  description: '## Problem\nTieredTariffUnits is untested.',
  acceptance_criteria: ['A test covers every unit'],
  fields: {
    project: 'ASECRM', issue_type: 'Bug', priority: 'Major', labels: ['agent-scanner'],
    custom: { 'Steps to Reproduce': '1. Open TieredTariffUnits.java', 'Business Value': 8 },
  },
}])

// What the gate actually wrote: fields without custom, no body, its own verdict.
const entries = [{
  draft_id: 'DRAFT-001',
  summary: 'Edited by the gate',
  fields: { project: 'ASECRM', issue_type: 'Bug', priority: 'Critical' },
  gate: { verdict: 'auto-approved' },
}]
await completeFromDrafts(runId, entries)
const [e] = entries

assert.deepEqual(e.fields.custom, { 'Steps to Reproduce': '1. Open TieredTariffUnits.java', 'Business Value': 8 }, 'custom fields restored inside a partial fields block')
assert.equal(e.description, '## Problem\nTieredTariffUnits is untested.', 'description restored')
assert.deepEqual(e.acceptance_criteria, ['A test covers every unit'], 'acceptance criteria restored')
assert.deepEqual(e.fields.labels, ['agent-scanner'], 'other missing fields restored')
// What the gate stated wins.
assert.equal(e.summary, 'Edited by the gate')
assert.equal(e.fields.priority, 'Critical')
assert.deepEqual(e.gate, { verdict: 'auto-approved' })

// An entry with no matching draft is left as it is.
const orphan = [{ draft_id: 'DRAFT-404', summary: 's', fields: { project: 'ASECRM' } }]
await completeFromDrafts(runId, orphan)
assert.deepEqual(orphan[0], { draft_id: 'DRAFT-404', summary: 's', fields: { project: 'ASECRM' } })

console.log('ok - gate entries are completed from their drafts, nested fields included')
