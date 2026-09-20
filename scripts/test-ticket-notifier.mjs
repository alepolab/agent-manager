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

// -- the comment names the regression area -------------------------------
// A ticket comment saying "a pull request is ready for review" tells the
// reporter nothing about what else the change could have broken. The reviewer
// then has to open the diff to work out what to retest, which is exactly the
// work the run already did and threw away.
//
// Only runner-owned facts go in: the repositories the run committed to, the
// blast radius it was classified as, and the modules the product declares. No
// prose from an agent, because a regression area nobody can check is worse than
// none at all.
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-7495',
    watchName: 'Jira Watch',
    owner: 'Priya Nair',
    outcome: {
      runId: 'run-9', runStatus: 'completed',
      prUrls: ['https://github.com/alepolab/administrator_lbss/pull/117'],
      regression: {
        repos: ['alepolab/administrator_lbss', 'alepolab/liferay-extension_lbss'],
        blastRadius: 'ui_parsing',
        modules: ['administrator', 'liferay-extension'],
      },
    },
  })
  assert.match(comment, /Regression area/i, 'the comment names a regression area')
  assert.match(comment, /administrator_lbss/, 'and the repositories that were touched')
  assert.match(comment, /liferay-extension_lbss/, 'including the second repo of a multi-repo run')
  assert.match(comment, /ui_parsing/, 'and the blast radius the run was classified as')
}

// -- an unclassified run says so rather than implying a small blast radius --
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-7496',
    watchName: 'Jira Watch',
    outcome: {
      runId: 'run-10', runStatus: 'completed',
      prUrls: ['https://github.com/alepolab/pms/pull/1'],
      regression: { repos: ['alepolab/pms'] },
    },
  })
  assert.match(comment, /Regression area/i)
  assert.match(comment, /not classified|unclassified/i, 'an absent blast radius is stated, never omitted silently')
}

// -- nothing known means no section, not an empty heading -----------------
{
  const comment = renderTicketComment({
    ticketKey: 'CSUP-7497',
    watchName: 'Jira Watch',
    outcome: { runId: 'run-11', runStatus: 'failed', prUrls: [] },
  })
  assert.doesNotMatch(comment, /Regression area/i, 'a run that knows no repos writes no regression heading')
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
// ══ the comment is posted once, even across a restart ════════════════════
// A run whose process dies mid-step comes back as `interrupted`, and resuming
// re-runs the frozen step (workflowRunStore.ts:79-100, workflowRunner.ts:1866).
// The step's in-memory `ticketCommented` died with the process, so the second
// attempt used to post a second comment onto a real ticket - and because the
// comment renders from the run's state at the moment of posting, the two can
// contradict each other.
//
// The durable marker was already being written and never read: jira-comment.json
// carries posted:true, the run id and the ticket key.
{
  process.env.JIRA_POST_ENABLED = '1'
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
  process.env.JIRA_EMAIL = 'bot@example.com'
  process.env.JIRA_API_TOKEN = 'bot-token'
  const run = { id: `idem-${Date.now()}`, status: 'completed', error: undefined }

  let posts = 0
  const fetchOk = async () => { posts += 1; return { ok: true, status: 201, text: async () => '' } }

  const first = await notifyTicketOutcome(watch, 'CSUP-200', run, {}, fetchOk)
  assert.equal(first.posted, true, 'the first attempt posts')
  assert.equal(posts, 1)
  assert.ok(existsSync(first.artifactPath), 'and records the marker it will read next time')

  // The restart: same run, same ticket, a fresh attempt with no memory.
  const second = await notifyTicketOutcome(watch, 'CSUP-200', run, {}, fetchOk)
  assert.equal(posts, 1, `the second attempt posts NOTHING; it posted ${posts} times in total`)
  assert.equal(second.posted, true, 'and still reports the comment as posted, because it is on the ticket')
  assert.equal(second.alreadyPosted, true, 'flagged so a caller can tell a fresh post from a suppressed one')

  // A different ticket is a different effect and must still post.
  const other = await notifyTicketOutcome(watch, 'CSUP-201', run, {}, fetchOk)
  assert.equal(posts, 2, `a different ticket still posts; total posts ${posts}`)
  assert.equal(other.alreadyPosted, undefined)
}

// ── uncertainty means POST, never suppress ───────────────────────────────
// A lost comment is worse than a duplicate: a duplicate is noise a person
// reconciles, silence is a ticket nobody knows finished. So an unreadable or
// half-written marker must not be read as "already done".
{
  process.env.JIRA_POST_ENABLED = '1'
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
  process.env.JIRA_EMAIL = 'bot@example.com'
  process.env.JIRA_API_TOKEN = 'bot-token'
  const run = { id: `idem-bad-${Date.now()}`, status: 'completed', error: undefined }
  const dir = join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'jira-comment.json'), '{ this is not json')

  let posts = 0
  const r = await notifyTicketOutcome(watch, 'CSUP-300', run, {}, async () => { posts += 1; return { ok: true, status: 201, text: async () => '' } })
  assert.equal(posts, 1, 'an unreadable marker means post, because suppressing on uncertainty loses the outcome')
  assert.equal(r.posted, true)

  // A marker that records a FAILED post must not suppress the retry either.
  const run2 = { id: `idem-failed-${Date.now()}`, status: 'completed', error: undefined }
  const dir2 = join(process.env.AGENT_RUNS_DIR, run2.id, 'artifacts')
  mkdirSync(dir2, { recursive: true })
  writeFileSync(join(dir2, 'jira-comment.json'), JSON.stringify({ runId: run2.id, ticketKey: 'CSUP-301', posted: false, reason: 'HTTP 503' }))
  let posts2 = 0
  await notifyTicketOutcome(watch, 'CSUP-301', run2, {}, async () => { posts2 += 1; return { ok: true, status: 201, text: async () => '' } })
  assert.equal(posts2, 1, 'a marker saying the post FAILED is a reason to retry, not to skip')
}

console.log('ticketNotifier: all assertions passed')
