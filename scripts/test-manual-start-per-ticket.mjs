/**
 * A run started by hand for a ticket gets a directory of its own: a second
 * ticket never waits behind the first, and a second start for the same ticket
 * is refused, naming the run in its way.
 *
 * ASECRM-581 and 582 were started after 580 and never appeared: all three had
 * no directory, so all three locked the developer's workspace root, and the
 * last two got a 409 the home page answered by quietly opening 580.
 *
 *   node scripts/test-manual-start-per-ticket.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import * as h3 from 'h3'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'manual-start-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'manual-start-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'manual-start-ws-'))
process.env.AUTH_DISABLED = '1'
delete process.env.JIRA_API_TOKEN
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

// The route uses Nuxt's auto-imports; give it h3's own.
Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError,
  getRouterParam: h3.getRouterParam, getRequestIP: h3.getRequestIP, setResponseHeader: h3.setResponseHeader,
})

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const { claimManualStart, ManualStartRefused } = await import('../server/utils/manualStart.ts')
const { workspaceRootFor } = await import('../server/utils/workspace.ts')
const route = (await import('../server/api/workflows/[slug]/runs.post.ts')).default
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
// Every agent call waits until the end of the test, so each run stays `running`.
let release
const held = new Promise(r => { release = r })
runner.setAgentCaller(async () => { await held; return 'done' })

const wf = { slug: 'runbook', name: 'Runbook', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'Work', next: [] }] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'runbook.json'),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const dev = 'arisht'
const start = async (prompt, stated) => {
  const c = await claimManualStart({ initialPrompt: prompt, stated, login: dev })
  return runner.startRun({ workflow: wf, initialPrompt: prompt, watch: 'direct-invocation', autoRun: true, projectDir: c.projectDir, ticketKey: c.ticketKey, startedBy: dev })
}
const refusedBy = async (prompt, stated) => {
  try {
    await claimManualStart({ initialPrompt: prompt, stated, login: dev })
  } catch (err) {
    assert.ok(err instanceof ManualStartRefused, `refused with a reason, not ${err}`)
    return err
  }
  return null
}

// ── a second ticket does not wait behind the first ──
const a = await start('ASECRM-580')
assert.equal(a.status, 'running')
const blocked = await refusedBy('ASECRM-581 please')
assert.equal(blocked, null, `THE REGRESSION: a second ticket was refused while the first ran: ${blocked?.message}`)
assert.equal(a.projectDir, join(workspaceRootFor(dev), 'ASECRM-580'), 'a ticket started with no directory gets one of its own')
const b = await start('ASECRM-581 please')
assert.equal(b.status, 'running')
assert.notEqual(b.projectDir, a.projectDir)
const c = await start('ASECRM-582')
assert.equal(c.status, 'running', 'and a third')

// ── the same ticket again is refused, naming its run ──
const again = await refusedBy('ASECRM-580')
assert.ok(again, 'a second run on one ticket is refused')
assert.equal(again.runId, a.id, 'naming the run in its way')
assert.match(again.message, /ASECRM-580 already has a run by @arisht/)

// Still refused once that run has moved to its worktree, where its own
// directory no longer names it.
const moved = await store.getRun(a.id)
await store.saveRun({ ...moved, projectDir: '/somewhere/ase-crm@fix-ASECRM-580-abcdef01', branch: 'fix/ASECRM-580-abcdef01' })
assert.equal((await refusedBy('ASECRM-580 again'))?.runId, a.id, 'found by its ticket, not its directory')

// Waiting on a person is still a run on the ticket; an outcome is not.
await store.saveRun({ ...(await store.getRun(a.id)), status: 'paused' })
assert.equal((await refusedBy('ASECRM-580'))?.runId, a.id, 'a run paused at a gate still holds its ticket')
await store.saveRun({ ...(await store.getRun(a.id)), status: 'completed' })
assert.equal(await refusedBy('ASECRM-580'), null, 'a finished one does not')

// ── a stated directory keeps today's lock, ticket or not ──
const dir = mkdtempSync(join(tmpdir(), 'manual-start-checkout-'))
const d = await start('ASECRM-590', dir)
assert.equal(d.projectDir, dir, 'a stated directory is used as stated')
assert.equal((await refusedBy('ASECRM-591', dir))?.runId, d.id, 'a different ticket in the same stated directory is still refused')
assert.equal(await refusedBy('ASECRM-581', mkdtempSync(join(tmpdir(), 'manual-start-other-'))), null,
  'a stated directory of its own is the person\'s call, even for a ticket with a run elsewhere')

// ── no ticket: the developer's workspace root, as before ──
const e = await start('tidy the scripts folder')
assert.equal(e.projectDir ?? workspaceRootFor(dev), workspaceRootFor(dev))
assert.equal((await refusedBy('and the docs folder'))?.runId, e.id, 'two runs with no ticket and no directory still share one root, and the second waits')

// ── through the route: the 409 the UI reads ──
const app = h3.createApp()
app.use('/api/workflows/runbook/runs', h3.eventHandler(ev => { ev.context.params = { slug: 'runbook' }; return route(ev) }))
const server = createServer(h3.toNodeListener(app))
await new Promise(res => server.listen(0, '127.0.0.1', res))
try {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/workflows/runbook/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initialPrompt: 'ASECRM-581', autoRun: true }),
  })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.data?.runId, b.id, 'the route hands the UI the run to open')
} finally {
  server.close()
}

release()
for (const r of [b, c, d, e]) await runner.waitForSettled(r.id, 15000)
console.log('ok - a manual start for a ticket works in its own directory; the same ticket twice is refused')
process.exit(0)
