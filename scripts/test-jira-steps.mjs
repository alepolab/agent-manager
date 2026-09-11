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

const { runJiraStep, transitionReachable } = await import('../server/utils/jiraSteps.ts')

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

// 5b. "Dev Done" lands even where the project's workflow calls the state "Ready for Review".
const reviewWf = { transitions: [{ id: '41', name: 'Ready for review', to: { name: 'Ready for Review' } }, { id: '51', name: 'Close', to: { name: 'Closed' } }] }
const jiraReview = async (url, init) => {
  if (String(url).endsWith('/transitions') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(reviewWf), { status: 200 })
  return new Response(null, { status: 204 })
}
const syn = await runJiraStep(run, { transition: 'Dev Done' }, jiraReview)
assert.match(syn, /Moved CSUP-1 to "Ready for Review"/, `synonym match failed: ${syn}`)

// 5c. attach uploads every top-level evidence file, once each, to the attachments endpoint.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'jira-attach-'))
  const adir = join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts')
  mkdirSync(join(adir, 'steps'), { recursive: true })
  writeFileSync(join(adir, 'bundle.json'), '{}')
  writeFileSync(join(adir, 'security-review.md'), '# ok')
  writeFileSync(join(adir, 'steps', 'step-01.log'), 'verbose')
  const uploads = []
  const out = await runJiraStep(run, { attach: true }, async (url, init) => { uploads.push([String(url), init?.method]); return new Response('[]', { status: 200 }) })
  assert.match(out, /Attached 2 of 2 evidence file\(s\) to CSUP-1/, `attach summary wrong: ${out}`)
  assert.ok(uploads.every(u => u[0].endsWith('/rest/api/3/issue/CSUP-1/attachments') && u[1] === 'POST'), 'each file POSTs to the attachments endpoint')
  assert.equal(uploads.length, 2, 'only the two top-level files are attached; the steps/ log is not')
}

// 5c. No name or synonym, but Jira's status category says which transition starts work.
//     A project whose only in-progress status reachable from here is "In Analysis" moves there.
const withStatus = (current, category, list) => async (url, init) => {
  record(url, init)
  const u = String(url)
  if (u.endsWith('?fields=status')) return new Response(JSON.stringify({ fields: { status: { name: current, statusCategory: { key: category } } } }), { status: 200 })
  if (u.endsWith('/transitions') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ transitions: list }), { status: 200 })
  return new Response(null, { status: 204 })
}
const st = (name, key) => ({ name, statusCategory: { key } })
calls = []
const byCategory = await runJiraStep(run, { transition: 'In Progress' }, withStatus('Open', 'new', [
  { id: '21', name: 'Analyse', to: st('In Analysis', 'indeterminate') }, { id: '51', name: 'Close', to: st('Closed', 'done') },
]))
assert.match(byCategory, /Moved CSUP-1 to "In Analysis"/, `category fallback failed: ${byCategory}`)
assert.match(byCategory, /only in-progress status/, 'and says why that status was chosen')
assert.deepEqual(calls.map(c => c[1]), ['GET', 'GET', 'POST'], 'transitions, current status, one write')

// 5d. Several in-progress statuses and none reads as development: the ticket is left where it is, and the message names them.
calls = []
const ambiguous = await runJiraStep(run, { transition: 'In Progress' }, withStatus('Open', 'new', [
  { id: '1', name: 'Close', to: st('Closed', 'done') }, { id: '2', name: 'Analyse', to: st('Business Analysis', 'indeterminate') },
  { id: '3', name: 'Accept', to: st('PDM Accepted', 'new') }, { id: '4', name: 'Refine', to: st('Under PdM  Refinement', 'indeterminate') },
]))
assert.match(ambiguous, /"Business Analysis", "Under PdM  Refinement"/, ambiguous)
assert.match(ambiguous, /left as is/)
assert.ok(!calls.some(c => c[1] === 'POST'), 'nothing was posted')

// 5e. Several in-progress statuses, exactly one of which reads as development work.
calls = []
const dev = await runJiraStep(run, { transition: 'In Progress' }, withStatus('Open', 'new', [
  { id: '2', name: 'Analyse', to: st('Business Analysis', 'indeterminate') }, { id: '5', name: 'Develop', to: st('In Development', 'indeterminate') },
]))
assert.match(dev, /Moved CSUP-1 to "In Development"/, dev)

// 5f. Already in an in-progress status (moved by hand): nothing to do, no write.
calls = []
const already = await runJiraStep(run, { transition: 'In Progress' }, withStatus('In Development', 'indeterminate', [{ id: '31', name: 'Done', to: st('Done', 'done') }]))
assert.match(already, /already in "In Development"/, already)
assert.ok(!calls.some(c => c[1] === 'POST'), 'nothing was posted')

// 6. A Jira outage is reported, not thrown.
const down = await runJiraStep({ ...run, ticketCommented: undefined }, { transition: 'In Progress' }, async () => new Response('', { status: 503 }))
assert.match(down, /HTTP 503/, down)
assert.match(down, /not moved/)

delete process.env.JIRA_POST_ENABLED
// ── a status spelled with punctuation still matches ──────────────────────────
// CSUP's status is "Dev. Done"; the runbook asks for "Dev Done". An exact
// lowercase compare missed it and reported "offers no transition to Dev Done or
// a known synonym" while listing "Dev. Done" among the available transitions.
{
  const transitions = [
    { id: '1', name: 'Stop Progress', to: { name: 'To Do', statusCategory: { key: 'new' } } },
    { id: '2', name: 'Dev. Done', to: { name: 'Dev. Done', statusCategory: { key: 'indeterminate' } } },
  ]
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/transitions') && (!init || init.method !== 'POST')) {
      return { ok: true, status: 200, json: async () => ({ transitions }) }
    }
    if (String(url).includes('?fields=status')) {
      return { ok: true, status: 200, json: async () => ({ fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } }) }
    }
    return { ok: true, status: 204, json: async () => ({}) }
  }
  const verdict = await transitionReachable({ ...run, ticketKey: 'CSUP-1' }, 'CSUP-1', 'Dev Done', fetchImpl)
  assert.equal(verdict.ok, true, JSON.stringify(verdict))
  assert.match(verdict.detail, /Dev\. Done/)
}

console.log('jira steps: all checks passed')
