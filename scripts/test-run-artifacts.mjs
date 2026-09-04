/**
 * Self-check for the run artifacts directory. Everything here is filesystem
 * behaviour under a temp CLAUDE_DIR — no agent calls.
 *
 *   node scripts/test-run-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'artifacts-'))
const A = await import('../server/utils/runArtifacts.ts')

const run = {
  id: 'run-1', workflowSlug: 'runbook-a', status: 'running',
  initialPrompt: 'fix SA-1', startedAt: Date.now(), currentStepIds: [], nextStepIds: [],
  steps: [{ stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake', status: 'pending' }],
}

// 1. init creates the directory and a meta.json holding only runner-owned keys
await A.initRunArtifacts(run, 'Runbook A')
const dir = A.runArtifactsDir(run.id)
assert.ok(existsSync(dir), 'artifacts directory is created')
const seeded = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(seeded.identity, 'runbook-a')
assert.ok('model' in seeded, 'model is seeded')
assert.equal(seeded.cost.input_tokens, 0,
  'token counts stay 0 — the runner does not observe them and must not invent them')
assert.ok(!('ticket' in seeded), 'the runner does not claim agent-owned fields')

// 2. a step artifact records the runner's own account of the step
const rec = {
  stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake',
  status: 'completed', input: 'IN', output: 'OUT', startedAt: 1000, completedAt: 4000,
}
await A.writeStepArtifact(run, rec, 0)
const stepFile = join(dir, 'steps', 'step-01-ticket-intake.json')
assert.ok(existsSync(stepFile), `step artifact written at ${stepFile}`)
const step = JSON.parse(readFileSync(stepFile, 'utf8'))
assert.equal(step.output, 'OUT')
assert.equal(step.agentSlug, 'sdlc-ticket-intake')
assert.equal(step.status, 'completed')

// 3. an agent's merged keys survive finalize; the runner's keys win over them
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
  ticket: 'SA-1203', product: 'ocs_cpp14',
  identity: 'i-promoted-myself',
  cost: { input_tokens: 999999, output_tokens: 999999, attempts: 1, wall_clock_min: 0 },
}))
run.endedAt = run.startedAt + 120000
await A.finalizeRunArtifacts(run)
const final = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(final.ticket, 'SA-1203', 'agent-owned keys survive')
assert.equal(final.identity, 'runbook-a', 'runner-owned keys are re-asserted over the agent')
assert.equal(final.cost.input_tokens, 0, 'a self-reported token count is overwritten, not trusted')
assert.equal(final.cost.wall_clock_min, 2, 'wall clock comes from the runner clock')

// 4. malformed meta.json from an agent must not lose the runner's facts
writeFileSync(join(dir, 'meta.json'), '{ this is not json')
await A.finalizeRunArtifacts(run)
const recovered = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(recovered.identity, 'runbook-a', 'unparseable meta.json is rebuilt from runner facts')

// 5. the header names the directory
const header = A.artifactHeader(dir)
assert.ok(header.includes(dir), 'the header carries the real path')

// 6. a slug with path separators cannot escape the directory
await A.writeStepArtifact(run, { ...rec, agentSlug: '../../etc/passwd' }, 1)
const names = readdirSync(join(dir, 'steps'))
assert.ok(names.every(n => !n.includes('/') && !n.includes('..')),
  'agent slugs are sanitised into the filename, never traversed')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('run artifacts: all checks passed')
