/**
 * A Jira step fills the fields its transition's screen demands.
 *
 * ASECRM refuses "Ready For QA" with HTTP 400 "Add CI Release Details" unless
 * its CI-Release Details field (a rich-text field on the transition screen) is
 * set in the same request, so ASECRM-217 stopped at DEV DONE and every QA
 * status after it failed. The team puts the pull request link there - but the
 * PR only opens later in the run, so Ready for QA takes the branch link and
 * QA Done replaces it with the PR on the issue itself.
 *
 *   node scripts/test-jira-transition-fields.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'jira-fields-runs-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'jira-fields-users-'))
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
process.env.JIRA_POST_ENABLED = '1'

const { runJiraStep } = await import('../server/utils/jiraSteps.ts')
const { writeArtifactJson } = await import('../server/utils/runArtifacts.ts')

/** ASECRM-217 as it was: in DEV DONE, offering Blocked and Ready For QA. */
function asecrm() {
  const posted = []
  const listed = []
  const put = []
  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/transitions') && (init.method ?? 'GET') === 'GET') {
      listed.push(u)
      return new Response(JSON.stringify({ transitions: [
        { id: '41', name: 'Blocked', to: { name: 'Blocked' }, fields: { customfield_12916: { name: 'Blocker Reason', schema: { type: 'string' } } } },
        { id: '51', name: 'Ready For QA', to: { name: 'READY FOR QA', statusCategory: { key: 'indeterminate' } },
          fields: { customfield_12951: { name: 'CI-Release Details', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } } } },
      ] }), { status: 200 })
    }
    if (u.endsWith('/editmeta')) {
      return new Response(JSON.stringify({ fields: { customfield_12951: { name: 'CI-Release Details', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } } } }), { status: 200 })
    }
    if (init.method === 'PUT') { put.push(JSON.parse(init.body)); return new Response(null, { status: 204 }) }
    if (u.endsWith('?fields=status')) return new Response(JSON.stringify({ fields: { status: { name: 'DEV DONE', statusCategory: { key: 'done' } } } }), { status: 200 })
    if (u.includes('/transitions') && init.method === 'POST') {
      const body = JSON.parse(init.body)
      posted.push(body)
      // Jira's validator, as ASECRM has it.
      return body.fields?.customfield_12951
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ errorMessages: ['Add CI Release Details'], errors: {} }), { status: 400 })
    }
    return new Response('{}', { status: 200 })
  }
  return { fetchImpl, posted, listed, put }
}

const step = { transition: 'Ready for QA', fields: { 'CI Release Details': '{pr_or_branch}' } }

// ── With a PR on record: the field is sent, as ADF, and the ticket moves ─────
{
  const run = { id: 'run-fields-1', ticketKey: 'ASECRM-217', watch: 'direct-invocation' }
  await writeArtifactJson(run.id, 'meta.json', { fix: { repos: [{ repo: 'alepolab/ase-crm', pr: 'https://github.com/alepolab/ase-crm/pull/793' }] } })
  const jira = asecrm()
  const out = await runJiraStep(run, step, jira.fetchImpl)
  assert.ok(jira.listed.every(u => u.includes('expand=transitions.fields')), 'the screen is read to find the field')
  assert.equal(jira.posted.length, 1)
  assert.equal(jira.posted[0].transition.id, '51')
  const doc = jira.posted[0].fields.customfield_12951
  assert.equal(doc.type, 'doc', 'a textarea takes ADF, not a bare string')
  assert.match(JSON.stringify(doc), /https:\/\/github\.com\/alepolab\/ase-crm\/pull\/793/)
  assert.match(out, /Moved ASECRM-217 to "READY FOR QA"/, out)
  assert.match(out, /Set "CI-Release Details" to https:\/\/github\.com\/alepolab\/ase-crm\/pull\/793/, 'the step says what it set')
}

// ── No PR yet: Ready for QA takes the branch link, and the ticket moves ──────
{
  const run = { id: 'run-fields-2', ticketKey: 'ASECRM-215', watch: 'direct-invocation', branch: 'fix/ASECRM-215-9ca1501b', product: { name: 'ase-crm', repos: ['alepolab/ase-crm'] } }
  await writeArtifactJson(run.id, 'meta.json', { fix: { repos: [{ repo: 'alepolab/ase-crm', pr: 'https://example.invalid/pending' }] } })
  const jira = asecrm()
  const out = await runJiraStep(run, step, jira.fetchImpl)
  assert.match(JSON.stringify(jira.posted[0].fields.customfield_12951), /https:\/\/github\.com\/alepolab\/ase-crm\/tree\/fix\/ASECRM-215-9ca1501b/,
    'the placeholder PR is not a link; the branch stands in for it')
  assert.match(out, /Moved ASECRM-215 to "READY FOR QA"/, out)
}

// ── QA Done, after the PR opened: the field is replaced with the PR, on the issue
// The QA Done transition has no such field on its screen (and on ASECRM there
// may be no QA Done transition at all), so the value goes through an edit.
{
  const run = { id: 'run-fields-2', ticketKey: 'ASECRM-215', watch: 'direct-invocation', branch: 'fix/ASECRM-215-9ca1501b' }
  await writeArtifactJson(run.id, 'meta.json', { fix: { repos: [{ repo: 'alepolab/ase-crm', pr: 'https://github.com/alepolab/ase-crm/pull/801' }] } })
  const jira = asecrm()
  const out = await runJiraStep(run, { transition: 'QA Done', fields: { 'CI Release Details': '{pr}' } }, jira.fetchImpl)
  assert.equal(jira.put.length, 1, 'set on the issue, whatever became of the move')
  assert.match(JSON.stringify(jira.put[0].fields.customfield_12951), /pull\/801/)
  assert.equal(jira.put[0].fields.customfield_12951.type, 'doc')
  assert.match(out, /Set "CI-Release Details" to https:\/\/github\.com\/alepolab\/ase-crm\/pull\/801/, out)
}

// ── Neither a PR nor a branch: nothing is invented ──────────────────────────
{
  const run = { id: 'run-fields-4', ticketKey: 'ASECRM-9', watch: 'direct-invocation' }
  const jira = asecrm()
  const out = await runJiraStep(run, step, jira.fetchImpl)
  assert.equal(jira.posted[0].fields, undefined, 'no link, no field')
  assert.match(out, /failed \(HTTP 400\).*Add CI Release Details/s, 'Jira\'s own refusal is reported')
  assert.match(out, /no branch in a known repository yet/, 'and why the field was empty')
}

// ── A step with no fields still lists transitions the old way ───────────────
{
  const run = { id: 'run-fields-3', ticketKey: 'ASECRM-1', watch: 'direct-invocation' }
  const jira = asecrm()
  await runJiraStep(run, { transition: 'Ready for QA' }, jira.fetchImpl)
  assert.ok(jira.listed.every(u => !u.includes('expand=')), 'no expand when no field is configured')
  assert.equal(jira.posted[0].fields, undefined)
}

console.log('ok - Jira transitions fill the fields their screen demands, from the PR link')
