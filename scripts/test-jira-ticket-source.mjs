/**
 * Self-check for the jira-cli backed TicketSource, with the CLI stubbed.
 *
 *   node scripts/test-jira-ticket-source.mjs
 */
import assert from 'node:assert/strict'

const J = await import('../server/utils/jiraTicketSource.ts')

// ADF flattening keeps the words and the structure a reader needs.
const adf = { type: 'doc', version: 1, content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Issue Description:', marks: [{ type: 'strong' }] }, { type: 'text', text: ' upload fails' }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'JPEG, 2 MB' }] }] }] },
  { type: 'codeBlock', content: [{ type: 'text', text: '{"errorCode":"500"}' }] },
] }
const text = J.adfToText(adf)
assert.match(text, /Issue Description: upload fails\n/, 'paragraph text joined and terminated')
assert.match(text, /- JPEG, 2 MB/, 'list items become bullets')
assert.match(text, /```\n\{"errorCode":"500"\}\n```/, 'code blocks fenced')
assert.equal(J.adfToText('plain'), 'plain', 'a v2 string description passes through')

// The CLI seam: list returns keys, view returns the raw issue.
const calls = []
J.setJiraExec(async (args) => {
  calls.push(args)
  if (args[0] === 'issue' && args[1] === 'list') return 'SCN-402\t2026-04-07 11:03:10\nSCN-401\t2026-04-01 09:00:00\nnot-a-key\tjunk\n'
  if (args[0] === 'issue' && args[1] === 'view') {
    const key = args[2]
    if (key === 'SCN-401') throw new Error('permission denied')
    return JSON.stringify({ key, self: 'https://alepo.atlassian.net/rest/api/3/issue/208311', fields: {
      summary: 'Upload fails with 500', description: adf, labels: ['NEW_WEB_SELFCARE'], updated: '2026-04-07T11:03:10.186+0530' } })
  }
  throw new Error('unexpected ' + args.join(' '))
})

const keys = await J.listKeys('project = SCN AND labels = pipeline')
assert.deepEqual(keys.map(k => k.key), ['SCN-401', 'SCN-402'], 'keys parsed, junk dropped, oldest update first')
assert.deepEqual(calls[0], ['issue', 'list', '-q', 'project = SCN AND labels = pipeline', '--plain', '--no-headers', '--columns', 'key,updated'], 'JQL runs verbatim')

const src = J.createJiraTicketSource()
const refs = await src.fetch({ id: 'w', name: 'w', workflowSlug: 's', intervalSeconds: 60, enabled: true, maxConcurrentRuns: 1, dailyDispatchCap: 5, query: 'project = SCN', autoRun: false })
assert.equal(refs.length, 1, 'a ticket the CLI cannot view is skipped, not fatal')
assert.equal(refs[0].key, 'SCN-402')
assert.match(refs[0].description, /^SCN-402: Upload fails with 500\nURL: https:\/\/alepo\.atlassian\.net\/browse\/SCN-402\nLabels: NEW_WEB_SELFCARE\n\nIssue Description: upload fails/, 'the run prompt carries key, summary, url, labels and text')
assert.deepEqual(await src.fetch({ id: 'w', name: 'w', workflowSlug: 's', intervalSeconds: 60, enabled: true, maxConcurrentRuns: 1, dailyDispatchCap: 5, autoRun: false }), [], 'no query, no tickets')

assert.equal(await J.expandTicketKey('not a key'), null, 'only a bare key is expanded')
assert.match(await J.expandTicketKey('SCN-402'), /^SCN-402: Upload fails/, 'a bare key becomes the ticket text')
J.setJiraExec(async () => { throw new Error('jira: not logged in') })
assert.equal(await J.expandTicketKey('SCN-402'), null, 'a CLI failure leaves the prompt as typed')

console.log('jiraTicketSource: all assertions passed')
