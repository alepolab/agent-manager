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
assert.deepEqual(await W.listCheckouts(), [], 'no workspace root yet means no checkouts')

const repo = W.checkoutDirFor('alepolab/ffm')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '--quiet', '-b', 'develop'])
git(repo, ['config', 'user.email', 't@x']); git(repo, ['config', 'user.name', 't'])
writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, ['add', '.']); git(repo, ['commit', '--quiet', '-m', 'init'])
mkdirSync(join(process.env.AGENT_WORKSPACE_ROOT, 'notes'))
mkdirSync(join(process.env.AGENT_WORKSPACE_ROOT, '.cache'))

let s = await W.checkoutState(repo)
assert.equal(s.branch, 'develop'); assert.equal(s.dirty, 0); assert.ok(s.git && s.exists)
assert.equal((await W.checkoutState(join(root, 'missing'))).exists, false)
const all = await W.listCheckouts()
assert.deepEqual(all.map(c => [c.name, c.git]), [['ffm', true], ['notes', false]], 'every directory is listed, git or not, except dot-directories')

mkdirSync(join(repo, 'new-dir')); writeFileSync(join(repo, 'new-dir', 'x.txt'), 'x\n'); writeFileSync(join(repo, 'new-dir', 'y.txt'), 'y\n')
s = await W.checkoutState(repo)
assert.equal(s.dirty, 2, 'files inside an untracked directory are counted, not the directory')
assert.deepEqual(s.dirtyFiles, ['new-dir/x.txt', 'new-dir/y.txt'], 'paths are whole, including the first line whose status column starts with a space')

await W.ensureRunBranch(repo, 'fix/CSUP-1-abcdef12')
assert.equal(git(repo, ['branch', '--show-current']), 'fix/CSUP-1-abcdef12', 'the run branch is checked out')
mkdirSync(join(repo, '.agent')); writeFileSync(join(repo, '.agent', 'plan.md'), '# plan\n')
assert.equal(git(repo, ['status', '--porcelain', '--', '.agent']), '', 'the plan gate scratch directory is excluded from git in the checkout')
git(repo, ['add', '-A']); assert.equal(git(repo, ['diff', '--cached', '--name-only']).includes('.agent'), false, 'even git add -A cannot stage it')
git(repo, ['reset', '-q'])
assert.equal((await W.checkoutState(repo)).dirty, 2, 'uncommitted work rides along, as git itself does')

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
