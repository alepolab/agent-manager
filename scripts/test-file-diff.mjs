/**
 * "The change" at a gate opens each file's diff: old and new line numbers,
 * added and removed lines, hunk headers. Only a file the run changed is
 * diffed.
 *
 *   node scripts/test-file-diff.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parseUnifiedDiff, currentPath } = await import('../shared/utils/unifiedDiff.ts')
const { computeFileDiff } = await import('../server/utils/gitFacts.ts')

// ── Parsing: line numbers on each side ───────────────────────────────────────
{
  const d = parseUnifiedDiff([
    'diff --git a/f.ts b/f.ts', 'index 1..2 100644', '--- a/f.ts', '+++ b/f.ts',
    '@@ -10,4 +10,5 @@ function x() {', ' keep', '-old', '+new', '+added', ' tail', '\\ No newline at end of file', '',
  ].join('\n'))
  assert.deepEqual(d.rows.map(r => [r.kind, r.old, r.new, r.text]), [
    ['hunk', null, null, '@@ -10,4 +10,5 @@ function x() {'],
    ['context', 10, 10, 'keep'],
    ['del', 11, null, 'old'],
    ['add', null, 11, 'new'],
    ['add', null, 12, 'added'],
    ['context', 12, 13, 'tail'],
    ['note', null, null, 'No newline at end of file'],
  ])
  assert.deepEqual([d.added, d.removed, d.binary], [2, 1, false])
  assert.equal(parseUnifiedDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n').binary, true)
}

// ── Renamed paths, as numstat names them ─────────────────────────────────────
assert.equal(currentPath('src/{old => new}/f.ts'), 'src/new/f.ts')
assert.equal(currentPath('src/{ => sub}/f.ts'), 'src/sub/f.ts')
assert.equal(currentPath('a.ts => b.ts'), 'b.ts')
assert.equal(currentPath('plain/path.ts'), 'plain/path.ts')

// ── Against a real repository ────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'file-diff-'))
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
try {
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'one\ntwo\nthree\n'); writeFileSync(join(dir, 'untouched.ts'), 'x\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src/a.ts'), 'one\n2\nthree\nfour\n')
  git('commit', '-qam', 'fix')

  const r = await computeFileDiff(dir, base, 'src/a.ts')
  assert.ok(r && !r.truncated)
  const d = parseUnifiedDiff(r.diff)
  assert.deepEqual(d.rows.filter(x => x.kind === 'add').map(x => [x.new, x.text]), [[2, '2'], [4, 'four']])
  assert.deepEqual(d.rows.filter(x => x.kind === 'del').map(x => [x.old, x.text]), [[2, 'two']])

  assert.equal(await computeFileDiff(dir, base, 'untouched.ts'), null, 'a file the run did not change is not diffed')
  assert.equal(await computeFileDiff(dir, base, '--output=/tmp/x'), null, 'nor anything that is not a changed path')
  assert.equal(await computeFileDiff(undefined, base, 'src/a.ts'), null, 'no checkout, no diff')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log("ok - a changed file opens as a diff, and only a changed file")
