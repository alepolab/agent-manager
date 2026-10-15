// A run's audit trail: every action a person takes appends one line, in order,
// and never rewrites what is already there.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'audit-'))
const A = await import('../server/utils/runArtifacts.ts')

const read = id => readFileSync(join(A.runArtifactsDir(id), A.RUN_AUDIT_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l))

// A run whose artifacts directory does not exist yet still gets its first line.
await A.appendRunAudit('run-1', { type: 'approve', actor: 'dev1', stepId: 's4', text: 'design looks right' })
await A.appendRunAudit('run-1', { type: 'answer', actor: 'dev2', stepId: 's5', text: 'use the v2 endpoint' })
let lines = read('run-1')
assert.equal(lines.length, 2, 'one line per action')
assert.deepEqual(lines.map(l => [l.type, l.actor, l.stepId]), [['approve', 'dev1', 's4'], ['answer', 'dev2', 's5']], 'in the order they happened, with who did them')
assert.ok(!Number.isNaN(Date.parse(lines[0].ts)), 'each line is timestamped')

// Actions landing together all survive.
await Promise.all(['note', 'stop', 'dismiss'].map(type => A.appendRunAudit('run-1', { type, actor: 'dev3' })))
lines = read('run-1')
assert.equal(lines.length, 5, 'concurrent appends do not overwrite each other')

// A text with newlines stays one line.
await A.appendRunAudit('run-2', { type: 'note', text: 'first\nsecond' })
assert.equal(read('run-2')[0].text, 'first\nsecond')
assert.equal(readFileSync(join(A.runArtifactsDir('run-2'), A.RUN_AUDIT_FILE), 'utf8').split('\n').length, 2, 'a multi-line note is still a single record')

// ── acting on someone else's run says so, in as many words ──
{
  const { mkdtempSync: mk } = await import('node:fs')
  process.env.CLAUDE_DIR = mk(join(tmpdir(), 'audit-claude-'))
  const H = await import('../server/utils/hierarchy.ts')
  await H.setPlacement('carol', { level: 3 })
  await H.setPlacement('bob', { level: 2, lead: 'carol' })
  await H.setPlacement('alice', { level: 1, lead: 'bob' })

  assert.equal(await H.actingFor('alice', 'alice'), null, 'your own run is not on anyone\'s behalf')
  assert.equal(await H.actingFor('alice', undefined), null, 'nor is a run nobody started')
  assert.deepEqual(await H.actingFor('bob', 'alice'), { onBehalfOf: 'alice', authority: 'lead' })
  assert.deepEqual(await H.actingFor('carol', 'alice'), { onBehalfOf: 'alice', authority: 'lead' }, 'a lead at any distance')
  assert.deepEqual(await H.actingFor('ops', 'alice'), { onBehalfOf: 'alice', authority: 'role' }, 'anyone else acts by role')

  // The wording a reviewer reads, pinned for every action type.
  assert.equal(A.onBehalfLine({ type: 'stop', actor: 'bob', onBehalfOf: 'alice', authority: 'lead' }),
    "@bob stopped the run on @alice's behalf, as @alice's lead")
  assert.equal(A.onBehalfLine({ type: 'approve', actor: 'ops', onBehalfOf: 'alice', authority: 'role', role: 'operator' }),
    "@ops approved at the gate on @alice's behalf, by role (operator)")
  for (const type of ['approve', 'answer', 'note', 'restart', 'stop', 'dismiss', 'review', 'reject', 'rework']) {
    assert.match(A.onBehalfLine({ type, actor: 'bob', onBehalfOf: 'alice', authority: 'lead' }), /^@bob \w.* on @alice's behalf, as @alice's lead$/, `${type} has a line`)
  }
  assert.equal(A.onBehalfLine({ type: 'stop', actor: 'alice' }), undefined, 'no line for one\'s own run')

  // Written into the trail with the fields, and absent for one's own action.
  await A.appendRunAudit('run-3', { type: 'rework', actor: 'bob', onBehalfOf: 'alice', authority: 'lead', stepId: 's2', text: 'tests miss the null case' })
  await A.appendRunAudit('run-3', { type: 'note', actor: 'alice', text: 'on it' })
  const [lead, own] = read('run-3')
  assert.equal(lead.line, "@bob sent the work back on @alice's behalf, as @alice's lead")
  assert.equal(lead.onBehalfOf, 'alice')
  assert.equal(lead.authority, 'lead')
  assert.ok(!('line' in own) && !('onBehalfOf' in own), 'an action on one\'s own run carries no behalf line')
}

// ── every route that writes the trail names the actor through auditActor ──
// Hand-writing `actor:` is how an action on someone else's run would land with
// no behalf line: the helper is the only place that asks whose run it is.
{
  const { readdirSync } = await import('node:fs')
  const dir = join(import.meta.dirname, '..', 'server', 'api', 'runs', '[id]')
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, f), 'utf8')
    if (!src.includes('appendRunAudit(')) continue
    assert.match(src, /auditActor\(event\)/, `${f} writes the audit trail without auditActor`)
    assert.doesNotMatch(src, /appendRunAudit\([^)]*\bactor:/, `${f} names the actor by hand`)
  }
  for (const f of ['reject.post.ts', 'rework.post.ts']) {
    assert.match(readFileSync(join(dir, f), 'utf8'), /appendRunAudit\(id, \{ type: '(reject|rework)'/, `${f} is on the trail`)
  }
}

console.log('run audit: all checks passed')
