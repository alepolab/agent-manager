// The alepo-mcp gateway: an MCP client talks to the real McpServer over an
// in-memory transport, Jira and Confluence are a fake fetch, and every claim
// below is checked against the audit log the gateway writes. Nothing here
// reaches the network.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'mcp-gateway-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'mcp-gateway-runs-'))
process.env.AGENT_USERS_DIR = mkdtempSync(join(tmpdir(), 'mcp-gateway-users-'))
process.env.AGENT_MANAGER_URL = 'https://am.alepo.test'
process.env.JIRA_BASE_URL = 'https://jira.test'
process.env.JIRA_EMAIL = 'dev@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
process.env.ALEPO_MCP_JIRA_PROJECTS = 'SA, ASECRM'
delete process.env.JIRA_POST_ENABLED
delete process.env.ALEPO_MCP_CONFLUENCE_SPACES
delete process.env.CONFLUENCE_BASE_URL

const { createGateway, checkJql, checkEvidenceUrl, validateEvidenceBundle, DEFAULT_CONFLUENCE_SPACES } = await import('../server/utils/mcpGateway.ts')
const { readMcpAudit, mcpAuditSink } = await import('../server/utils/mcpAudit.ts')
const { createRun } = await import('../server/utils/workflowRunStore.ts')
const { listEnvLocks } = await import('../server/utils/envLocks.ts')

// ── Fake Atlassian ───────────────────────────────────────────────────────────
const calls = []
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const transitions = {
  transitions: [
    { id: '11', name: 'Start progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    {
      id: '21', name: 'Ready For QA', to: { name: 'READY FOR QA', statusCategory: { key: 'indeterminate' } },
      fields: {
        customfield_1: { name: 'Unit Tests Passed', schema: { type: 'option' }, allowedValues: [{ value: 'Yes' }, { value: 'No' }] },
        customfield_2: { name: 'CI Release Details', schema: { type: 'string' } },
      },
    },
  ],
}
const fakeFetch = async (url, init = {}) => {
  const u = String(url)
  const method = init.method ?? 'GET'
  calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined })
  assert.ok(init.headers?.Authorization?.startsWith('Basic '), 'every Atlassian call carries the instance credentials')
  if (u.startsWith('https://jira.test/rest/api/3/issue/SA-1406/transitions') && method === 'GET') return json(transitions)
  if (u.startsWith('https://jira.test/rest/api/3/issue/SA-1406/transitions') && method === 'POST') return new Response(null, { status: 204 })
  if (u.startsWith('https://jira.test/rest/api/3/issue/SA-1406')) {
    return json({ key: 'SA-1406', fields: { summary: 'Sy interface', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Spending limits over Sy.' }] }] }, labels: ['pcrf'] } })
  }
  if (u === 'https://jira.test/rest/api/3/search/jql') return json({ issues: [{ key: 'SA-1', fields: { summary: 'one' } }], isLast: true })
  if (u.startsWith('https://jira.test/wiki/rest/api/content/search')) return json({ results: [{ id: '42', title: 'Roaming', type: 'page', space: { key: 'RDPR' }, _links: { webui: '/x' } }] })
  if (u.startsWith('https://jira.test/wiki/rest/api/content/42')) return json({ id: '42', title: 'Roaming', space: { key: 'RDPR' }, body: { storage: { value: '<p>Hello <b>there</b></p>' } }, version: { number: 3 }, _links: { webui: '/x' } })
  if (u.startsWith('https://jira.test/wiki/rest/api/content/99')) return json({ id: '99', title: 'HR salaries', space: { key: 'HR' }, body: { storage: { value: '<p>secret</p>' } } })
  return json({ errorMessages: [`unexpected ${method} ${u}`] }, 500)
}

// ── A client against the real server ─────────────────────────────────────────
let clock = Date.parse('2026-10-17T10:00:00Z')
/** Every callTool the suite makes, through any client, so the audit count below is exact rather than a floor. */
let toolCallsMade = 0
const countingCallTool = (c) => { const orig = c.callTool.bind(c); c.callTool = (p) => { toolCallsMade++; return orig(p) }; return c }
async function connect(caller = { login: 'sandeep', via: 'test' }) {
  const server = createGateway({ caller, fetchImpl: fakeFetch, now: () => clock })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(a)
  return countingCallTool(client)
}
const client = await connect()
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const text = r.content?.[0]?.text ?? ''
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { ok: !r.isError, value, text }
}

// 1. The catalogue is what the brief asked for.
const tools = (await client.listTools()).tools.map(t => t.name).sort()
assert.deepEqual(tools, [
  'confluence.get_page', 'confluence.search', 'env.release_lock', 'env.request_lock', 'evidence.put',
  'jira.get_issue', 'jira.search', 'jira.transition_with_evidence', 'registry.product', 'registry.products', 'registry.resolve',
])
const resources = (await client.listResources()).resources.map(r => r.uri)
assert.ok(resources.includes('alepo://registry/products'), resources.join(','))
const templates = (await client.listResourceTemplates()).resourceTemplates.map(r => r.uriTemplate)
assert.ok(templates.includes('alepo://ticket/{key}/context'), templates.join(','))

// 2. JQL allowlist: an out-of-list project is refused before any request leaves.
const allowed = ['SA', 'ASECRM']
assert.equal(checkJql('project = SA AND status = Open', allowed).ok, true)
assert.equal(checkJql('project in (SA, ASECRM) order by created', allowed).ok, true)
assert.equal(checkJql('project = "SA"', allowed).ok, true)
assert.match(checkJql('project = HR', allowed).reason, /HR is not in the allowlist/)
assert.match(checkJql('status = Open', allowed).reason, /must name a project/)
assert.match(checkJql('project = SA OR assignee = me', allowed).reason, /OR at the top level/)
assert.match(checkJql('project != SA', allowed).reason, /negated/)
assert.equal(checkJql('project = SA AND (labels = a OR labels = b)', allowed).ok, true)

calls.length = 0
const refusedSearch = await call('jira.search', { jql: 'project = HR AND status = Open' })
assert.equal(refusedSearch.ok, false)
assert.match(refusedSearch.text, /HR is not in the allowlist/)
assert.equal(calls.length, 0, 'nothing left the process for a refused query')

const search = await call('jira.search', { jql: 'project = SA AND status = Open', maxResults: 5 })
assert.equal(search.ok, true, search.text)
assert.equal(calls.length, 1)
assert.equal(calls[0].body.jql, 'project in (SA, ASECRM) AND (project = SA AND status = Open)', 'the query is wrapped in the allowlist even after it passed the check')
assert.equal(calls[0].body.maxResults, 5)
assert.equal(search.value.issues[0].key, 'SA-1')

// maxResults above the cap is refused by the schema, not clamped silently.
const tooMany = await call('jira.search', { jql: 'project = SA', maxResults: 500 })
assert.equal(tooMany.ok, false)

// 3. get_issue: plain-text description, project allowlist applies here too.
const issue = await call('jira.get_issue', { key: 'sa-1406' })
assert.equal(issue.ok, true, issue.text)
assert.equal(issue.value.key, 'SA-1406')
assert.equal(issue.value.description, 'Spending limits over Sy.')
assert.equal(issue.value.url, 'https://jira.test/browse/SA-1406')
assert.match((await call('jira.get_issue', { key: 'HR-1' })).text, /HR is not in the allowlist/)

// 4. The one write refuses evidence that is not https under this host or an attached artifact.
assert.match(checkEvidenceUrl('http://am.alepo.test/runs/1').reason, /must be https/)
assert.match(checkEvidenceUrl('https://jira.test/browse/SA-1406').reason, /must be under this instance/)
assert.match(checkEvidenceUrl('not a url').reason, /not a URL/)
assert.match(checkEvidenceUrl('artifact:nope/bundle.json').reason, /no artifact/)
assert.equal(checkEvidenceUrl('https://am.alepo.test/api/runs/abc/artifacts/bundle.json').ok, true)
// Development instances are http://localhost; only then is http accepted, and only for that host.
assert.equal(checkEvidenceUrl('http://localhost:3030/runs/1', 'http://localhost:3030').ok, true)
assert.match(checkEvidenceUrl('http://evil.test/runs/1', 'http://localhost:3030').reason, /must be under this instance/)

calls.length = 0
const badEvidence = await call('jira.transition_with_evidence', { key: 'SA-1406', transition: 'Ready for QA', evidenceUrl: 'http://am.alepo.test/runs/1' })
assert.equal(badEvidence.ok, false)
assert.match(badEvidence.text, /must be https/)
assert.equal(calls.length, 0, 'a refused transition makes no Jira request at all')

// Posting off: resolves the transition and the gate fields, reports, does not POST.
calls.length = 0
const dry = await call('jira.transition_with_evidence', {
  key: 'SA-1406', transition: 'Ready for QA', evidenceUrl: 'https://am.alepo.test/runs/abc',
  fields: { 'Unit Tests Passed': true, 'CI Release Details': 'https://am.alepo.test/runs/abc', 'Not A Field': 'x' },
})
assert.equal(dry.ok, true, dry.text)
assert.equal(dry.value.posted, false)
assert.match(dry.value.detail, /JIRA_POST_ENABLED/)
assert.deepEqual(dry.value.gateFields, { 'Unit Tests Passed': 'Yes' }, 'which Yes/No gate fields would be set is recorded')
assert.match(dry.value.skipped[0], /"Not A Field" is not on the/)
assert.deepEqual(calls.map(c => c.method), ['GET'], 'one read, no write')

// Posting on: the POST carries the transition id and the Yes option as Jira wants it.
process.env.JIRA_POST_ENABLED = '1'
calls.length = 0
const moved = await call('jira.transition_with_evidence', {
  key: 'SA-1406', transition: 'Ready for QA', evidenceUrl: 'https://am.alepo.test/runs/abc', fields: { 'Unit Tests Passed': 'yes' },
})
assert.equal(moved.ok, true, moved.text)
assert.equal(moved.value.moved, true)
assert.equal(moved.value.to, 'READY FOR QA')
assert.deepEqual(moved.value.gateFields, { 'Unit Tests Passed': 'Yes' })
const post = calls.find(c => c.method === 'POST')
assert.deepEqual(post.body, { transition: { id: '21' }, fields: { customfield_1: { value: 'Yes' } } })
delete process.env.JIRA_POST_ENABLED

// A role that cannot answer a gate cannot move a ticket through the gateway either.
const manager = await connect({ login: 'reader', via: 'test', capabilities: { answerGate: false, runEngine: false, startRun: false, configure: false, readAllRuns: true } })
const asManager = await manager.callTool({ name: 'jira.transition_with_evidence', arguments: { key: 'SA-1406', transition: 'Ready for QA', evidenceUrl: 'https://am.alepo.test/runs/abc' } })
assert.equal(asManager.isError, true)
assert.match(asManager.content[0].text, /your role cannot do this/)
const asManagerRead = await manager.callTool({ name: 'jira.get_issue', arguments: { key: 'SA-1406' } })
assert.equal(asManagerRead.isError ?? false, false, 'reads need no capability')

// 5. Confluence: the default spaces, wrapped into the CQL; a page outside them is refused after the read.
assert.deepEqual(DEFAULT_CONFLUENCE_SPACES, ['RDPR', 'QAP', 'RDP', 'RD', 'RNDM', 'ASE13', 'AMS', 'ACSDOC', 'PMS', 'PPC', 'FFM'])
calls.length = 0
const cql = await call('confluence.search', { cql: 'text ~ "roaming"' })
assert.equal(cql.ok, true, cql.text)
assert.match(decodeURIComponent(calls[0].url), /cql=space in \(RDPR, QAP, RDP, RD, RNDM, ASE13, AMS, ACSDOC, PMS, PPC, FFM\) AND \(text ~ "roaming"\)/)
assert.equal(cql.value.results[0].space, 'RDPR')
assert.match((await call('confluence.search', { cql: 'space = HR AND text ~ "pay"' })).text, /HR is not in the allowlist/)
const page = await call('confluence.get_page', { id: '42' })
assert.equal(page.ok, true, page.text)
assert.equal(page.value.body, 'Hello there')
const hrPage = await call('confluence.get_page', { id: '99' })
assert.equal(hrPage.ok, false)
assert.match(hrPage.text, /HR is not in the allowlist/)
assert.ok(!hrPage.text.includes('secret'), 'the refused page body is not echoed')

// 6. Registry, from the shipped products.yaml seeded into the store.
const products = await call('registry.products')
assert.equal(products.ok, true, products.text)
assert.ok(products.value.products.length > 5)
const crm = products.value.products.find(p => p.id === 'ase-crm')
assert.ok(crm && crm.projects.includes('ASECRM'), JSON.stringify(crm))
const one = await call('registry.product', { id: 'ase-crm' })
assert.equal(one.ok, true, one.text)
assert.equal(one.value.name, 'ase-crm')
const resolved = await call('registry.resolve', { issueKey: 'ASECRM-222' })
assert.equal(resolved.value.resolved, true)
assert.equal(resolved.value.product.name, 'ase-crm')
const byProject = await call('registry.resolve', { project: 'ASECRM' })
assert.equal(byProject.value.product?.name, 'ase-crm')
assert.equal((await call('registry.resolve', { issueKey: 'NOPE-1' })).value.resolved, false)
const reg = await client.readResource({ uri: 'alepo://registry/products' })
assert.ok(JSON.parse(reg.contents[0].text).products['ase-crm'])

// 7. Environment locks: single holder, token works once, expiry frees the host.
const lock = await call('env.request_lock', { host: 'lab-pcrf-01', reason: 'deploy SA-1406 fix', ttlMinutes: 30 })
assert.equal(lock.ok, true, lock.text)
assert.match(lock.value.ALEPO_ENV_LOCK_TOKEN, /^[0-9a-f]{64}$/)
assert.equal(lock.value.expiresAt, new Date(clock + 30 * 60_000).toISOString())
const other = await connect({ login: 'arisht', via: 'test' })
const refusedLock = await other.callTool({ name: 'env.request_lock', arguments: { host: 'LAB-PCRF-01', reason: 'also deploy' } })
assert.equal(refusedLock.isError, true)
assert.match(refusedLock.content[0].text, /locked by sandeep until/)
const tooLong = await call('env.request_lock', { host: 'lab-x', reason: 'r', ttlMinutes: 241 })
assert.equal(tooLong.ok, false, 'ttl above 240 is refused')
assert.ok(existsSync(join(process.env.CLAUDE_DIR, 'env-locks.json')), 'the lock store is under CLAUDE_DIR')
assert.equal((await listEnvLocks(clock)).length, 1)
// The holder renews rather than being refused.
const renewed = await call('env.request_lock', { host: 'lab-pcrf-01', reason: 'still deploying', ttlMinutes: 10 })
assert.equal(renewed.ok, true, renewed.text)
assert.notEqual(renewed.value.ALEPO_ENV_LOCK_TOKEN, lock.value.ALEPO_ENV_LOCK_TOKEN)
// The old token no longer releases anything; the new one does.
assert.equal((await call('env.release_lock', { token: lock.value.ALEPO_ENV_LOCK_TOKEN })).value.released, false)
assert.equal((await call('env.release_lock', { token: renewed.value.ALEPO_ENV_LOCK_TOKEN })).value.released, true)
assert.equal((await listEnvLocks(clock)).length, 0)
// Expiry: a 5-minute lock, then the clock moves 6 minutes, and the other requester gets in.
const short = await call('env.request_lock', { host: 'lab-pcrf-01', reason: 'quick check', ttlMinutes: 5 })
assert.equal(short.ok, true)
clock += 6 * 60_000
const afterExpiry = await other.callTool({ name: 'env.request_lock', arguments: { host: 'lab-pcrf-01', reason: 'my turn' } })
assert.equal(afterExpiry.isError ?? false, false, afterExpiry.content[0].text)
assert.equal((await listEnvLocks(clock))[0].requester, 'arisht')

// 8. evidence.put: rejects an invalid bundle with the reasons, stores a valid one with its hash.
const run = await createRun({ workflowSlug: 'runbook-a', workflowName: 'Runbook A', autoRun: true, initialPrompt: 'x', watch: 'direct-invocation', ticketKey: 'SA-1406', steps: [{ stepId: 's1', label: 'one', agentSlug: 'a' }] })
const invalid = await call('evidence.put', { runId: run.id, bundle: { ticket: 'SA-1406', summary_md: 'nope' } })
assert.equal(invalid.ok, false)
assert.match(invalid.text, /missing required key "oracle"/)
assert.ok(!existsSync(join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts', 'bundle.json')), 'nothing stored for an invalid bundle')
assert.equal((await call('evidence.put', { runId: 'no-such-run', bundle: {} })).ok, false)

// A bundle the shipped validator accepts is accepted here too, and stored with its hash.
// The fixture is the same complete bundle engineering/scripts/test-validate-bundle.mjs
// starts from, retargeted at this run's ticket.
const bundle = {
  ticket: 'SA-1406', watch: 'direct-invocation', work_type: 'bug', class: 'parsing', product: 'pcrf', blast_radius: 'ui_parsing',
  identity: 'agent-sdlc-01', context_packet_hash: `sha256:${'a'.repeat(64)}`, intent_sha: 'abc1234', spec_sha: null, plan_sha: 'def5678',
  model: 'claude-sonnet-4-5', plugin_version: '0.1.0',
  stack: { profile: 'pcrf-min', topology: 'single-node', liquibase_tag: null },
  oracle: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3, verdict: 'FAIL', xunit: null },
  fix: { repos: [{ repo: 'alepolab/pcrf', commits: ['abcdef1'], pr: 'https://github.com/alepolab/pcrf/pull/42' }], files_changed: 3, lines_changed: 42, test_dirs_unlocked: false, unlock_reason: null },
  oracle_after: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3, verdict: 'PASS', xunit: null },
  regression: { suite: 'full', passed: 120, failed: 0, xunit: null },
  trace: null, adversarial: null,
  cost: { input_tokens: 12000, output_tokens: 3000, attempts: 1, wall_clock_min: 14.5 },
  summary_md: '# SA-1406\n\nWhat broke, what changed, what proves it.',
}
const checked = validateEvidenceBundle(bundle)
assert.ok(checked.version, 'a schema is shipped')
assert.deepEqual(checked.problems, [], checked.problems.join('\n'))
const { validateBundle } = await import('../engineering/scripts/validate-bundle.mjs')
assert.deepEqual(validateBundle(bundle), [], 'the shipped validator agrees')
// And both refuse the same broken bundle for the same schema reason.
const brokenBundle = { ...bundle, oracle: { ...bundle.oracle, kind: 'unit' } }
assert.ok(validateEvidenceBundle(brokenBundle).problems.some(p => /oracle\.kind/.test(p)))
assert.ok(validateBundle(brokenBundle).some(p => /oracle\.kind/.test(p)))

const stored = await call('evidence.put', { runId: run.id, bundle })
assert.equal(stored.ok, true, stored.text)
assert.equal(stored.value.url, `https://am.alepo.test/api/runs/${run.id}/artifacts/bundle.json`)
assert.equal(stored.value.schemaVersion, checked.version)
const onDisk = readFileSync(join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts', 'bundle.json'))
const { createHash } = await import('node:crypto')
assert.equal(stored.value.sha256, createHash('sha256').update(onDisk).digest('hex'))
assert.equal(JSON.parse(onDisk.toString()).ticket, 'SA-1406')
// A bundle for another ticket cannot be attached to this run.
assert.match((await call('evidence.put', { runId: run.id, bundle: { ...bundle, ticket: 'SA-9' } })).text, /bundle.ticket is SA-9 but run/)

// 9. The ticket context resource reads the run store.
const ctx = await client.readResource({ uri: 'alepo://ticket/SA-1406/context' })
assert.match(ctx.contents[0].text, new RegExp(`Ticket SA-1406: latest run ${run.id}`))
assert.match(ctx.contents[0].text, /Run page: https:\/\/am\.alepo\.test\/runs\//)
assert.match((await client.readResource({ uri: 'alepo://ticket/NOPE-1/context' })).contents[0].text, /No run recorded for NOPE-1/)

// 10. Every call above wrote an audit line, successes and refusals alike, with the actor and no secrets.
const audit = await readMcpAudit()
const sink = await mcpAuditSink()
const toolCalls = audit.filter(a => !a.ref.startsWith('resource:'))
const resourceReads = audit.filter(a => a.ref.startsWith('resource:'))
// Two fewer than were made: `maxResults: 500` and `ttlMinutes: 241` were
// refused by the input schema inside the SDK and never reached a tool, so there
// was no call to record. Every call that did reach one - success or refusal -
// is here.
assert.equal(toolCalls.length, toolCallsMade - 2, `expected every tool call recorded (${sink} sink): made ${toolCallsMade}`)
assert.ok(resourceReads.length >= 3, `resource reads are recorded too, got ${resourceReads.length}`)
assert.ok(audit.every(a => a.kind === 'mcp-call' && typeof a.ts === 'string' && typeof a.payload.ok === 'boolean'), 'every record has the shape')
assert.ok(audit.some(a => a.ref === 'jira.search' && a.payload.ok === false && /HR is not in the allowlist/.test(a.payload.error)), 'the refused search is in the log with its reason')
assert.ok(audit.some(a => a.ref === 'jira.transition_with_evidence' && a.payload.ok === true && a.payload.gateFields?.['Unit Tests Passed'] === 'Yes'), 'the transition records which gate fields it set')
assert.ok(audit.some(a => a.ref === 'env.request_lock' && a.actor === 'arisht' && a.payload.ok === false && a.payload.heldBy === 'sandeep'), 'the refused lock names who held it')
const serialised = JSON.stringify(audit)
assert.ok(!serialised.includes(lock.value.ALEPO_ENV_LOCK_TOKEN) && !serialised.includes(renewed.value.ALEPO_ENV_LOCK_TOKEN), 'lock tokens never reach the log')
assert.ok(!serialised.includes('not-a-real-token'), 'the Jira token never reaches the log')
assert.ok(audit.filter(a => a.ref === 'evidence.put').every(a => typeof a.payload.args.bundle === 'string'), 'bundles are logged by size, not body')

console.log(`mcp gateway: all checks passed (${audit.length} audit records via the ${sink} sink)`)
