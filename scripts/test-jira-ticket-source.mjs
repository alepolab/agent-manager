/**
 * Self-check for server/utils/jiraTicketSource.ts — the Jira-backed
 * TicketSource (B5, half one). Plain asserts, no framework, no network: a
 * fake `fetch` stands in for Jira's REST API throughout.
 *
 *   node scripts/test-jira-ticket-source.mjs
 *
 * The one assertion this file exists to pin down: an auth/HTTP failure must
 * REJECT, never resolve to `[]` — an empty result and a broken call must
 * never be indistinguishable to a caller. See "6. Auth failure" below.
 */
import assert from 'node:assert/strict'

process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
process.env.JIRA_EMAIL = 'bot@example.com'
process.env.JIRA_API_TOKEN = 'test-token'

const { createJiraTicketSource, MAX_PAGES } = await import('../server/utils/jiraTicketSource.ts')

const watch = {
  id: 'w1', name: 'Jira Watch', workflowSlug: 'demo', intervalSeconds: 60,
  enabled: true, maxConcurrentRuns: 2, dailyDispatchCap: 10, autoRun: false,
  query: 'project = CSUP AND status = "To Do"',
}

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok, status, statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

// ── 1. A query returning issues maps every field, including ADF description ─
{
  let receivedBody
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://example.atlassian.net/rest/api/3/search/jql')
    assert.equal(init.method, 'POST')
    assert.match(init.headers.Authorization, /^Basic /)
    receivedBody = JSON.parse(init.body)
    return jsonResponse({
      isLast: true,
      issues: [{
        key: 'CSUP-7435',
        fields: {
          summary: 'Portal 500s on login',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users see a blank page.' }] }],
          },
          updated: '2026-09-01T12:00:00.000Z',
          assignee: { displayName: 'Priya Nair' },
          reporter: { displayName: 'Sam Ortiz' },
        },
      }],
    })
  }

  const src = createJiraTicketSource(fetchImpl)
  const tickets = await src.fetch(watch)

  assert.equal(receivedBody.jql, watch.query, 'the watch\'s own JQL is sent verbatim')
  assert.equal(tickets.length, 1)
  const [t] = tickets
  assert.equal(t.key, 'CSUP-7435')
  assert.equal(t.summary, 'Portal 500s on login')
  assert.equal(t.description, 'Users see a blank page.', 'ADF is flattened to plain text')
  assert.equal(t.updatedAt, Date.parse('2026-09-01T12:00:00.000Z'))
  assert.equal(t.assignee, 'Priya Nair')
  assert.equal(t.reporter, 'Sam Ortiz')
  assert.equal(t.url, 'https://example.atlassian.net/browse/CSUP-7435')
}

// ── 2. An empty result is a real, distinguishable []  ───────────────────────
{
  const src = createJiraTicketSource(async () => jsonResponse({ isLast: true, issues: [] }))
  const tickets = await src.fetch(watch)
  assert.deepEqual(tickets, [], 'zero matches is a legitimate, empty result')
}

// ── 3. Pagination follows nextPageToken across pages ────────────────────────
{
  let call = 0
  const fetchImpl = async (_url, init) => {
    call += 1
    const body = JSON.parse(init.body)
    if (call === 1) {
      assert.equal(body.nextPageToken, undefined, 'first page carries no token')
      return jsonResponse({ isLast: false, nextPageToken: 'page-2', issues: [{ key: 'CSUP-1', fields: { summary: 'one' } }] })
    }
    assert.equal(body.nextPageToken, 'page-2', 'the token from page 1 is sent back for page 2')
    return jsonResponse({ isLast: true, issues: [{ key: 'CSUP-2', fields: { summary: 'two' } }] })
  }
  const src = createJiraTicketSource(fetchImpl)
  const tickets = await src.fetch(watch)
  assert.equal(call, 2)
  assert.deepEqual(tickets.map(t => t.key), ['CSUP-1', 'CSUP-2'])
}

// ── 4. A nextPageToken that never settles is bounded, not infinite ──────────
{
  let call = 0
  const fetchImpl = async () => {
    call += 1
    return jsonResponse({ isLast: false, nextPageToken: `p${call}`, issues: [{ key: `T-${call}`, fields: {} }] })
  }
  const src = createJiraTicketSource(fetchImpl)
  const tickets = await src.fetch(watch)
  assert.equal(call, MAX_PAGES, 'a source that never reports isLast is still bounded by MAX_PAGES')
  assert.equal(tickets.length, MAX_PAGES)
}

// ── 5. An issue missing a key is dropped, not fabricated ────────────────────
{
  const src = createJiraTicketSource(async () => jsonResponse({
    isLast: true,
    issues: [{ key: '', fields: { summary: 'no key' } }, { key: 'CSUP-9', fields: { summary: 'has key' } }],
  }))
  const tickets = await src.fetch(watch)
  assert.deepEqual(tickets.map(t => t.key), ['CSUP-9'])
}

// ── 6. Auth failure REJECTS — never silently resolves to [] ────────────────
// This is the exact defect shape the task calls out: an empty list and a
// failed call must never be indistinguishable.
{
  const fetchImpl = async () => jsonResponse(
    { errorMessages: ['You do not have permission to access this resource.'] },
    { ok: false, status: 401, statusText: 'Unauthorized' },
  )
  const src = createJiraTicketSource(fetchImpl)
  await assert.rejects(
    () => src.fetch(watch),
    (err) => {
      assert.match(err.message, /401/)
      return true
    },
    'an auth failure must reject the promise, not resolve to an empty array',
  )
}

// ── 7. Missing credentials fail clearly, naming the exact env var ───────────
{
  const savedToken = process.env.JIRA_API_TOKEN
  delete process.env.JIRA_API_TOKEN
  try {
    const src = createJiraTicketSource(async () => jsonResponse({ isLast: true, issues: [] }))
    await assert.rejects(
      () => src.fetch(watch),
      (err) => {
        assert.match(err.message, /JIRA_API_TOKEN/)
        return true
      },
      'a missing credential must name itself, not degrade to an empty result',
    )
  } finally {
    process.env.JIRA_API_TOKEN = savedToken
  }
}

// ── 8. A watch with no JQL configured is a config error, not "0 matches" ────
{
  const noQueryWatch = { ...watch, query: undefined }
  const src = createJiraTicketSource(async () => jsonResponse({ isLast: true, issues: [] }))
  await assert.rejects(() => src.fetch(noQueryWatch), /no JQL query configured/)
}

console.log('jiraTicketSource: all assertions passed')
