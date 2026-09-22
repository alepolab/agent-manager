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

// ---- Parked work stays visible after it is parked ------------------------
// Parking used to announce the recovery command in a confirm() that closed on
// the click and a toast that faded, then the row read "clean" again. The only
// trace of the work was a stash nothing in the UI mentioned.
assert.deepEqual(s.stashes, [], 'a checkout that never stashed reports none, rather than omitting the field')
{
  const parked = await W.stashCheckout(repo, 'sandeep')
  assert.equal(parked.stashed, true)
  const after = await W.checkoutState(repo)
  assert.equal(after.dirty, 0, 'parking clears the tree, which is the whole point')
  assert.equal(after.stashes.length, 1, 'and the parked work is still reported, so it can be found again')
  assert.match(after.stashes[0].subject, /parked by sandeep/, 'named with who parked it, not an opaque WIP line')
  assert.match(after.stashes[0].ref, /^stash@\{0\}$/, 'and by the ref `git stash pop` acts on')
  // Put it back so the rest of the file sees the tree it expects.
  git(repo, ['stash', 'pop'])
  assert.equal((await W.checkoutState(repo)).dirty, 2, 'and popping restores exactly what was parked')
}
{
  const clean = join(root, 'clean-repo')
  mkdirSync(clean); git(clean, ['init', '--quiet', '-b', 'main'])
  git(clean, ['config', 'user.email', 't@x']); git(clean, ['config', 'user.name', 't'])
  writeFileSync(join(clean, 'a.txt'), 'a\n'); git(clean, ['add', '.']); git(clean, ['commit', '--quiet', '-m', 'init'])
  const r = await W.stashCheckout(clean, 'sandeep')
  assert.equal(r.stashed, false, 'nothing to park is not an error')
  assert.equal((await W.checkoutState(clean)).stashes.length, 0, 'and it invents no stash')
  rmSync(clean, { recursive: true, force: true })
}

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

// ── A commit made in a run worktree says which run made it ──────────────────
//
// Every agent commit across thirteen runs was authored by the operator, and
// grepping every one of them for a run id returned nothing: `git log` could not
// answer "was this agent-written?" or "where is the evidence for this line?".
{
  const { installRunTrailer } = await import('../server/utils/workspace.ts')
  const repo = mkdtempSync(join(tmpdir(), 'trailer-'))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(join(repo, 'a.txt'), 'x\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })

  await installRunTrailer(repo, 'fix/CSUP-1-9a6ea7d0')
  writeFileSync(join(repo, 'b.txt'), 'y\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'the fix'], { cwd: repo })
  const body = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: repo, encoding: 'utf8' })
  assert.match(body, /Run-Id: 9a6ea7d0/, 'the commit carries its run id, so the evidence is one grep away')

  // Twice is once: an amend or a rebase must not stack trailers.
  execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: repo })
  const amended = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: repo, encoding: 'utf8' })
  assert.equal((amended.match(/Run-Id:/g) ?? []).length, 1, 'the trailer is added once, not once per commit attempt')

  // A branch that is not a run branch is left alone.
  const plain = mkdtempSync(join(tmpdir(), 'trailer-plain-'))
  execFileSync('git', ['init', '-q', plain])
  await installRunTrailer(plain, 'feature/ordinary-branch')
  assert.ok(!existsSync(join(plain, '.git', 'hooks', 'prepare-commit-msg')),
    'no hook is installed outside a run worktree')
  rmSync(repo, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
}

console.log('workspace: the run trailer and the scratch exclude are pinned too')
