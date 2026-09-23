/**
 * Self-check for a step's declared `produces`: the runner, not the monitor,
 * decides whether the files a step owes were written.
 *
 *   node scripts/test-produces-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── A provisioner's skip is held to intake's stack_required ───────────────
// Same mechanism as a missing file: the runner, not the monitor, refuses a
// skip meta.json does not permit and sends the step back to stand the stack up.
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const stackFlow = {
  slug: 'stack-gate', name: 'Stack gate',
  steps: [
    { id: 'p', agentSlug: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['t'], maxVisits: 2 },
    { id: 't', agentSlug: 'agent-t', label: 'Test', next: [] },
  ],
}
writeFileSync(join(CLAUDE_DIR, 'workflows', 'stack-gate.json'), JSON.stringify(stackFlow, null, 2))

/** Intake's keys are merged into the seeded meta.json on the first visit; the provisioner answers with `prov(visit)`. */
async function stackRun(intake, prov) {
  const inputs = []
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug !== 'sdlc-stack-provisioner') return 'test done'
    inputs.push(input)
    if (inputs.length === 1) {
      const metaPath = join(dirOf(input), 'meta.json')
      writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf8')), ...intake }))
    }
    return prov(inputs.length)
  })
  const started = await runner.startRun({ workflow: stackFlow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  return { run: await runner.waitForSettled(started.id, TIMEOUT), inputs }
}
const skipOnce = visit => visit === 1 ? 'cloned; unit test covers it\nPIPELINE-SKIP: no stack needed' : 'stack up, healthy'

// 5. Intake said no stack: the skip stands and the run moves on.
r = await stackRun({ stack_required: false, stack_reason: 'unit test of the parser', blast_radius: 'ui_parsing' }, skipOnce)
assert.equal(r.run.status, 'completed')
assert.equal(r.inputs.length, 1, 'a permitted skip is not sent back')
assert.equal(r.run.steps.find(s => s.stepId === 'p').status, 'skipped')

// 6. Intake said a stack is needed: the skip is refused, the retry says why, the second visit stands it up.
r = await stackRun({ stack_required: true, stack_reason: 'needs the URM login', blast_radius: 'ui_parsing' }, skipOnce)
assert.equal(r.run.status, 'completed')
assert.equal(r.inputs.length, 2, 'a refused skip goes back to the provisioner')
assert.match(r.inputs[1], /Stack skip refused: intake recorded stack_required: true \(needs the URM login\)/)
const p = r.run.steps.find(s => s.stepId === 'p')
assert.equal(p.status, 'completed', 'the second visit did the work')
assert.equal(p.skipReason, undefined, 'the refused skip does not linger on the record')

// 7. A forced blast radius overrules intake's false.
r = await stackRun({ stack_required: false, blast_radius: 'money' }, skipOnce)
assert.equal(r.inputs.length, 2)
assert.match(r.inputs[1], /blast_radius is money/)

// 8. No stack_required at all, and the provisioner keeps skipping: the step fails once its visits are spent.
r = await stackRun({ blast_radius: 'docs' }, () => 'nothing to stand up\nPIPELINE-SKIP: no stack needed')
assert.equal(r.run.status, 'failed')
assert.match(r.run.steps.find(s => s.stepId === 'p').error, /no stack_required.*no visits left/)
assert.notEqual(r.run.steps.find(s => s.stepId === 't').status, 'completed', 'nothing downstream runs on a refused skip')

console.log('OK  produces check: present, retried, exhausted, skipped; stack skip gate: permitted, refused, forced, exhausted')
