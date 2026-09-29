/**
 * A run whose branch is already checked out in some worktree reuses it.
 *
 * ASECRM-219, 235 and 267 each had their branch checked out at the ticket's
 * workspace directory itself (`local/ASECRM-267`), and the runner then tried
 * to add `local/ASECRM-267@fix-…` for the same branch. Git refuses a branch
 * checked out twice, so every one of those runs failed at its first code step
 * with "already used by worktree".
 *
 *   node scripts/test-run-branch-reuses-worktree.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ensureRunBranch } = await import('../server/utils/workspace.ts')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const root = realpathSync(mkdtempSync(join(tmpdir(), 'reuse-wt-')))
const clone = join(root, 'ase-crm')
execFileSync('git', ['init', '-q', '-b', 'main', clone])
git(clone, 'config', 'user.email', 't@example.test'); git(clone, 'config', 'user.name', 't')
writeFileSync(join(clone, 'README'), 'x'); git(clone, 'add', 'README'); git(clone, 'commit', '-qm', 'init')

// The ASECRM-267 layout: the ticket workspace is itself a worktree on the run branch.
const branch = 'fix/ASECRM-267-a61c86fb'
const workspace = join(root, 'ASECRM-267')
git(clone, 'worktree', 'add', '-q', '-b', branch, workspace)
writeFileSync(join(workspace, 'work.txt'), 'in progress')

// Handed the workspace (what the runner found there) - it is the run's worktree.
assert.deepEqual(await ensureRunBranch(workspace, branch), [workspace], 'the existing worktree is reused')
assert.ok(!existsSync(`${workspace}@fix-ASECRM-267-a61c86fb`), 'no second worktree is attempted')
assert.ok(existsSync(join(workspace, 'work.txt')), 'and nothing in it is touched')

// Handed the clone, the same answer: the branch lives where it already is.
assert.deepEqual(await ensureRunBranch(clone, branch), [workspace])

// A branch nobody has checked out still gets its own worktree beside the clone.
const made = await ensureRunBranch(clone, 'fix/ASECRM-300-deadbeef')
assert.deepEqual(made, [`${clone}@fix-ASECRM-300-deadbeef`])
assert.equal(git(made[0], 'branch', '--show-current'), 'fix/ASECRM-300-deadbeef')

console.log('ok - a run reuses the worktree its branch is already checked out in')
