/**
 * A dispatched run, whose directory is an empty one named for its ticket,
 * gets its worktree beside the product's clone.
 *
 * ASECRM-331 to 337 each started in an empty `<workspace>/<ticket>` directory
 * and got no worktree and no branch: the runner looked for a checkout only
 * inside that directory. Their agents cut branches into it by hand.
 *
 *   node scripts/test-dispatched-run-worktree.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dispatched-wt-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.AGENT_REGISTRY_PATH = join(root, 'products.yaml')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
mkdirSync(process.env.AGENT_WORKSPACE_ROOT, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const origin = join(root, 'origin.git')
git(root, 'init', '--quiet', '--bare', '-b', 'main', origin)
const seed = join(root, 'seed')
git(root, 'clone', '--quiet', origin, seed)
writeFileSync(join(seed, 'A'), 'a\n'); git(seed, 'add', 'A'); git(seed, 'commit', '--quiet', '-m', 'a'); git(seed, 'push', '--quiet', 'origin', 'main')
git(seed, 'checkout', '--quiet', '-b', 'develop'); git(seed, 'push', '--quiet', 'origin', 'develop')
const clone = join(process.env.AGENT_WORKSPACE_ROOT, 'demo')
git(root, 'clone', '--quiet', origin, clone)
writeFileSync(process.env.AGENT_REGISTRY_PATH, `products:
  demo:
    match: { projects: [DEMO] }
    repos: [alepolab/demo]
    branches: { bug: develop, feature: develop }
`)

const steps = [{ id: 'code', agentSlug: 'agent-code', label: 'Code', next: [] }]
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'fix.json'), JSON.stringify({ name: 'fix', description: '', steps, createdAt: new Date().toISOString() }))
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const cwds = []
runner.setAgentCaller(async (_slug, _input, cwd) => { cwds.push(cwd); return 'done' })

// As the dispatcher starts a child: its own directory, named for the ticket.
const own = join(process.env.AGENT_WORKSPACE_ROOT, 'DEMO-7')
const started = await runner.startRun({ workflow: { slug: 'fix', name: 'fix', steps }, initialPrompt: 'DEMO-7: fix it', watch: 'direct-invocation', autoRun: true, projectDir: own, ticketKey: 'DEMO-7' })
const run = await runner.waitForSettled(started.id, 15000)
assert.equal(run.status, 'completed', run.error)
assert.match(run.branch ?? '', /^fix\/DEMO-7-/, 'the run has its own branch')
assert.equal(run.projectDir, `${clone}@${run.branch.replace(/\//g, '-')}`, 'its worktree sits beside the product clone')
assert.equal(git(run.projectDir, 'branch', '--show-current'), run.branch)
assert.equal(cwds[0], run.projectDir, 'the step worked in it')
assert.deepEqual(readdirSync(own), [], 'nothing was made in the empty directory')

console.log('ok - a dispatched run gets its worktree beside the product clone')
process.exit(0)
