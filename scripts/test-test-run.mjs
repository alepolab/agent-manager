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

// ── 6. runner steps dry-run in a test ──────────────────────────────────────
{
  const workflow = { slug: 'drytest', name: 'Dry', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['j'] },
    { id: 'j', agentSlug: 'sdlc-jira-tracker', label: 'Jira', jira: { transition: 'In Review', comment: true }, next: ['n'] },
    { id: 'n', agentSlug: 'sdlc-notifier', label: 'Tell', notify: { channel: 'team', message: 'done' }, next: [] },
  ] }
  save(workflow)
  // The source run needs the Jira and notify steps to have completed; mark them
  // completed by seeding the source record directly rather than calling Jira.
  runner.setAgentCaller(async slug => `output of ${slug}`)
  const src = await store.createRun({ workflowSlug: 'drytest', workflowName: 'Dry', initialPrompt: 'go', watch: 'direct-invocation',
    steps: workflow.steps.map(s => ({ stepId: s.id, label: s.label, agentSlug: s.agentSlug })) })
  for (const s of src.steps) Object.assign(s, { status: 'completed', output: `real ${s.stepId}` })
  Object.assign(src, { status: 'completed', ticketKey: 'SUP-1', endedAt: Date.now() })
  await store.saveRun(src)

  const tj = await runner.waitForSettled((await runner.startTestRun(src.id, 'j')).id, TIMEOUT)
  assert.equal(tj.status, 'completed')
  assert.equal(tj.steps.find(s => s.stepId === 'j').output, '[Test run] Would move SUP-1 to "In Review", and post the outcome comment')
  assert.notEqual(tj.ticketCommented, true, 'no outcome comment was posted for a test run')

  const tn = await runner.waitForSettled((await runner.startTestRun(src.id, 'n')).id, TIMEOUT)
  assert.equal(tn.steps.find(s => s.stepId === 'n').output, '[Test run] Would post to team: done')

  // A loop step plans for real and starts nothing.
  const loopWf = { slug: 'looptest', name: 'Loop', steps: [
    { id: 'd', agentSlug: 'sdlc-auto-dispatcher', label: 'Fan out', triggerWorkflow: { fromParameter: 'repos', itemParameter: 'repo', slug: 'drytest' }, next: [] },
  ] }
  save(loopWf)
  const lsrc = await store.createRun({ workflowSlug: 'looptest', workflowName: 'Loop', initialPrompt: 'go', watch: 'direct-invocation',
    parameters: { repos: 'one\ntwo' }, steps: loopWf.steps.map(s => ({ stepId: s.id, label: s.label, agentSlug: s.agentSlug })) })
  for (const s of lsrc.steps) Object.assign(s, { status: 'completed', output: 'real' })
  Object.assign(lsrc, { status: 'completed', endedAt: Date.now() })
  await store.saveRun(lsrc)
  const tl = await runner.waitForSettled((await runner.startTestRun(lsrc.id, 'd')).id, TIMEOUT)
  const dstep = tl.steps.find(s => s.stepId === 'd')
  assert.equal(dstep.output, '[Test run] Would start 2 runs:\none → drytest\ntwo → drytest')
  assert.equal(dstep.childRunIds, undefined, 'no child run was started')
  assert.equal((await store.listRuns()).filter(r => r.parentRunId === tl.id).length, 0)
}

// ── 7. the test worktree: its own branch, from the step's start commit, removed after ──
{
  const workflow = { slug: 'wt', name: 'Wt', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ] }
  save(workflow)
  const projectDir = repo()
  runner.setAgentCaller(async (slug, _i, dir) => {
    writeFileSync(join(dir, `${slug}.txt`), slug); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', slug)
    return `output of ${slug}`
  })
  const source = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, projectDir })).id, TIMEOUT)
  const bStart = source.steps.find(s => s.stepId === 'b').headAtStart

  let testDir = null
  runner.setAgentCaller(async (slug, _i, dir) => {
    testDir = dir
    assert.equal(git(dir, 'rev-parse', 'HEAD'), bStart, 'the test starts from the commit b started from')
    assert.equal(existsSync(join(dir, 'agent-b.txt')), false, 'not from the end of the source run')
    return 'tested'
  })
  const t = await runner.waitForSettled((await runner.startTestRun(source.id, 'b')).id, TIMEOUT)
  assert.equal(t.status, 'completed')
  assert.match(t.branch, new RegExp(`^test/${source.id.slice(0, 8)}-b-1$`))
  assert.equal(t.testOf.startPoint, bStart)
  assert.equal(t.testOf.codeNote, undefined)
  assert.ok(testDir, 'the agent ran in a directory')
  for (let i = 0; i < 50 && existsSync(testDir); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(existsSync(testDir), false, 'the test worktree is removed when the test settles')
  assert.equal(git(projectDir, 'branch', '--list', t.branch), '', 'and its branch')
  assert.notEqual(git(projectDir, 'branch', '--list', source.branch), '', 'the source run\'s branch is untouched')

  // A run's real branch is never removed.
  const ws = await import('../server/utils/workspace.ts')
  await assert.rejects(ws.removeTestWorktrees(projectDir, source.branch), /test\//)
  assert.notEqual(git(projectDir, 'branch', '--list', source.branch), '', 'still there after the refusal')
}

// ── 8. a live test run neither holds nor is refused by the workspace lock ──
{
  const dir = repo()
  const live = await store.createRun({ workflowSlug: 'wt', workflowName: 'Wt', initialPrompt: 'go', watch: 'direct-invocation', projectDir: dir,
    steps: [{ stepId: 'a', label: 'Alpha', agentSlug: 'agent-a' }] })
  live.testOf = { sourceRunId: 'x', stepId: 'a', startPoint: 'develop' }
  await store.saveRun(live)
  assert.equal(await store.findRunInWorkspace(dir), null, 'a live test run does not lock its workspace')
  assert.equal(await store.findRunInWorkspace(dir, undefined, { includeQueued: true }), null, 'nor count as aimed at it')
  delete live.testOf
  await store.saveRun(live)
  assert.equal((await store.findRunInWorkspace(dir))?.id, live.id, 'a real one does')
  live.status = 'stopped'; await store.saveRun(live)
}

console.log('testRun: all checks passed')
process.exit(0)
