// The runner fetches the ticket before the intake agent starts, whether the
// operator typed the bare key or a sentence around it, and says WHY when it
// cannot, so no agent is ever left to reach Jira on its own.
import assert from 'node:assert/strict'

const { fetchTicketForPrompt } = await import('../server/utils/jiraTicketSource.ts')
const env = { JIRA_BASE_URL: 'https://jira.test', JIRA_EMAIL: 'dev@example.test', JIRA_API_TOKEN: 'not-a-real-token' }
const issue = { key: 'SCN-402', fields: { summary: 'Selfcare login loops', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users are bounced back to login.' }] }] }, labels: ['selfcare'] } }
const ok = async (url) => new Response(JSON.stringify(issue), { status: 200, headers: { 'content-type': 'application/json' } })

// A key with words around it is still a key.
const withWords = await fetchTicketForPrompt('SCN-402 Selfcare now', env, ok)
assert.equal(withWords.key, 'SCN-402')
assert.match(withWords.text, /Selfcare login loops/, 'the ticket text is fetched')
assert.match(withWords.text, /bounced back to login/)

// A bare key too.
assert.match((await fetchTicketForPrompt('SCN-402', env, ok)).text, /Selfcare login loops/)

// Free text without a key is left alone.
assert.deepEqual(await fetchTicketForPrompt('fix the login loop', env, ok), { text: null })

// A failure names the reason instead of hiding it.
const denied = await fetchTicketForPrompt('SCN-402 Selfcare now', env, async () => new Response('no access', { status: 404 }))
assert.equal(denied.text, null)
assert.match(denied.reason, /HTTP 404/, denied.reason)

const noCreds = await fetchTicketForPrompt('SCN-402', {}, ok)
assert.equal(noCreds.text, null)
assert.ok(noCreds.reason, 'missing credentials are a stated reason')

console.log('ticket for prompt: all checks passed')
