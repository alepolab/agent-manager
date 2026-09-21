/**
 * A run cannot report work a reviewer cannot reach.
 *
 *   node scripts/test-ship-integrity.mjs
 *
 * Three real runs finished `completed` while their work was unreachable:
 *
 *   CSUP-7526  the fix sat on three unmerged `--lane-*` branches while the only
 *              pull request was a different repo carrying detection SQL.
 *   CSUP-7524  step 10 reported "three build-breaking findings closed and
 *              verified" with local HEAD two commits ahead of the branch the
 *              pull request was opened from.
 *   SBN-4091   ran to the end, left six commits on a branch, opened no pull
 *              request, and was recorded as completed — twice.
 *
 * Each is one git question. This drives them against real repositories, and
 * pins the two exemptions that keep the check honest rather than noisy: a
 * repository with no origin, and one that has an origin URL but has never
 * fetched, are setups — not runs that failed to push.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const git = (cwd, args) => execFileP('git', args, { cwd }).then(r => r.stdout.trim())

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'ship-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'ship-artifacts-'))

const { shipIntegrity } = await import('../server/utils/shipIntegrity.ts')

const root = mkdtempSync(join(tmpdir(), 'ship-'))
try {
  // A bare "remote" and a clone of it: the only way to test pushed-ness without
  // a network, and the shape every real run works in.
  const remote = join(root, 'remote.git')
  await execFileP('git', ['init', '-q', '--bare', remote])
  const clone = join(root, 'work')
  await execFileP('git', ['clone', '-q', remote, clone])
  await git(clone, ['config', 'user.email', 'test@example.com'])
  await git(clone, ['config', 'user.name', 'Test'])
  writeFileSync(join(clone, 'app.txt'), 'base\n')
  await git(clone, ['add', '-A'])
  await git(clone, ['commit', '-qm', 'base'])
  await git(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])

  const branch = 'fix/CSUP-1-abc'
  await git(clone, ['checkout', '-q', '-b', branch])
  writeFileSync(join(clone, 'fix.txt'), 'the fix\n')
  await git(clone, ['add', '-A'])
  await git(clone, ['commit', '-qm', 'the fix'])

  // `expectPr` is the obligation: a workflow with no pull-request step never
  // pushes, so nothing about its branch is a finding. Every reachability case
  // below is therefore a SHIPPING run.
  const base = await git(clone, ['rev-parse', 'HEAD~1'])
  // The name shipIntegrity derives from `origin` — the last two path segments,
  // the same shape as owner/repo on a real remote.
  const name = (await git(clone, ['remote', 'get-url', 'origin'])).replace(/\.git$/, '').split('/').slice(-2).join('/')
  const run = { id: 'r1', branch, projectDir: clone, baseCommit: base, steps: [] }

  // 1. Committed, never pushed: the CSUP-7524 shape.
  // Both problems are true of it at once: nothing pushed, and no pull request.
  let found = (await shipIntegrity(run, true)).filter(f => f.problem === 'unpushed')
  assert.equal(found.length, 1, `expected one finding, got ${JSON.stringify(found)}`)
  assert.equal(found[0].problem, 'unpushed')
  assert.match(found[0].repo, /remote/, 'the repo is named from its origin, not from the working directory')

  // 2. Pushed: nothing to report.
  await git(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  await git(clone, ['fetch', '-q', 'origin'])
  assert.deepEqual(await shipIntegrity(run, true, { fix: { repos: [{ repo: name, pr: 'https://x/pull/1' }] } }), [],
    'a pushed branch with a pull request is reachable and reports nothing')

  // 3. One commit further, unpushed: the "verified and closed" claim over code
  //    the reviewer cannot fetch.
  writeFileSync(join(clone, 'fix.txt'), 'the fix, revised\n')
  await git(clone, ['commit', '-aqm', 'address review'])
  found = (await shipIntegrity(run, true)).filter(f => f.problem === 'unpushed')
  assert.equal(found[0]?.problem, 'unpushed')
  assert.match(found[0].detail, /1 commit\(s\)/, 'the count is the number a reviewer is missing')
  await git(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  await git(clone, ['fetch', '-q', 'origin'])

  // 4. A lane branch nobody merged: the CSUP-7526 shape.
  const lane = `${branch}--lane-implement-client-change`
  await git(clone, ['branch', lane])
  const laneDir = join(root, 'lane')
  await git(clone, ['worktree', 'add', '--quiet', laneDir, lane])
  await git(laneDir, ['config', 'user.email', 'test@example.com'])
  await git(laneDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(laneDir, 'client.txt'), 'the client half\n')
  await git(laneDir, ['add', '-A'])
  await git(laneDir, ['commit', '-qm', 'client fix'])
  found = (await shipIntegrity(run, true)).filter(f => f.problem === 'lane-orphan')
  assert.equal(found.length, 1, `expected the orphan lane, got ${JSON.stringify(found)}`)
  assert.equal(found[0].problem, 'lane-orphan')
  assert.match(found[0].detail, /never reached/, 'the message says what is wrong with it, not just that it exists')

  // 5. Commits with no pull request: the SBN-4091 shape — and only when the
  //    workflow was meant to open one.
  await git(clone, ['merge', '-q', '--no-edit', lane])
  await git(clone, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
  await git(clone, ['fetch', '-q', 'origin'])
  assert.deepEqual(await shipIntegrity(run, false, {}), [],
    'a workflow that never ships must not be failed for shipping nothing — it never had a branch to push')
  const shipped = await shipIntegrity(run, true, {})
  assert.equal(shipped.find(f => f.problem === 'no-pr')?.repo, name,
    'the commit count comes from git, not from meta.json — which has not been reconciled yet at this point in the run')
  const withPr = { fix: { repos: [{ repo: name, pr: 'https://github.com/x/y/pull/1' }] } }
  assert.deepEqual(await shipIntegrity(run, true, withPr), [], 'a pull request closes it')

  // 6. The exemptions. A repository with no origin has nowhere to push; one
  //    with an origin URL it has never fetched is a fixture, not a failure.
  const local = join(root, 'local')
  await execFileP('git', ['init', '-q', local])
  await git(local, ['config', 'user.email', 'test@example.com'])
  await git(local, ['config', 'user.name', 'Test'])
  writeFileSync(join(local, 'a.txt'), 'x\n')
  await git(local, ['add', '-A'])
  await git(local, ['commit', '-qm', 'base'])
  await git(local, ['checkout', '-q', '-b', branch])
  assert.deepEqual(await shipIntegrity({ id: 'r2', branch, projectDir: local, steps: [] }, true), [],
    'no origin: nowhere to push, nothing to report')
  await git(local, ['remote', 'add', 'origin', 'git@github.com:alepolab/never-fetched.git'])
  assert.deepEqual(await shipIntegrity({ id: 'r3', branch, projectDir: local, steps: [] }, true), [],
    'an origin url with no fetched refs describes the setup, not the run')

  // 7. A run that never made a branch is not this check's business.
  assert.deepEqual(await shipIntegrity({ id: 'r4', projectDir: clone, steps: [] }, true, withPr), [])

  console.log('ship integrity: unpushed, orphan lanes and commits with no pull request are all caught')
} finally {
  rmSync(root, { recursive: true, force: true })
}
