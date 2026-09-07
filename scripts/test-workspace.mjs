/** Checkout state, run branches, parking changes and the artifacts probe, against throwaway git repos. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'workspace-'))
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const W = await import('../server/utils/workspace.ts')

assert.equal(W.checkoutDirFor('alepolab/ffm'), join(process.env.AGENT_WORKSPACE_ROOT, 'ffm'))
assert.equal(W.checkoutDirFor('alepolab/ffm', 'sandeep'), join(process.env.AGENT_WORKSPACE_ROOT, 'sandeep', 'ffm'), 'a signed-in developer has their own workspace')
assert.deepEqual(await W.listCheckouts(), [], 'no workspace root yet means no checkouts')

const repo = W.checkoutDirFor('alepolab/ffm')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '--quiet', '-b', 'develop'])
git(repo, ['config', 'user.email', 't@x']); git(repo, ['config', 'user.name', 't'])
writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, ['add', '.']); git(repo, ['commit', '--quiet', '-m', 'init'])
mkdirSync(join(process.env.AGENT_WORKSPACE_ROOT, 'notes'))
mkdirSync(join(process.env.AGENT_WORKSPACE_ROOT, '.cache'))
const mine = W.checkoutDirFor('alepolab/pms', 'sandeep'); mkdirSync(mine, { recursive: true }); git(mine, ['init', '--quiet', '-b', 'develop'])

let s = await W.checkoutState(repo)
assert.equal(s.branch, 'develop'); assert.equal(s.dirty, 0); assert.ok(s.git && s.exists)
assert.equal((await W.checkoutState(join(root, 'missing'))).exists, false)
const all = await W.listCheckouts()
assert.deepEqual(all.map(c => [c.name, c.git, c.owner ?? null]), [['ffm', true, null], ['pms', true, 'sandeep']], 'shared checkouts and each developer\'s own are listed; plain directories and dot-directories are not')

mkdirSync(join(repo, 'new-dir')); writeFileSync(join(repo, 'new-dir', 'x.txt'), 'x\n'); writeFileSync(join(repo, 'new-dir', 'y.txt'), 'y\n')
s = await W.checkoutState(repo)
assert.equal(s.dirty, 2, 'files inside an untracked directory are counted, not the directory')
assert.deepEqual(s.dirtyFiles, ['new-dir/x.txt', 'new-dir/y.txt'], 'paths are whole, including the first line whose status column starts with a space')

const mod = join(repo, 'modules', 'administrator'); mkdirSync(mod, { recursive: true }); git(mod, ['init', '--quiet', '-b', 'main']); git(mod, ['config', 'user.email', 't@x']); git(mod, ['config', 'user.name', 't']); writeFileSync(join(mod, 'm.txt'), 'm\n'); git(mod, ['add', '.']); git(mod, ['commit', '--quiet', '-m', 'init'])
const branched = await W.ensureRunBranch(repo, 'fix/CSUP-1-abcdef12')
assert.equal(git(repo, ['branch', '--show-current']), 'fix/CSUP-1-abcdef12', 'the run branch is checked out')
assert.equal(git(mod, ['branch', '--show-current']), 'fix/CSUP-1-abcdef12', 'a module that is its own repository gets the branch too')
assert.deepEqual(branched, [repo, mod], 'and the runner learns every repository it branched')
mkdirSync(join(repo, '.agent', 'evidence-run'), { recursive: true }); writeFileSync(join(repo, '.agent', 'plan.md'), '# plan\n'); writeFileSync(join(repo, '.agent', 'evidence-run', 'meta.json'), '{}')
git(repo, ['add', '-A']); const staged = git(repo, ['diff', '--cached', '--name-only'])
assert.ok(staged.includes('.agent/plan.md'), 'the plan the gate requires can still be committed')
assert.ok(!staged.includes('evidence-run'), 'an evidence copy cannot be staged even with git add -A')
git(repo, ['reset', '-q'])
{ const st = await W.checkoutState(repo); assert.equal(st.dirty, 3, 'uncommitted work and the plan the gate needs ride along, as git itself does: ' + st.dirtyFiles.join(',')) }

const r = await W.stashCheckout(repo, 'sandeep')
assert.equal(r.stashed, true); assert.match(r.message, /parked by sandeep/)
assert.equal((await W.checkoutState(repo)).dirty, 0, 'parked work leaves a clean tree')
assert.match(git(repo, ['stash', 'list']), /parked by sandeep/, 'and is recoverable with stash pop')
assert.equal((await W.stashCheckout(repo, 'sandeep')).stashed, false, 'a clean tree has nothing to park')
await assert.rejects(W.stashCheckout(join(process.env.AGENT_WORKSPACE_ROOT, 'notes'), 'x'), /not a git checkout/)

assert.equal((await W.artifactsWritable()).ok, true, 'a missing runs dir is created and writable')
writeFileSync(join(root, 'file'), '')
process.env.AGENT_RUNS_DIR = join(root, 'file', 'runs')
const bad = await W.artifactsWritable()
assert.equal(bad.ok, false); assert.ok(bad.error, 'the reason travels with the verdict')

rmSync(root, { recursive: true, force: true })
console.log('workspace: all assertions passed')
