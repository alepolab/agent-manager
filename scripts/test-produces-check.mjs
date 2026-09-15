/**
 * Self-check for a step's declared `produces`: the runner, not the monitor,
 * decides whether the files a step owes were written.
 *
 *   node scripts/test-produces-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'produces-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'produces-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const { missingArtifacts } = await import('../shared/utils/workflowGraph.ts')

// ── The check itself ──────────────────────────────────────────────────────
assert.deepEqual(missingArtifacts(['a.md', 'b.xml'], { 'a.md': '# A', 'b.xml': '<x/>' }), [], 'every file present')
assert.deepEqual(missingArtifacts(['a.md'], { 'a.md': null }), ['a.md was not written'])
assert.deepEqual(missingArtifacts(['a.md'], {}), ['a.md was not written'], 'a file never read counts as not written')
assert.deepEqual(missingArtifacts(['a.md', 'b.md'], { 'a.md': '  \n', 'b.md': 'ok' }), ['a.md is empty'], 'whitespace is empty')

// ── The runner acting on it ───────────────────────────────────────────────
const TIMEOUT = 5000
const workflow = {
  slug: 'produces', name: 'Produces',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'], produces: ['report.md'], maxVisits: 2 },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ],
}
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'workflows', 'produces.json'), JSON.stringify(workflow, null, 2))

const dirOf = input => input.match(/^Write every artifact you produce into: (.+)$/m)?.[1]

/** Alpha answers with `alpha(visit, input)`; Bravo always succeeds. Returns the settled run and Alpha's inputs. */
async function run(alpha) {
  const inputs = []
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug !== 'agent-a') return 'bravo done'
    inputs.push(input)
    return alpha(inputs.length, input)
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  return { run: await runner.waitForSettled(started.id, TIMEOUT), inputs }
}

// 1. Wrote it the first time: no second visit.
let r = await run((_, input) => { writeFileSync(join(dirOf(input), 'report.md'), '# Report'); return 'done' })
assert.equal(r.run.status, 'completed')
assert.equal(r.inputs.length, 1, 'a step that wrote its file is not sent back')

// 2. Forgot it, wrote it when sent back: the retry names the file.
let dir
r = await run((visit, input) => {
  dir ??= dirOf(input)
  if (visit === 2) writeFileSync(join(dir, 'report.md'), '# Report')
  return 'done'
})
assert.equal(r.run.status, 'completed', 'the second visit wrote the file and the run finished')
assert.equal(r.inputs.length, 2)
assert.match(r.inputs[1], /report\.md was not written/, 'the retry says exactly which file')

// 3. Never writes it: the step fails once its visits are spent, and Bravo never runs.
r = await run(() => 'done')
assert.equal(r.run.status, 'failed')
const alpha = r.run.steps.find(s => s.stepId === 'a')
assert.match(alpha.error, /report\.md was not written.*no visits left/)
assert.notEqual(r.run.steps.find(s => s.stepId === 'b').status, 'completed', 'nothing downstream runs on a missing file')

// 4. A skip owes nothing.
r = await run(() => 'nothing to do here\nPIPELINE-SKIP: the ticket is already fixed')
assert.equal(r.run.status, 'completed')
assert.equal(r.inputs.length, 1, 'a step that skipped itself is not sent back for files')

console.log('OK  produces check: present, retried, exhausted, skipped')
