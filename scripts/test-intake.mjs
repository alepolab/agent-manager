/**
 * The signed webhook intake: refused without a secret, refused with a bad
 * signature, accepted with a good one; idempotent per issue key through the
 * same live-run check manual starts use; `X-Shadow: 1` records and starts
 * nothing.
 *
 *   node scripts/test-intake.mjs
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import * as h3 from 'h3'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'intake-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'intake-runs-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'intake-ws-'))
process.env.CI_POLLER_DISABLED = '1'
delete process.env.JIRA_API_TOKEN
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError,
  getRouterParam: h3.getRouterParam, getRequestHeader: h3.getRequestHeader, setResponseStatus: h3.setResponseStatus,
})

const I = await import('../server/utils/intake.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const { isPublicApiPath } = await import('../server/utils/session.ts')
const route = (await import('../server/api/v1/intake.post.ts')).default

const SECRET = 'a-shared-secret-of-reasonable-length'
const settings = (agentManager) => writeFileSync(join(process.env.CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager }))
const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex')

// ── 1. the pure pieces ────────────────────────────────────────────────────
{
  const body = '{"issueKey":"ABC-1"}'
  assert.equal(I.verifyIntakeSignature(body, sign(body), SECRET), true)
  assert.equal(I.verifyIntakeSignature(body, `sha256=${sign(body)}`, SECRET), true, 'a GitHub-style prefix is accepted')
  assert.equal(I.verifyIntakeSignature(body, sign(body, 'other'), SECRET), false, 'the wrong secret')
  assert.equal(I.verifyIntakeSignature(`${body} `, sign(body), SECRET), false, 'a body changed after signing')
  assert.equal(I.verifyIntakeSignature(body, sign(body).slice(1), SECRET), false, 'a truncated signature')
  assert.equal(I.verifyIntakeSignature(body, 'zz', SECRET), false, 'not hex')
  assert.equal(I.verifyIntakeSignature(body, sign(body), undefined), false, 'no secret configured refuses even a valid-looking signature')
  assert.equal(I.verifyIntakeSignature(body, undefined, SECRET), false)

  assert.deepEqual(I.parseIntake({ issueKey: 'abc-12', reporter: 'sam' }), { payload: { issueKey: 'ABC-12', project: 'ABC', reporter: 'sam' } })
  assert.deepEqual(I.parseIntake({ issueKey: 'ABC-12', project: 'ABC' }), { payload: { issueKey: 'ABC-12', project: 'ABC', reporter: undefined } })
  assert.match(I.parseIntake({ issueKey: 'not a key' }).error, /ABC-123/)
  assert.match(I.parseIntake([]).error, /object/)
  assert.ok(isPublicApiPath('/api/v1/intake'), 'the auth middleware lets the webhook through to its own check')
}

// ── 2. the route over HTTP ────────────────────────────────────────────────
const app = h3.createApp()
const router = h3.createRouter().post('/api/v1/intake', route)
app.use(router)
const server = createServer(h3.toNodeListener(app))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const post = (body, headers = {}) => fetch(`${base}/api/v1/intake`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

try {
  // No secret: refused, whatever is presented.
  {
    const body = JSON.stringify({ issueKey: 'CRM-1' })
    const res = await post(body, { 'x-alepo-signature': sign(body) })
    assert.equal(res.status, 503, 'unconfigured is a refusal, not an open door')
  }

  settings({ intakeSecret: SECRET })

  // Bad or missing signature: 401, nothing recorded.
  {
    const body = JSON.stringify({ issueKey: 'CRM-1' })
    assert.equal((await post(body)).status, 401, 'no signature')
    assert.equal((await post(body, { 'x-alepo-signature': sign(body, 'wrong') })).status, 401, 'wrong secret')
    assert.equal((await post(`${body}\n`, { 'x-alepo-signature': sign(body) })).status, 401, 'signature over a different body')
    assert.equal(await I.readIntake('CRM-1'), null, 'a refused call leaves no record')
  }

  // A good signature with a bad body is a 400, not a start.
  {
    const body = JSON.stringify({ issueKey: 'nope' })
    assert.equal((await post(body, { 'x-alepo-signature': sign(body) })).status, 400)
    const notJson = 'hello'
    assert.equal((await post(notJson, { 'x-alepo-signature': sign(notJson) })).status, 400)
  }

  // Accepted, no intake workflow configured: recorded, nothing starts.
  {
    const body = JSON.stringify({ issueKey: 'CRM-1', project: 'CRM', reporter: 'sam' })
    const res = await post(body, { 'x-alepo-signature': sign(body) })
    assert.equal(res.status, 200)
    const rec = await res.json()
    assert.equal(rec.disposition, 'recorded')
    assert.equal(rec.deliveries, 1)
    assert.equal((await store.listRuns()).length, 0, 'no run started')
    assert.equal((await I.readIntake('CRM-1')).reporter, 'sam')
  }

  // With a workflow: the first delivery starts a run (202), the second is a duplicate of it.
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'intake-wf.json'),
    JSON.stringify({ name: 'Intake', description: '', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'Work', next: [] }], createdAt: new Date().toISOString() }))
  settings({ intakeSecret: SECRET, intakeWorkflow: 'intake-wf' })
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
  let release
  const held = new Promise(r => { release = r })
  runner.setAgentCaller(async () => { await held; return 'done' })
  {
    const body = JSON.stringify({ issueKey: 'CRM-2' })
    const first = await post(body, { 'x-alepo-signature': sign(body) })
    assert.equal(first.status, 202)
    const a = await first.json()
    assert.equal(a.disposition, 'started')
    assert.ok(a.runId)
    const run = await store.getRun(a.runId)
    assert.equal(run.ticketKey, 'CRM-2')
    assert.equal(run.watch, 'intake', 'the run says what triggered it')

    const again = await post(body, { 'x-alepo-signature': sign(body) })
    assert.equal(again.status, 200)
    const b = await again.json()
    assert.equal(b.disposition, 'duplicate', 'a replayed webhook does not start a second run')
    assert.equal(b.runId, a.runId, 'and names the run already working the ticket')
    assert.equal(b.deliveries, 2)
    assert.equal((await store.listRuns()).filter(r => r.ticketKey === 'CRM-2').length, 1)
  }

  // X-Shadow: 1 records and starts nothing, even with a workflow configured.
  {
    const body = JSON.stringify({ issueKey: 'CRM-3' })
    const res = await post(body, { 'x-alepo-signature': sign(body), 'x-shadow': '1' })
    assert.equal(res.status, 200)
    const rec = await res.json()
    assert.equal(rec.disposition, 'shadow')
    assert.equal(rec.runId, undefined)
    assert.equal((await store.listRuns()).some(r => r.ticketKey === 'CRM-3'), false, 'shadow mode starts no run')
    assert.equal((await I.readIntake('CRM-3')).disposition, 'shadow', 'but the intake is on file')
    // A shadowed delivery still needs a valid signature.
    assert.equal((await post(body, { 'x-shadow': '1' })).status, 401)
  }

  release()
} finally {
  server.close()
}

console.log('intake: all assertions passed')
process.exit(0)
