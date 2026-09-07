// Runner-executed Jira steps: move the ticket, post the outcome comment, and
// say honestly what was or was not done. Every network call goes through a
// fake fetch; nothing here reaches Jira.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'jira-steps-runs-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'jira-steps-users-'))
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
delete process.env.JIRA_POST_ENABLED

const { runJiraStep } = await import('../server/utils/jiraSteps.ts')

const run = { id: 'run-1', ticketKey: 'CSUP-1', status: 'running', workflowName: 'Runbook A', workflowSlug: 'runbook-a', watch: 'direct-invocation', steps: [], startedAt: Date.now(), budget: { maxMinutes: 1, maxTokens: 1 } }
let calls = []
const record = (url, init) => calls.push([String(url), init?.method ?? 'GET'])

// 1. No ticket: a declared skip, no call.
assert.match(await runJiraStep({ ...run, ticketKey: undefined }, { transition: 'In Progress' }, async () => { throw new Error('must not be called') }), /^PIPELINE-SKIP:/)

// 2. Posting disabled: says what it would have done, calls nothing.
const quiet = await runJiraStep(run, { transition: 'In Progress' }, async (url, init) => { record(url, init); return new Response('{}', { status: 200 }) })
assert.match(quiet, /JIRA_POST_ENABLED/, 'the reason is named')
assert.match(quiet, /In Progress/, 'and so is the intended status')
assert.equal(calls.length, 0, 'no request left the process')

// 3. Enabled: reads the transitions, posts the one whose target matches, case-insensitively.
process.env.JIRA_POST_ENABLED = '1'
const transitions = { transitions: [{ id: '11', name: 'Start progress', to: { name: 'In Progress' } }, { id: '31', name: 'Done', to: { name: 'Done' } }] }
const jira = async (url, init) => {
  record(url, init)
  if (String(url).endsWith('/transitions') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(transitions), { status: 200 })
  return new Response(null, { status: 204 })
}
calls = []
const moved = await runJiraStep(run, { transition: 'in progress' }, jira)
assert.match(moved, /Moved CSUP-1 to "In Progress"/, moved)
assert.deepEqual(calls.map(c => c[1]), ['GET', 'POST'], 'one read, one write')
assert.ok(calls.every(c => c[0] === 'https://jira.test/rest/api/3/issue/CSUP-1/transitions'), calls.map(c => c[0]).join(','))

// 4. No such transition: names what is available and does not throw; the run goes on.
calls = []
const none = await runJiraStep(run, { transition: 'In Review' }, jira)
assert.match(none, /no transition to "In Review"/, none)
assert.match(none, /In Progress, Done/, 'the available targets are listed')
assert.deepEqual(calls.map(c => c[1]), ['GET'], 'nothing was posted')

// 5. The comment goes through the notifier, which posts it and records the artifact.
calls = []
const commented = await runJiraStep(run, { comment: true }, async (url, init) => { record(url, init); return new Response('{}', { status: 201 }) })
assert.match(commented, /Comment posted on CSUP-1/, commented)
assert.ok(calls.some(c => c[0].endsWith('/rest/api/3/issue/CSUP-1/comment') && c[1] === 'POST'))
assert.equal(run.ticketCommented, true, 'the run remembers the comment so settling does not post a second one')

// 6. A Jira outage is reported, not thrown.
const down = await runJiraStep({ ...run, ticketCommented: undefined }, { transition: 'In Progress' }, async () => new Response('', { status: 503 }))
assert.match(down, /HTTP 503/, down)
assert.match(down, /not moved/)

delete process.env.JIRA_POST_ENABLED
console.log('jira steps: all checks passed')
