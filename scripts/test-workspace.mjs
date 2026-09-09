/** Checkout state, run branches, parking changes and the artifacts probe, against throwaway git repos. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const wt = W.worktreeDirFor(repo, 'fix/CSUP-1-abcdef12')
assert.equal(wt, `${repo}@fix-CSUP-1-abcdef12`, 'the run worktree sits beside the clone, named after it and the branch')
const branched = await W.ensureRunBranch(repo, 'fix/CSUP-1-abcdef12')
assert.deepEqual(branched, [wt, join(wt, 'modules', 'administrator')], 'the runner learns every worktree it made, the run\'s own first')
assert.equal(git(wt, ['branch', '--show-current']), 'fix/CSUP-1-abcdef12', 'the run branch is checked out in the worktree')
assert.equal(git(join(wt, 'modules', 'administrator'), ['branch', '--show-current']), 'fix/CSUP-1-abcdef12', 'a module that is its own repository gets a worktree on the branch too, at the same relative path')
assert.equal(git(repo, ['branch', '--show-current']), 'develop', 'the clone itself is left on its own branch')
assert.equal(git(mod, ['branch', '--show-current']), 'main', 'and so is the module clone')
assert.equal(git(wt, ['rev-parse', 'HEAD']), git(repo, ['rev-parse', 'HEAD']), 'the worktree starts at the clone\'s HEAD')
assert.deepEqual(await W.ensureRunBranch(repo, 'fix/CSUP-1-abcdef12'), branched, 'a worktree already on the branch is reused, not rebuilt')
assert.equal(W.findCheckout(process.env.AGENT_WORKSPACE_ROOT, 'ffm'), repo, 'the clone is still found by name beside its worktree')
assert.equal(W.findCheckout(process.env.AGENT_WORKSPACE_ROOT), repo, 'and without a name: a run worktree beside it is never mistaken for the clone')
{
  // The path already exists on another branch: a stale worktree from a run that died. Never reuse or rebuild over it.
  const stale = W.worktreeDirFor(repo, 'fix/CSUP-2-deadbeef')
  git(repo, ['worktree', 'add', '--quiet', '-B', 'someone-elses-branch', stale])
  await assert.rejects(W.ensureRunBranch(repo, 'fix/CSUP-2-deadbeef'), /exists and is on someone-elses-branch/, 'a worktree on the wrong branch is an error, not a fallback')
}
assert.equal((await W.listCheckouts()).find(c => c.name === 'ffm@fix-CSUP-1-abcdef12')?.branch, 'fix/CSUP-1-abcdef12', 'the worktree is listed as a checkout on the run branch')
mkdirSync(join(wt, '.agent', 'evidence-run'), { recursive: true }); writeFileSync(join(wt, '.agent', 'plan.md'), '# plan\n'); writeFileSync(join(wt, '.agent', 'evidence-run', 'meta.json'), '{}')
git(wt, ['add', '-A']); const staged = git(wt, ['diff', '--cached', '--name-only'])
assert.ok(staged.includes('.agent/plan.md'), 'the plan the gate requires can still be committed')
assert.ok(!staged.includes('evidence-run'), 'an evidence copy cannot be staged even with git add -A, in a worktree whose .git is a file')
git(wt, ['reset', '-q'])
{ const st = await W.checkoutState(wt); assert.equal(st.dirty, 1, 'uncommitted work and the plan the gate needs ride along, as git itself does: ' + st.dirtyFiles.join(',')) }
{ const st = await W.checkoutState(repo); assert.equal(st.dirty, 2, 'the clone\'s own uncommitted work is untouched: ' + st.dirtyFiles.join(',')) }

{
  // A superproject with a real submodule: its worktree materialises the module as an EMPTY directory that answers git commands for the parent.
  const sup = W.checkoutDirFor('alepolab/billing_cpp14'); mkdirSync(sup, { recursive: true }); git(sup, ['init', '--quiet', '-b', 'main']); git(sup, ['config', 'user.email', 't@x']); git(sup, ['config', 'user.name', 't'])
  const subSrc = join(root, 'sub-src'); mkdirSync(subSrc); git(subSrc, ['init', '--quiet', '-b', 'main']); git(subSrc, ['config', 'user.email', 't@x']); git(subSrc, ['config', 'user.name', 't']); writeFileSync(join(subSrc, 's.txt'), 's\n'); git(subSrc, ['add', '.']); git(subSrc, ['commit', '--quiet', '-m', 'sub'])
  writeFileSync(join(sup, 'a.txt'), 'a\n'); git(sup, ['add', '.']); git(sup, ['commit', '--quiet', '-m', 'init'])
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', subSrc, 'modules/common']); git(sup, ['commit', '--quiet', '-m', 'add submodule'])
  const [swt, mwt] = await W.ensureRunBranch(sup, 'fix/BIL-1-01234567')
  assert.equal(mwt, join(swt, 'modules', 'common'), 'the submodule gets its own worktree at the same relative path')
  assert.equal(git(mwt, ['rev-parse', '--show-toplevel']), mwt, 'and it is a worktree of the module, not an empty placeholder answering for the parent')
  assert.equal(git(mwt, ['branch', '--show-current']), 'fix/BIL-1-01234567')
  assert.ok(existsSync(join(mwt, 's.txt')), 'with the module\'s files in it')
}

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
