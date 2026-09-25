/**
 * A run that declares a `branch` parameter reads that branch in a worktree of
 * its own - the product's development branch when left blank - never the
 * shared clone on whatever branch it was left on.
 *
 * The nightly scans read ase-crm's main for a day: four months behind develop,
 * where the work lands. Their own directory stayed empty, which is also why a
 * restart of one refused to resume.
 *
 *   node scripts/test-scan-branch.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'scan-branch-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.AGENT_REGISTRY_PATH = join(root, 'products.yaml')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
mkdirSync(process.env.AGENT_WORKSPACE_ROOT, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

// An origin with main and develop holding different content, and a clone of it
// left on main - the shape the shared ase-crm clone was in.
const origin = join(root, 'origin.git')
git(root, 'init', '--quiet', '--bare', '-b', 'main', origin)
const seed = join(root, 'seed')
git(root, 'clone', '--quiet', origin, seed)
writeFileSync(join(seed, 'WHICH'), 'main\n')
git(seed, 'add', 'WHICH'); git(seed, 'commit', '--quiet', '-m', 'main'); git(seed, 'push', '--quiet', 'origin', 'main')
git(seed, 'checkout', '--quiet', '-b', 'develop')
writeFileSync(join(seed, 'WHICH'), 'develop\n')
git(seed, 'commit', '--quiet', '-am', 'develop'); git(seed, 'push', '--quiet', 'origin', 'develop')
const clone = join(process.env.AGENT_WORKSPACE_ROOT, 'demo')
git(root, 'clone', '--quiet', origin, clone)
assert.equal(readFileSync(join(clone, 'WHICH'), 'utf8').trim(), 'main', 'the shared clone sits on main')

writeFileSync(process.env.AGENT_REGISTRY_PATH, `products:
  demo:
    match: { projects: [DEMO] }
    repos: [alepolab/demo]
    branches: { bug: develop, feature: develop }
`)

const steps = [{ id: 'scan', agentSlug: 'agent-scan', label: 'Scan', next: [] }]
const workflow = (slug) => {
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${slug}.json`), JSON.stringify({
    name: slug, description: '', steps, createdAt: new Date().toISOString(),
    parameters: [{ name: 'repo' }, ...(slug === 'plain' ? [] : [{ name: 'branch' }])],
  }))
  return { slug, name: slug, steps }
}

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
let read
runner.setAgentCaller(async (slug, input, dir) => {
  read = existsSync(join(dir, 'WHICH')) ? readFileSync(join(dir, 'WHICH'), 'utf8').trim() : null
  return { output: 'done', model: 'm', usage: null }
})
const start = async (slug, parameters, dir) => runner.waitForSettled((await runner.startRun({
  workflow: workflow(slug), initialPrompt: 'scan it', watch: 'direct-invocation', autoRun: true,
  parameters, projectDir: join(process.env.AGENT_WORKSPACE_ROOT, dir),
})).id, 20000)

// ── blank: the product's development branch ──
{
  read = undefined
  const r = await start('scan-demo', { repo: 'alepolab/demo' }, 'nightly-a')
  assert.equal(r.status, 'completed', r.error)
  assert.equal(r.parameters.branch, 'develop', 'a blank branch becomes the registry development branch')
  assert.equal(r.baseBranch, 'develop')
  assert.match(r.projectDir, /demo@scan-/, 'the run works in its own worktree beside the clone')
  assert.equal(read, 'develop', 'and the agent reads develop there')
  assert.equal(readFileSync(join(clone, 'WHICH'), 'utf8').trim(), 'main', 'the shared clone is left where it was')
}

// ── named: exactly that branch ──
{
  read = undefined
  const r = await start('scan-demo', { repo: 'alepolab/demo', branch: 'main' }, 'nightly-b')
  assert.equal(r.status, 'completed', r.error)
  assert.equal(read, 'main', 'a named branch is read as named')
}

// ── a branch origin lacks: refused, never HEAD in its place ──
{
  read = undefined
  await assert.rejects(start('scan-demo', { repo: 'alepolab/demo', branch: 'no-such-branch' }, 'nightly-c'), /no branch "no-such-branch"/,
    'a branch the remote lacks is refused by name')
  const store = await import('../server/utils/workflowRunStore.ts')
  const r = (await store.listRuns('scan-demo')).find(x => x.parameters?.branch === 'no-such-branch')
  assert.equal(r.status, 'failed', 'and the run records the failure')
  assert.equal(read, undefined, 'before any agent ran')
}

// ── a workflow that declares no branch is untouched ──
{
  const r = await start('plain', { repo: 'alepolab/demo' }, 'nightly-d')
  assert.equal(r.parameters?.branch, undefined, 'no branch parameter is invented for a workflow that does not declare one')
  assert.equal(r.branch, undefined, 'and no worktree is made')
}

rmSync(root, { recursive: true, force: true })
console.log('scan branch: a scan reads the branch it names, in a worktree of its own')
