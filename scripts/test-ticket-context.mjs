/**
 * GET /api/v1/tickets/:key/context — the plain-text brief a SessionStart hook
 * pastes into a Claude Code session: the ticket's latest run, where it stands,
 * and what the risk policy asks of its blast radius.
 *
 * Runs are seeded straight into the store (createRun + saveRun), the way
 * test-workflow-run-store.mjs does, and the route is driven through h3 with
 * the API token as a bearer, since that is how the hook will call it.
 *
 *   node scripts/test-ticket-context.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { fetchNodeRequestHandler } from 'node-mock-http'

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, createError: h3.createError, getRouterParam: h3.getRouterParam,
  setResponseHeader: h3.setResponseHeader, setResponseStatus: h3.setResponseStatus,
})

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ticket-context-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'ticket-context-runs-'))
process.env.AUTH_DISABLED = '0'
process.env.AGENT_MANAGER_SECRET = 'test-secret-long-enough-for-the-store-0000'
process.env.AGENT_MANAGER_API_TOKEN = 'api-token-that-is-at-least-thirty-two-chars'
process.env.AGENT_MANAGER_API_LOGIN = 'hook'
process.env.AGENT_MANAGER_URL = 'https://am.example.test/'

const store = await import('../server/utils/workflowRunStore.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const route = (await import('../server/api/v1/tickets/[key]/context.get.ts')).default

const steps = [
  { stepId: 'intake', label: 'Intake', agentSlug: 'agent-a' },
  { stepId: 'ship', label: 'Push + PR', agentSlug: 'agent-b' },
]
const seed = async (overrides) => {
  const run = await store.createRun({ workflowSlug: 'runbook-c', workflowName: 'Runbook C', autoRun: true, initialPrompt: 'go', watch: 'sa-bugs', steps, ...overrides })
  Object.assign(run, overrides)
  await store.saveRun(run)
  return run
}

// An older completed run, then the latest, paused at QA's gate.
const older = await seed({ ticketKey: 'SA-1406', status: 'completed', blastRadius: 'docs', startedAt: Date.now() - 86_400_000, endedAt: Date.now() - 86_000_000 })
const latest = await seed({
  ticketKey: 'SA-1406', status: 'paused', blastRadius: 'money', branch: 'fix/SA-1406', baseBranch: 'develop', startedBy: 'arisht',
  question: { stepId: 'ship', text: 'Approve "Push + PR" to run it.', kind: 'approval', askedAt: Date.now(), role: 'qa' },
})
// A test run of the latest must not shadow it.
await seed({ ticketKey: 'SA-1406', status: 'completed', blastRadius: 'money', testOf: { sourceRunId: latest.id, stepId: 'ship', startPoint: 'abc' }, startedAt: Date.now() + 1000 })

const app = h3.createApp({
  onError: (err, event) => h3.send(event, JSON.stringify({ statusCode: err.statusCode, message: err.message }), 'application/json'),
})
const router = h3.createRouter().get('/api/v1/tickets/:key/context', route)
app.use(router)
const listener = h3.toNodeListener(app)
const get = (key, headers = {}) => fetchNodeRequestHandler(listener, `http://localhost/api/v1/tickets/${key}/context`, { headers })
const bearer = { authorization: 'Bearer api-token-that-is-at-least-thirty-two-chars' }

// ── auth ─────────────────────────────────────────────────────────────────────
assert.equal((await get('SA-1406')).status, 401, 'no bearer, no context')

// ── the latest real run, with its gate and policy row ────────────────────────
{
  const res = await get('SA-1406', bearer)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/plain/)
  const text = await res.text()
  assert.match(text, new RegExp(`latest run ${latest.id}`), 'the newest real run, not the older one')
  assert.doesNotMatch(text, new RegExp(older.id))
  assert.match(text, /Status: paused\./)
  assert.match(text, /Blast radius: money \(oversight: justify\)/)
  assert.match(text, /Branch: fix\/SA-1406 from develop\./)
  assert.match(text, /Waiting for qa at "Push \+ PR" \(approval\): Approve "Push \+ PR" to run it\./)
  assert.match(text, /Evidence bundle: not written yet\./)
  assert.match(text, /Policy for money \(v1\): reviewers 2, specialist money, sandbox required, adversarial required, budget 180 min \/ 8000000 tokens \(panel 600000\)\./)
  assert.match(text, new RegExp(`Run page: https://am\\.example\\.test/runs/${latest.id}`), 'the trailing slash on the base URL is not doubled')
  assert.match(text, /started by arisht, via sa-bugs/)
}

// ── the bundle, once written, is named by path and URL ───────────────────────
{
  mkdirSync(runArtifactsDir(latest.id), { recursive: true })
  writeFileSync(join(runArtifactsDir(latest.id), 'bundle.json'), '{}')
  const text = await (await get('sa-1406', bearer)).text()
  assert.match(text, new RegExp(`Evidence bundle: ${join(runArtifactsDir(latest.id), 'bundle.json').replace(/[\\\\/]/g, '[\\\\/]')}`), 'lower-case key still resolves; the path is on disk')
  assert.match(text, new RegExp(`Evidence bundle URL: https://am\\.example\\.test/api/runs/${latest.id}/artifacts/bundle\\.json`))
}

// ── an unclassified run gets the unclassified row ────────────────────────────
{
  await seed({ ticketKey: 'SA-9', status: 'running', currentStepIds: ['intake'] })
  const text = await (await get('SA-9', bearer)).text()
  assert.match(text, /Blast radius: unclassified \(oversight: stop\)/)
  assert.match(text, /Running: Intake\./)
  assert.match(text, /Policy for unclassified \(v1\): reviewers 1/)
}

// ── no run: 404 with one line ────────────────────────────────────────────────
{
  const res = await get('SA-404', bearer)
  assert.equal(res.status, 404)
  assert.equal(await res.text(), 'No run recorded for SA-404.\n')
  assert.equal((await get('not-a-key', bearer)).status, 400)
}

console.log('ticket context: the latest real run, its gate, its bundle and its policy row; 404 when there is none')
