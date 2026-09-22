/**
 * The gate must show what it can prove, against a real repository.
 *
 * test-facts.mjs covers the rules with no I/O. This covers the provider: that
 * the facts it hands the gate actually come from git, that they change when
 * the repository changes, and that a repository it cannot read produces
 * `blocked` rather than a pass.
 *
 * A real temp repo rather than a mocked exec, because the thing most likely
 * to break here is a wrong git invocation, and a mock would agree with
 * whatever the code does.
 *
 *   node scripts/test-gate-criteria.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { criteriaForGate } from '../server/utils/gateCriteria.ts'
import { worldStateOf } from '../server/utils/worldState.ts'

const dir = mkdtempSync(join(tmpdir(), 'gate-crit-'))
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

git('init', '-q', '-b', 'main')
git('config', 'user.email', 't@example.invalid')
git('config', 'user.name', 'Test')
mkdirSync(join(dir, 'src'), { recursive: true })
mkdirSync(join(dir, 'tests'), { recursive: true })
writeFileSync(join(dir, 'src', 'rate.js'), 'export const rate = () => 1\n')
writeFileSync(join(dir, 'tests', 'rate.test.js'), 'test("rate", () => {})\n')
git('add', '-A')
git('commit', '-qm', 'baseline')
const baseline = git('rev-parse', 'HEAD')

const byId = (rs) => Object.fromEntries(rs.map(r => [r.id, r]))
const run = { id: 'r1', baseCommit: baseline, projectDir: dir }

// ---- A clean checkout at the baseline: both facts hold ------------------
{
  const c = byId(await criteriaForGate(run, dir))
  assert.equal(c.tests_unmodified.status, 'pass', 'nothing has changed, so the oracle is untouched')
  assert.equal(c.work_committed.status, 'pass', 'and there is nothing uncommitted')
  // The point of the whole exercise: the reviewer can see WHERE it came from.
  assert.match(c.tests_unmodified.provenance.source, /git/, 'the fact names its source')
  assert.equal(c.tests_unmodified.provenance.head, baseline, 'and the commit it was taken at')
}

// ---- Uncommitted source: the work is not reachable by a reviewer --------
{
  writeFileSync(join(dir, 'src', 'rate.js'), 'export const rate = () => 2\n')
  const c = byId(await criteriaForGate(run, dir))
  assert.equal(c.work_committed.status, 'fail',
    'an uncommitted edit means a reviewer cannot fetch what is being approved')
  assert.equal(c.tests_unmodified.status, 'pass', 'but the tests themselves are still untouched')
}

// ---- A modified test: the control that voids the evidence chain ---------
// "A modified test file is never a pass — it invalidates the run's entire
// evidence chain, and no amount of subsequent green recovers it."
{
  writeFileSync(join(dir, 'tests', 'rate.test.js'), 'test("rate", () => { /* softened */ })\n')
  const c = byId(await criteriaForGate(run, dir))
  assert.equal(c.tests_unmodified.status, 'fail', 'a touched test must reach the person approving')
  assert.ok(c.tests_touched, 'and the specific files must be named')
  assert.match(c.tests_touched.question, /rate\.test\.js/, 'by path, not as a count')
}

// ---- A deleted test is a violation, not an absence ----------------------
{
  rmSync(join(dir, 'tests', 'rate.test.js'))
  const c = byId(await criteriaForGate(run, dir))
  assert.equal(c.tests_unmodified.status, 'fail',
    'deleting the test is the quietest way to make a suite green and must not read as clean')
}

// ---- A directory that is not a repository: blocked, never passed --------
{
  const notRepo = mkdtempSync(join(tmpdir(), 'gate-crit-norepo-'))
  const c = byId(await criteriaForGate({ id: 'r2', baseCommit: baseline, projectDir: notRepo }, notRepo))
  assert.equal(c.tests_unmodified.status, 'blocked',
    'an unreadable diff is unknown, never clean — the estate already learned this once')
  assert.equal(c.work_committed.status, 'blocked')
  assert.ok(c.tests_unmodified.reasons.length, 'and the reviewer is told why')
  rmSync(notRepo, { recursive: true, force: true })
}

// ---- A run with no baseline cannot diff, and must say so ----------------
{
  const c = byId(await criteriaForGate({ id: 'r3', projectDir: dir }, dir))
  assert.equal(c.tests_unmodified.status, 'blocked', 'no baseline means nothing to diff against')
  assert.match(c.tests_unmodified.reasons.join(' '), /baseline/,
    'and that is a different problem from a dirty tree, so it reads differently')
}

// ---- worldStateOf tracks the real repository ----------------------------
{
  const before = await worldStateOf(dir)
  git('add', '-A')
  git('commit', '-qm', 'second')
  const after = await worldStateOf(dir)
  assert.notEqual(before.head, after.head, 'a commit moves HEAD')
  assert.notEqual(before.tree, after.tree, 'and committing changes the dirty set, so the digest moves too')
}

rmSync(dir, { recursive: true, force: true })
console.log('gate criteria: facts come from git and name their source, a touched or deleted test reaches the reviewer, and an unreadable repo blocks rather than passes')
