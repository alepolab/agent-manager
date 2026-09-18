/**
 * The test that judges a fix must not be edited by the fix.
 *
 * One step of a run owns the tests - the step that reproduces the defect and
 * writes the failing test, marked `testsUnlocked` in the template. Every step
 * after it is supposed to leave that test alone, and the estate's own gate says
 * why in the strongest terms it uses anywhere: "A modified test file is never a
 * pass - it invalidates the run's entire evidence chain, and no amount of
 * subsequent green recovers it"
 * (.agents/workflows/runbook-a/resources/phase-gates.md:119-121).
 *
 * That rule had no implementation. The unlock file is written into the run's
 * worktree and never removed, nothing reads the diff, and the template tells the
 * reader the opposite is guaranteed - so nobody looks. A fix agent that edits
 * the failing test turns every green afterwards into a green about nothing.
 *
 * This file pins the check that reads the diff. Cases are written against real
 * git, because the whole point is what the repository actually contains after a
 * step ran, not what an agent reported.
 *
 *   node scripts/test-test-lock.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { testPathsIn, checkTestLock } = await import('../server/utils/testLock.ts')

// ---- testPathsIn: which paths count as the tests that judge a change -------
// Pure, so every language and layout the estate actually uses is pinned here
// rather than discovered in production.
{
  const touched = testPathsIn([
    'src/main/java/com/alepo/se/Foo.java',
    'src/test/java/com/alepo/se/FooTest.java',
    'administrator-api/src/test/java/com/alepo/se/administrator/datatable/list/DataTableExportLengthClampTest.java',
    'app/components/Thing.vue',
    'app/components/__tests__/Thing.spec.ts',
    'scripts/test-roles.mjs',
    'packages/frontend/src/app/x.component.spec.ts',
    'e2e/workflow-run-panel.smoke.mjs',
    'docs/testing.md',
    'src/testUtils/helper.ts',
  ])
  assert.ok(touched.includes('src/test/java/com/alepo/se/FooTest.java'), 'a java test under src/test is a test')
  assert.ok(touched.includes('administrator-api/src/test/java/com/alepo/se/administrator/datatable/list/DataTableExportLengthClampTest.java'), 'nested module test dirs count')
  assert.ok(touched.includes('app/components/__tests__/Thing.spec.ts'), 'a __tests__ directory counts')
  assert.ok(touched.includes('scripts/test-roles.mjs'), 'this repo names its own suites test-*.mjs')
  assert.ok(touched.includes('packages/frontend/src/app/x.component.spec.ts'), 'a .spec.ts beside its source counts')
  assert.ok(touched.includes('e2e/workflow-run-panel.smoke.mjs'), 'the e2e directory counts')

  assert.ok(!touched.includes('src/main/java/com/alepo/se/Foo.java'), 'production java is not a test')
  assert.ok(!touched.includes('app/components/Thing.vue'), 'a component is not a test')
  assert.ok(!touched.includes('docs/testing.md'), 'documentation ABOUT testing is not a test - a doc edit must not fail a step')
  assert.ok(!touched.includes('src/testUtils/helper.ts'), 'a testUtils helper is not itself a judging test')
}

// ---- checkTestLock against real git ----------------------------------------
const root = mkdtempSync(join(tmpdir(), 'test-lock-'))
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function repo() {
  const dir = mkdtempSync(join(root, 'repo-'))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  mkdirSync(join(dir, 'src', 'test', 'java'), { recursive: true })
  mkdirSync(join(dir, 'src', 'main', 'java'), { recursive: true })
  writeFileSync(join(dir, 'src', 'main', 'java', 'Foo.java'), 'class Foo {}\n')
  writeFileSync(join(dir, 'src', 'test', 'java', 'FooTest.java'), '// asserts the defect\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'the failing test the fix will be judged by'])
  return dir
}

// A step that only touched production code passes.
{
  const dir = repo()
  const before = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'src', 'main', 'java', 'Foo.java'), 'class Foo { int fixed = 1; }\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'fix the defect'])

  const verdict = await checkTestLock({ dir, since: before })
  assert.equal(verdict.ok, true, `a production-only change keeps the lock; got ${JSON.stringify(verdict)}`)
  assert.deepEqual(verdict.touched, [])
  assert.match(verdict.why, /no test/i)
}

// A step that edited the judging test FAILS, and names the file.
{
  const dir = repo()
  const before = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'src', 'test', 'java', 'FooTest.java'), '// assertion softened\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'make it pass'])

  const verdict = await checkTestLock({ dir, since: before })
  assert.equal(verdict.ok, false, 'editing the test that judges the fix breaks the lock')
  assert.deepEqual(verdict.touched, ['src/test/java/FooTest.java'],
    `the violating file is named; got ${JSON.stringify(verdict.touched)}`)
  assert.match(verdict.why, /evidence/i, 'and the reason says what it costs, not just that a rule fired')
}

// A DELETED test is a violation too - the sneakiest way to make a suite green.
{
  const dir = repo()
  const before = git(dir, ['rev-parse', 'HEAD'])
  rmSync(join(dir, 'src', 'test', 'java', 'FooTest.java'))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'remove the test'])

  const verdict = await checkTestLock({ dir, since: before })
  assert.equal(verdict.ok, false, 'deleting the judging test breaks the lock')
  assert.ok(verdict.touched.some(p => p.endsWith('FooTest.java')), 'and the deleted file is named')
}

// Uncommitted work counts: a step that leaves the edit in the working tree has
// still edited the test, and a check that only reads commits would miss it.
{
  const dir = repo()
  const before = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'src', 'test', 'java', 'FooTest.java'), '// softened, not committed\n')

  const verdict = await checkTestLock({ dir, since: before })
  assert.equal(verdict.ok, false, 'an uncommitted test edit is still a test edit')
  assert.ok(verdict.touched.some(p => p.endsWith('FooTest.java')))
}

// A step allowed to own the tests is not judged by this check at all.
{
  const dir = repo()
  const before = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'src', 'test', 'java', 'FooTest.java'), '// the reproduction, written on purpose\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'write the failing test'])

  const verdict = await checkTestLock({ dir, since: before, testsUnlocked: true })
  assert.equal(verdict.ok, true, 'the step that OWNS the tests may write them')
  assert.match(verdict.why, /owns the tests|unlocked/i, 'and the verdict says why it was exempt')
  assert.ok(verdict.touched.some(p => p.endsWith('FooTest.java')), 'the files are still reported, so the evidence names what it wrote')
}

// An unreadable range degrades to "cannot tell", never to a pass.
{
  const dir = repo()
  const verdict = await checkTestLock({ dir, since: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  assert.equal(verdict.ok, false, 'a diff that cannot be computed is not a pass')
  assert.equal(verdict.indeterminate, true, 'and it is marked indeterminate rather than reported as a violation')
  assert.match(verdict.why, /could not/i)
}

rmSync(root, { recursive: true, force: true })
console.log('test lock: the fix cannot edit the test that judges it, and an unreadable diff is never a pass')
