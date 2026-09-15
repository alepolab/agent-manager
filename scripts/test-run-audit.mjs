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

console.log('run audit: all checks passed')
