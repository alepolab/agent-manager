// The base branch follows the kind of work and where the defect was found, and
// the run branch is really cut from that base on the remote, not from wherever
// the checkout happened to sit.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { baseBranchFor, describeBranchChoice } = await import('../server/utils/branchPolicy.ts')

// Policy.
assert.deepEqual(baseBranchFor('feature', 'development'), { base: 'develop', reason: 'a feature found in development starts from develop and is promoted with the next release', mergeBack: [] })
assert.equal(baseBranchFor('bug', 'development').base, 'develop', 'a bug found while developing is fixed on develop')
assert.deepEqual(baseBranchFor('bug', 'production'), { base: 'main', reason: 'a bug found in production is a hotfix from main', mergeBack: ['ci-release', 'develop'] })
assert.deepEqual(baseBranchFor('bug', 'qa'), { base: 'ci-release', reason: 'a bug found by QA or CI on the release candidate is a hotfix from ci-release', mergeBack: ['develop'] })
assert.equal(baseBranchFor('feature', 'production').base, 'develop', 'a feature is never a hotfix, whoever asked for it')
assert.equal(baseBranchFor(undefined, undefined).base, 'develop', 'unclassified work starts from develop')
assert.equal(baseBranchFor('bug', 'development', { bug: 'development', feature: 'development' }).base, 'development', "a product's own branch names win")
assert.equal(baseBranchFor('bug', 'production', { hotfix: 'master' }).base, 'master')
assert.match(describeBranchChoice('fix/CSUP-1-abcd1234', baseBranchFor('bug', 'production')), /cut from origin\/main.*targets main.*merged into ci-release and then develop/s)

// Cutting from the base on the remote.
const W = await import('../server/utils/workspace.ts')
const root = mkdtempSync(join(tmpdir(), 'branch-policy-'))
const git = (cwd, args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const remote = join(root, 'remote.git'); git(root, ['init', '--quiet', '--bare', remote])
const seed = join(root, 'seed'); git(root, ['clone', '--quiet', remote, seed]); git(seed, ['config', 'user.email', 't@x']); git(seed, ['config', 'user.name', 't'])
git(seed, ['checkout', '--quiet', '-b', 'main']); writeFileSync(join(seed, 'a.txt'), 'main\n'); git(seed, ['add', '.']); git(seed, ['commit', '--quiet', '-m', 'main']); git(seed, ['push', '--quiet', 'origin', 'main'])
git(seed, ['checkout', '--quiet', '-b', 'develop']); writeFileSync(join(seed, 'b.txt'), 'develop\n'); git(seed, ['add', '.']); git(seed, ['commit', '--quiet', '-m', 'develop']); git(seed, ['push', '--quiet', 'origin', 'develop'])
const developSha = git(seed, ['rev-parse', 'origin/develop']); const mainSha = git(seed, ['rev-parse', 'origin/main'])
const clone = join(root, 'clone'); git(root, ['clone', '--quiet', '--branch', 'main', remote, clone])
assert.equal(git(clone, ['rev-parse', 'HEAD']), mainSha, 'the clone sits on main, as a fresh clone would')

await W.ensureRunBranch(clone, 'fix/T-1-aaaaaaaa', 'develop')
assert.equal(git(clone, ['branch', '--show-current']), 'fix/T-1-aaaaaaaa')
assert.equal(git(clone, ['rev-parse', 'HEAD']), developSha, 'the run branch starts at the base branch on the remote, not at the checkout\'s HEAD')

await W.ensureRunBranch(clone, 'fix/T-2-bbbbbbbb', 'ci-release')
assert.equal(git(clone, ['branch', '--show-current']), 'fix/T-2-bbbbbbbb')
assert.equal(git(clone, ['rev-parse', 'HEAD']), developSha, 'a base the remote does not have falls back to the current HEAD instead of failing the run')

console.log('branch policy: all checks passed')
