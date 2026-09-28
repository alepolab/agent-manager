/**
 * Self-check for test runs: one step run against a finished run's outputs,
 * on its own branch, with no side effects, kept apart from real runs.
 *
 *   node scripts/test-test-run.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'test-run-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'test-run-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')
const queue = await import('../server/utils/runQueue.ts')
const { isTestRun } = await import('../shared/types/run.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 30_000
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
const save = w => writeFileSync(join(CLAUDE_DIR, 'workflows', `${w.slug}.json`), JSON.stringify(w, null, 2))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'test-run-repo-'))
  git(dir, 'init', '-q', '-b', 'develop')
  git(dir, 'config', 'user.email', 't@example.com'); git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'README.md'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one')
  return dir
}

// ── 1. isTestRun, and a real run records headAtStart ───────────────────────
assert.equal(isTestRun({}), false)
assert.equal(isTestRun({ testOf: { sourceRunId: 'r', stepId: 's', startPoint: 'x' } }), true)
{
  const workflow = { slug: 'heads', name: 'Heads', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ] }
  save(workflow)
  const projectDir = repo()
  runner.setAgentCaller(async (slug, _input, dir) => {
    if (slug === 'agent-a') { writeFileSync(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'a') }
    return `output of ${slug}`
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, projectDir })
  const run = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(run.status, 'completed')
  const [a, b] = run.steps
  assert.match(a.headAtStart, /^[0-9a-f]{40}$/, 'a step records the commit it started from')
  assert.notEqual(a.headAtStart, b.headAtStart, 'b started after a committed')
}

// ── 2. test runs are kept apart ────────────────────────────────────────────
{
  const live = { id: 't1', workflowSlug: 'heads', status: 'running', group: undefined, testOf: { sourceRunId: 'x', stepId: 'a', startPoint: 'develop' } }
  assert.equal(await queue.inFlightForGroup('default', [live]), 0, 'a test run holds no group slot')
  assert.equal(await queue.inFlightForGroup('default', [{ ...live, testOf: undefined }]), 1, 'a real one does')
}

// ── 3. a test run: seeded, one step, no gates, override ────────────────────
{
  const workflow = { slug: 'tested', name: 'Tested', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: ['c'], approval: true },
    { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
  ] }
  save(workflow)
  const seen = []
  runner.setAgentCaller(async (slug, input) => { seen.push({ slug, input }); return `output of ${slug}` })
  const src = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  let source = await runner.waitForSettled(src.id, TIMEOUT)
  if (source.status === 'paused') { await runner.continueRun(source.id); source = await runner.waitForSettled(src.id, TIMEOUT) }
  assert.equal(source.status, 'completed', 'the source run finishes (its approval answered)')

  seen.length = 0
  const t = await runner.startTestRun(source.id, 'b', { stepOverride: { agentSlug: 'agent-b2', id: 'hijack', next: ['a'] } })
  const test = await runner.waitForSettled(t.id, TIMEOUT)
  assert.equal(test.status, 'completed', 'the approval did not pause the test')
  assert.deepEqual(seen.map(s => s.slug), ['agent-b2'], 'only the tested step ran, with the overridden agent')
  assert.match(seen[0].input, /output of agent-a/, 'it saw the source run\'s earlier output')
  const byId = Object.fromEntries(test.steps.map(s => [s.stepId, s]))
  assert.equal(byId.a.status, 'completed'); assert.equal(byId.a.output, 'output of agent-a')
  assert.equal(byId.b.status, 'completed')
  assert.equal(byId.c.status, 'skipped'); assert.equal(byId.c.skipReason, 'Not part of this test')
  assert.equal(byId.b.agentSlug, 'agent-b2', 'the tested record names the agent that ran')
  assert.equal(test.testOf.sourceRunId, source.id)
  assert.equal(test.stopAfter, 'b')
  assert.equal(test.parentRunId, undefined, 'dispatch lineage untouched')

  await assert.rejects(runner.startTestRun(source.id, 'zz'), e => e.status === 400)
  await assert.rejects(runner.startTestRun('nope', 'b'), e => e.status === 404)

  // A failing tested step fails the test run, and still runs nothing after it.
  seen.length = 0
  runner.setAgentCaller(async (slug) => { seen.push({ slug }); if (slug === 'agent-b') throw new Error('boom'); return `output of ${slug}` })
  const f = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.equal(f.status, 'failed')
  assert.ok(!seen.some(s => s.slug === 'agent-c'), 'nothing after the tested step')

  // A source run that never reached the step is refused with a reason.
  runner.setAgentCaller(async (slug) => { if (slug === 'agent-a') throw new Error('stop'); return 'x' })
  const early = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  await assert.rejects(runner.startTestRun(early.id, 'c'), e => e.status === 409 && /did not finish/.test(e.message))
}

// ── 4. a test run's rework or widen is its outcome, never a restart ───────
{
  const workflow = { slug: 'reworked', name: 'Reworked', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b', 's'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: ['c'] },
    { id: 's', agentSlug: 'agent-s', label: 'Sierra', next: [] },
    { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
  ] }
  save(workflow)
  runner.setAgentCaller(async (slug) => `output of ${slug}`)
  const source = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(source.status, 'completed')

  for (const line of ['PIPELINE-REWORK: Alpha — redo it', 'PIPELINE-WIDEN: someorg/other-repo — the fault is there']) {
    const seen = []
    runner.setAgentCaller(async (slug) => { seen.push(slug); return slug === 'agent-b' ? `looked\n${line}` : `fresh ${slug}` })
    const test = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
    assert.deepEqual(seen, ['agent-b'], `${line}: only the tested step ran`)
    assert.equal(test.status, 'completed', `${line}: the test settles`)
    const byId = Object.fromEntries(test.steps.map(s => [s.stepId, s]))
    assert.equal(byId.a.output, 'output of agent-a', `${line}: the seeded ancestor keeps its output`)
    assert.equal(byId.s.status, 'skipped'); assert.equal(byId.s.skipReason, 'Not part of this test')
    assert.ok(byId.b.output.includes(line), `${line}: the instruction stays visible in the step's output`)
    assert.equal(test.product, source.product, `${line}: the run's scope is not widened`)
  }
}

// ── 5. a stale produces file does not pass the test; runWhen does not skip it ──
{
  const workflow = { slug: 'producing', name: 'Producing', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [], produces: ['b-report.md'], maxVisits: 1 },
  ] }
  save(workflow)
  runner.setAgentCaller(async (slug, input) => {
    if (slug === 'agent-b') writeFileSync(join(input.match(/Write every artifact you produce into: (\S+)/)[1], 'b-report.md'), 'the report\n')
    return `output of ${slug}`
  })
  const source = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(source.status, 'completed', 'the source step wrote its file')
  runner.setAgentCaller(async (slug) => `output of ${slug}`)
  const test = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.equal(test.status, 'failed', 'the source\'s copy of the file does not satisfy the tested step')
  assert.match(test.error, /Output check/)
}
{
  const workflow = { slug: 'conditional', name: 'Conditional', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [], runWhen: { artifact: 'missing.md' } },
  ] }
  save(workflow)
  const seen = []
  runner.setAgentCaller(async (slug) => { seen.push(slug); return `output of ${slug}` })
  const source = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(source.status, 'completed'); assert.deepEqual(seen, ['agent-a'], 'the source skipped b on its condition')
  seen.length = 0
  const test = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.deepEqual(seen, ['agent-b'], 'a test always runs its step')
  assert.equal(test.status, 'completed')
}

console.log('testRun: all checks passed')
process.exit(0)
