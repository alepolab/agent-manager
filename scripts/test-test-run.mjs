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

console.log('testRun: all checks passed')
process.exit(0)
