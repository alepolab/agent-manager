/**
 * Two manual starts for one ticket that overlap: the second waits for the
 * first, finds its run, and is refused naming it - for one developer and for
 * two.
 *
 * The route checks for a live run on the ticket, then awaits the Jira fetch,
 * then starts. Without a turn per ticket both starts passed the check while
 * the first was still fetching, and two runs worked one ticket. Two
 * developers never met at all: their directories are under different roots.
 *
 *   node scripts/test-manual-start-overlap.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import * as h3 from 'h3'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'manual-overlap-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'manual-overlap-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'manual-overlap-ws-'))
process.env.AUTH_DISABLED = '1'
// Jira is configured, so the route fetches the ticket - the await the race lived in.
process.env.JIRA_BASE_URL = 'https://jira.example.test'
process.env.JIRA_EMAIL = 'bot@example.test'
process.env.JIRA_API_TOKEN = 'not-a-real-token'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError,
  getRouterParam: h3.getRouterParam, getRequestIP: h3.getRequestIP, setResponseHeader: h3.setResponseHeader,
})

// Jira answers only when the test says so. Everything else goes to the real fetch.
const realFetch = globalThis.fetch
const waiting = []
let arrived = () => {}
let answerAtOnce = false
globalThis.fetch = (url, init) => {
  if (!String(url).startsWith(process.env.JIRA_BASE_URL)) return realFetch(url, init)
  const key = String(url).match(/issue\/([A-Z]+-\d+)/)?.[1] ?? 'X-1'
  const reply = () => new Response(JSON.stringify({ key, fields: { summary: `${key} title`, description: null, labels: [] } }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  if (answerAtOnce) return Promise.resolve(reply())
  return new Promise((resolve) => { waiting.push(() => resolve(reply())); arrived() })
}
const nextArrival = () => new Promise(r => { arrived = r })
const answerAll = () => { answerAtOnce = true; while (waiting.length) waiting.shift()() }

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const route = (await import('../server/api/workflows/[slug]/runs.post.ts')).default
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
let release
const held = new Promise(r => { release = r })
runner.setAgentCaller(async () => { await held; return 'done' })

const wf = { slug: 'runbook', name: 'Runbook', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'Work', next: [] }] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'runbook.json'),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const app = h3.createApp()
app.use('/api/workflows/runbook/runs', h3.eventHandler(ev => { ev.context.params = { slug: 'runbook' }; return route(ev) }))
const server = createServer(h3.toNodeListener(app))
await new Promise(res => server.listen(0, '127.0.0.1', res))
const post = prompt => realFetch(`http://127.0.0.1:${server.address().port}/api/workflows/runbook/runs`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initialPrompt: prompt, autoRun: true }),
}).then(async r => ({ status: r.status, body: await r.json() }))

const liveFor = async key => (await store.listRuns()).filter(r => r.ticketKey === key && ['running', 'queued'].includes(r.status))

/**
 * Starts `key` as `first`, and while that start is held at the Jira fetch,
 * starts it again as `second`. Then lets Jira answer everything.
 */
async function overlap(key, first, second) {
  answerAtOnce = false
  process.env.DEV_USER = first
  const inFetch = nextArrival()
  const one = post(key)
  await inFetch
  process.env.DEV_USER = second
  const two = post(key)
  // Long enough for the second start to reach the Jira fetch, if nothing stops it.
  await new Promise(r => setTimeout(r, 400))
  answerAll()
  return Promise.all([one, two])
}

try {
  // ── one developer, two overlapping starts ──
  {
    const [one, two] = await overlap('ASECRM-700', 'arisht', 'arisht')
    assert.equal(one.status, 200, JSON.stringify(one.body))
    const live = await liveFor('ASECRM-700')
    assert.equal(live.length, 1, `THE REGRESSION: overlapping starts made ${live.length} live runs for one ticket`)
    assert.equal(two.status, 409, 'the second start is refused')
    assert.equal(two.body.data?.runId, one.body.id, 'naming the run that won')
  }

  // ── two developers, the same ticket ──
  {
    const [one, two] = await overlap('ASECRM-701', 'arisht', 'sandeep')
    assert.equal(one.status, 200, JSON.stringify(one.body))
    const live = await liveFor('ASECRM-701')
    assert.equal(live.length, 1, `THE REGRESSION: two developers both started ASECRM-701 (${live.length} live runs)`)
    assert.equal(two.status, 409)
    assert.equal(two.body.data?.runId, one.body.id)
    const winner = (await store.listRuns()).find(r => r.id === one.body.id)
    assert.equal(winner?.startedBy, 'arisht', 'and the run named is the first developer\'s')
  }

  // ── different tickets do not wait on each other ──
  {
    answerAtOnce = false
    process.env.DEV_USER = 'arisht'
    const inFetch = nextArrival()
    const one = post('ASECRM-702')
    await inFetch
    const secondArrived = nextArrival()
    const two = post('ASECRM-703')
    const reached = await Promise.race([secondArrived.then(() => true), new Promise(r => setTimeout(() => r(false), 2000))])
    assert.ok(reached, 'a start for another ticket reaches its own Jira fetch while the first is still held')
    answerAll()
    const [r1, r2] = await Promise.all([one, two])
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
  }

  // ── the turn is given back when a start fails ──
  {
    answerAtOnce = true
    process.env.DEV_USER = 'arisht'
    // A missing workflow is answered before the turn; a refused start inside it is the failure path.
    const refused = await post('ASECRM-700')
    assert.equal(refused.status, 409)
    const after = await Promise.race([post('ASECRM-704'), new Promise(r => setTimeout(() => r('timeout'), 5000))])
    assert.notEqual(after, 'timeout', 'nothing is left holding a turn')
    const again = await Promise.race([post('ASECRM-700'), new Promise(r => setTimeout(() => r('timeout'), 5000))])
    assert.notEqual(again, 'timeout', 'a ticket whose start was refused can be asked about again')
    assert.equal(again.status, 409)
  }
} finally {
  server.close()
  release()
}
console.log('ok - overlapping manual starts for one ticket admit one run, for one developer or two')
process.exit(0)
