/**
 * The hash-chained audit log: append-only JSONL where each record carries the
 * sha256 of the one before it.
 *
 * What makes it worth having is the one property a plain log lacks: a line
 * changed after the fact is detectable, and the detector says where. So the
 * test is three appends, a clean verify, one tampered line, and a verify that
 * names it. The query filter and the tool-use route are checked alongside,
 * since both are how anyone reads the chain back.
 *
 *   node scripts/test-audit-log.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h3 from 'h3'
import { fetchNodeRequestHandler } from 'node-mock-http'

Object.assign(globalThis, {
  defineEventHandler: h3.defineEventHandler, readBody: h3.readBody, createError: h3.createError, getQuery: h3.getQuery,
  setResponseStatus: h3.setResponseStatus,
})

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'audit-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'audit-runs-'))

const audit = await import('../server/utils/auditLog.ts')

// ── canonical JSON ───────────────────────────────────────────────────────────
assert.equal(audit.canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }], c: undefined }), '{"a":[3,{"y":2,"z":1}],"b":1}',
  'keys sorted at every depth, undefined dropped, arrays kept in order')
assert.equal(audit.hashRecord({ seq: 1, a: 'x' }), audit.hashRecord({ a: 'x', seq: 1, hash: 'ignored' }),
  'the hash ignores key order and the hash field itself')

// ── 1. three appends make a chain ────────────────────────────────────────────
assert.equal(audit.auditLogPath(), join(process.env.AGENT_RUNS_DIR, 'audit', 'audit.jsonl'), 'under AGENT_RUNS_DIR when set')

const [r1, r2, r3] = await Promise.all([
  audit.appendAudit({ actor: 'alice', kind: 'decision', ref: 'run-1', payload: { ticket: 'SA-1', verdict: 'approved' } }),
  audit.appendAudit({ actor: 'bob', kind: 'decision', ref: 'run-2', payload: { ticket: 'SA-2', verdict: 'rejected' } }),
  audit.appendAudit({ actor: 'alice', kind: 'roles', ref: 'carol', payload: { role: 'qa' } }),
])
assert.deepEqual([r1.seq, r2.seq, r3.seq], [1, 2, 3], 'concurrent appends are serialised into one sequence')
assert.equal(r1.prevHash, audit.GENESIS_HASH)
assert.equal(r2.prevHash, r1.hash)
assert.equal(r3.prevHash, r2.hash)
assert.match(r1.hash, /^[a-f0-9]{64}$/)

const lines = readFileSync(audit.auditLogPath(), 'utf8').trim().split('\n')
assert.equal(lines.length, 3, 'one line per record')
assert.deepEqual(JSON.parse(lines[2]), r3, 'the file holds exactly what was returned')

assert.deepEqual(await audit.verifyAuditChain(), { ok: true, count: 3 })

// ── 2. query filters ─────────────────────────────────────────────────────────
{
  const byTicket = await audit.queryAudit({ ticket: 'SA-2' })
  assert.equal(byTicket.length, 1)
  assert.equal(byTicket[0].actor, 'bob', 'ticket matches payload.ticket')
  assert.equal((await audit.queryAudit({ ticket: 'carol' })).length, 1, 'or ref')
  assert.equal((await audit.queryAudit({ actor: 'alice' })).length, 2)
  assert.equal((await audit.queryAudit({ actor: 'alice', kind: 'roles' })).length, 1)
  assert.equal((await audit.queryAudit({ limit: 2 })).length, 2)
  assert.equal((await audit.queryAudit({}))[0].seq, 3, 'newest first')
  assert.equal((await audit.queryAudit({ from: new Date(Date.now() + 60_000).toISOString() })).length, 0, 'from in the future finds nothing')
  assert.equal((await audit.queryAudit({ to: Date.now() + 60_000 })).length, 3, 'to accepts epoch ms')
}

// ── 3. tampering is detected and located ─────────────────────────────────────
{
  const tampered = [...lines]
  const second = JSON.parse(tampered[1])
  second.payload.verdict = 'approved' // bob's rejection rewritten as an approval
  tampered[1] = JSON.stringify(second)
  writeFileSync(audit.auditLogPath(), `${tampered.join('\n')}\n`)
  const v = await audit.verifyAuditChain()
  assert.equal(v.ok, false)
  assert.equal(v.brokenAt, 2, 'the edited record is named, not merely "something changed"')
  assert.equal(v.count, 3)
  assert.match(v.reason, /hash does not match/)

  // Re-hashing the edited line to hide the edit breaks the link from the next record instead.
  second.hash = audit.hashRecord(second)
  tampered[1] = JSON.stringify(second)
  writeFileSync(audit.auditLogPath(), `${tampered.join('\n')}\n`)
  const v2 = await audit.verifyAuditChain()
  assert.equal(v2.ok, false)
  assert.equal(v2.brokenAt, 3, 'the record after it no longer chains')
  assert.match(v2.reason, /prevHash/)

  // A deleted line.
  writeFileSync(audit.auditLogPath(), `${[lines[0], lines[2]].join('\n')}\n`)
  const v3 = await audit.verifyAuditChain()
  assert.equal(v3.ok, false)
  assert.equal(v3.brokenAt, 2)

  // Restore, and appending continues the chain from the real tail even though
  // this process cached a different one.
  writeFileSync(audit.auditLogPath(), `${lines.join('\n')}\n`)
  audit.resetAuditCache()
  const r4 = await audit.appendAudit({ actor: 'runner', kind: 'run-end', ref: 'run-1', payload: { ticket: 'SA-1', status: 'completed' } })
  assert.equal(r4.seq, 4)
  assert.equal(r4.prevHash, r3.hash)
  assert.deepEqual(await audit.verifyAuditChain(), { ok: true, count: 4 })
  assert.equal((await audit.queryAudit({ ticket: 'SA-1' })).length, 2, 'ticket filter spans kinds')
}

// ── 4. the tool-use route, as a hook would call it ───────────────────────────
{
  process.env.AUTH_DISABLED = '0'
  process.env.AGENT_MANAGER_SECRET = 'test-secret-long-enough-for-the-store-0000'
  process.env.AGENT_MANAGER_API_TOKEN = 'api-token-that-is-at-least-thirty-two-chars'
  process.env.AGENT_MANAGER_API_LOGIN = 'hook-user'
  const route = (await import('../server/api/v1/audit/tool-use.post.ts')).default
  const app = h3.createApp({
    onError: (err, event) => h3.send(event, JSON.stringify({ statusCode: err.statusCode, message: err.message }), 'application/json'),
  })
  app.use('/api/v1/audit/tool-use', route)
  const listener = h3.toNodeListener(app)
  const post = (body, headers = {}) => fetchNodeRequestHandler(listener, 'http://localhost/api/v1/audit/tool-use', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const bearer = { authorization: 'Bearer api-token-that-is-at-least-thirty-two-chars' }

  const report = { ts: '2026-10-17T09:00:00.000Z', ticket: 'SA-9', session_id: 'sess-1', tool: 'Edit', file: 'src/x.ts', input_sha256: 'a'.repeat(64) }
  const ok = await post(report, bearer)
  const okBody = await ok.json()
  assert.equal(ok.status, 201, JSON.stringify(okBody))
  const { seq, hash } = okBody
  assert.equal(seq, 5)
  const [rec] = await audit.queryAudit({ kind: 'tool-use' })
  assert.equal(rec.hash, hash)
  assert.equal(rec.actor, 'api-token:hook-user', 'a self-reported line is marked as such')
  assert.equal(rec.ref, 'SA-9')
  assert.equal(rec.payload.tool, 'Edit')
  assert.equal(rec.payload.reported_ts, report.ts, 'the hook\'s own time is kept beside the server\'s')

  assert.equal((await post(report)).status, 401, 'no bearer: refused')
  assert.equal((await post({ ticket: 'SA-9' }, bearer)).status, 400, 'a report with no tool is refused')
  assert.equal((await post({ tool: 'Bash', input_sha256: 'nope' }, bearer)).status, 400, 'a malformed digest is refused')
  assert.deepEqual(await audit.verifyAuditChain(), { ok: true, count: 5 }, 'refused reports append nothing')
}

// ── 5. the runner writes run-start and run-end ───────────────────────────────
// Driven through the real runner with a stub agent so the two hooks in
// beginRun and publish() are exercised where they live.
{
  const runner = await import('../server/utils/workflowRunner.ts')
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
  runner.setAgentCaller(async slug => `out ${slug}`)
  const workflow = { slug: 'audited', name: 'Audited', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'Work', next: [] }] }
  const started = await runner.startRun({ workflow, initialPrompt: 'SA-77 go', watch: 'direct-invocation', autoRun: true, startedBy: 'dana' })
  const done = await runner.waitForSettled(started.id, 8000)
  assert.equal(done.status, 'completed')
  // appendAudit is fire-and-forget in the runner; one more append orders after them.
  await audit.appendAudit({ actor: 'test', kind: 'marker', ref: 'x', payload: {} })
  const forRun = (await audit.queryAudit({ ticket: 'SA-77' })).reverse()
  assert.deepEqual(forRun.map(r => r.kind), ['run-start', 'run-end'], 'a run leaves exactly a start and an end')
  assert.equal(forRun[0].actor, 'dana', 'the start is attributed to whoever started it')
  assert.equal(forRun[0].ref, started.id)
  assert.equal(forRun[1].payload.status, 'completed')
  assert.deepEqual((await audit.verifyAuditChain()).ok, true)
}

console.log('audit log: appends chain, tampering is located, queries filter, the hook route appends tool-use, the runner records start and end')
