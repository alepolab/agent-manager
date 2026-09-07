/**
 * Self-check for server/utils/ticketNotifier.ts — B5's "posts the PR link
 * back" half. Plain asserts, no framework, no network and no real Jira
 * write: the "posting enabled" path is exercised with an injected fake
 * fetch, so this file proves the gating and request-shaping logic without
 * ever performing a real post, even when it deliberately flips
 * JIRA_POST_ENABLED=1 on the fake.
 *
 *   node scripts/test-ticket-notifier.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'notifier-runs-'))
delete process.env.JIRA_POST_ENABLED
delete process.env.JIRA_COMMENT_FOR_VIS_NAME

const { renderTicketComment, notifyTicketOutcome } = await import('../server/utils/ticketNotifier.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const watch = {
  id: 'w1', name: 'Jira Watch', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 2, dailyDispatchCap: 10, autoRun: false,
  query: 'project = CSUP',
}

function writeMeta(runId, meta) {
  const dir = join(runArtifactsDir(runId), 'steps')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(runArtifactsDir(runId), 'meta.json'), JSON.stringify(meta, null, 2))
}

// ══ renderTicketComment — pure, no I/O ═════════════════════════════════════

// ── 1. A PR link is the headline; no fabricated "For vis" line ─────────────
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-1',
    watchName: 'Jira Watch',
    owner: 'Priya Nair',
    outcome: { runId: 'run-1', runStatus: 'completed', prUrls: ['https://github.com/alepolab/pms/pull/42'] },
  })
  assert.match(comment, /^@Priya Nair/)
  assert.match(comment, /pull request is ready for review/)
  assert.match(comment, /https:\/\/github\.com\/alepolab\/pms\/pull\/42/)
  assert.doesNotMatch(comment, /For vis:/, 'no For-vis name configured means no For-vis line, never a placeholder')
}

// ── 2. A halted run states the reason, never a fabricated PR ───────────────
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-2',
    watchName: 'Jira Watch',
    outcome: { runId: 'run-2', runStatus: 'failed', prUrls: [], haltReason: 'stack would not come up' },
  })
  assert.doesNotMatch(comment, /pull request is ready/)
  assert.match(comment, /stopped before opening a pull request/)
  assert.match(comment, /stack would not come up/)
  assert.match(comment, /^\(no assignee or reporter/, 'no owner known is stated plainly, not invented')
}

// ── 3. forVisName, when given, appears as the house-style closing line ─────
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-3',
    watchName: 'Jira Watch',
    outcome: { runId: 'run-3', runStatus: 'failed', prUrls: [], haltReason: 'timed out' },
    forVisName: 'Ashwani',
  })
  assert.match(comment, /For vis: Ashwani$/m)
}

// ══ notifyTicketOutcome — the wiring, gating, and artifact write ══════════

// ── 4. Default (JIRA_POST_ENABLED unset): never posts, always records ──────
{
  const run = { id: 'run-100', status: 'completed', error: undefined }
  writeMeta(run.id, { fix: { repos: [{ repo: 'alepolab/pms', commits: ['abc1234'], pr: 'https://github.com/alepolab/pms/pull/7' }] } })

  let fetchCalled = false
  const result = await notifyTicketOutcome(watch, 'CSUP-100', run, {}, async () => { fetchCalled = true })

  assert.equal(fetchCalled, false, 'posting must never happen while JIRA_POST_ENABLED is unset')
  assert.equal(result.posted, false)
  assert.match(result.reason, /disabled by default/)
  assert.match(result.comment, /https:\/\/github\.com\/alepolab\/pms\/pull\/7/)

  assert.ok(existsSync(result.artifactPath), 'the rendered comment is recorded as an artifact')
  const recorded = JSON.parse(readFileSync(result.artifactPath, 'utf-8'))
  assert.equal(recorded.posted, false)
  assert.equal(recorded.ticketKey, 'CSUP-100')
  assert.match(recorded.comment, /pull request is ready/)
}

// ── 5. A halted run (no PR in meta.json) reports run.error, not a guess ────
{
  const run = { id: 'run-101', status: 'failed', error: "Step halted: stack would not come up" }
  // No meta.json at all for this run — the evidence step never ran.
  const result = await notifyTicketOutcome(watch, 'CSUP-101', run)
  assert.match(result.comment, /Step halted: stack would not come up/)
  assert.doesNotMatch(result.comment, /pull request is ready/)
}

// ── 6a. A run started by a developer with a stored Jira token posts as them ─
{
  process.env.JIRA_POST_ENABLED = '1'
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
  process.env.JIRA_EMAIL = 'bot@example.com'
  process.env.JIRA_API_TOKEN = 'bot-token'
  process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'notifier-users-'))
  process.env.AGENT_MANAGER_SECRET = 'test-secret-that-is-long-enough-for-sealing-0001'
  try {
    const { saveProfile } = await import('../server/utils/users.ts')
    await saveProfile('sandeep', { jiraEmail: 'sandeep@example.com', jiraTokenPlain: 'sandeep-token' })
    const run = { id: 'run-102a', status: 'completed', error: undefined, startedBy: 'sandeep' }
    writeMeta(run.id, { fix: { repos: [{ repo: 'alepolab/pms', commits: ['abc1234'], pr: 'https://github.com/alepolab/pms/pull/9' }] } })
    let posted
    const result = await notifyTicketOutcome(watch, 'CSUP-102', run, {}, async (url, init) => { posted = { url, init }; return { ok: true, status: 200, statusText: 'OK', text: async () => '' } })
    assert.equal(result.posted, true)
    assert.equal(posted.init.headers.Authorization, `Basic ${Buffer.from('sandeep@example.com:sandeep-token').toString('base64')}`, 'the comment is posted under the starter, not the instance')
    const anon = { ...run, id: 'run-102b', startedBy: 'nobody' }
    writeMeta(anon.id, { fix: { repos: [] } })
    await notifyTicketOutcome(watch, 'CSUP-102', anon, {}, async (url, init) => { posted = { url, init }; return { ok: true, status: 200, statusText: 'OK', text: async () => '' } })
    assert.equal(posted.init.headers.Authorization, `Basic ${Buffer.from('bot@example.com:bot-token').toString('base64')}`, 'no profile falls back to the instance identity')
  } finally {
    rmSync(process.env.AGENT_USERS_DIR, { recursive: true, force: true })
    delete process.env.AGENT_USERS_DIR; delete process.env.AGENT_MANAGER_SECRET
    delete process.env.JIRA_POST_ENABLED; delete process.env.JIRA_BASE_URL; delete process.env.JIRA_EMAIL; delete process.env.JIRA_API_TOKEN
  }
}

// ── 6. Enabling posting flips the gate — proven with a fake fetch only ─────
{
  process.env.JIRA_POST_ENABLED = '1'
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
  process.env.JIRA_EMAIL = 'bot@example.com'
  process.env.JIRA_API_TOKEN = 'test-token'
  try {
    const run = { id: 'run-102', status: 'completed', error: undefined }
    writeMeta(run.id, { fix: { repos: [{ repo: 'alepolab/pms', commits: ['abc1234'], pr: 'https://github.com/alepolab/pms/pull/9' }] } })

    let posted
    const fetchImpl = async (url, init) => {
      posted = { url, init }
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' }
    }
    const result = await notifyTicketOutcome(watch, 'CSUP-102', run, {}, fetchImpl)

    assert.equal(result.posted, true)
    assert.equal(result.reason, undefined)
    assert.equal(posted.url, 'https://example.atlassian.net/rest/api/3/issue/CSUP-102/comment')
    assert.equal(posted.init.method, 'POST')
    assert.match(posted.init.headers.Authorization, /^Basic /)
    const body = JSON.parse(posted.init.body)
    assert.equal(body.body.type, 'doc', 'the posted body is ADF, not a bare string')
  } finally {
    delete process.env.JIRA_POST_ENABLED
    delete process.env.JIRA_BASE_URL
    delete process.env.JIRA_EMAIL
    delete process.env.JIRA_API_TOKEN
  }
}

// ── 7. Posting enabled but a real Jira failure is reported, not swallowed ──
{
  process.env.JIRA_POST_ENABLED = '1'
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
  process.env.JIRA_EMAIL = 'bot@example.com'
  process.env.JIRA_API_TOKEN = 'test-token'
  try {
    const run = { id: 'run-103', status: 'failed', error: 'run ended with status \'failed\'' }
    const fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'no permission' })
    const result = await notifyTicketOutcome(watch, 'CSUP-103', run, {}, fetchImpl)
    assert.equal(result.posted, false)
    assert.match(result.reason, /403/)
  } finally {
    delete process.env.JIRA_POST_ENABLED
    delete process.env.JIRA_BASE_URL
    delete process.env.JIRA_EMAIL
    delete process.env.JIRA_API_TOKEN
  }
}

rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('ticketNotifier: all assertions passed')
