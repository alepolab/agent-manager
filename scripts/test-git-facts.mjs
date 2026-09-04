/**
 * Self-check for server/utils/gitFacts.ts — the module that computes
 * `fix.repos` / `files_changed` / `lines_changed` straight from git instead
 * of trusting an agent's self-report. Every scenario runs against a REAL
 * temporary git repository this script creates and commits into: no
 * mocked git, no stubbed child_process. Where this script needs a ground
 * truth to compare against (line counts, commit counts) it asks git for it
 * independently, rather than hand-computing expected numbers that could
 * silently drift from what git itself would say.
 *
 *   node scripts/test-git-facts.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { computeFixFacts } = await import('../server/utils/gitFacts.ts')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitfacts-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

// ── 1. Not a git repository at all ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'gitfacts-notgit-'))
  const result = await computeFixFacts(dir)
  assert.equal(result, null, 'a non-git directory yields null, never a guess')
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. projectDir absent entirely ──────────────────────────────────────────
{
  const result = await computeFixFacts(undefined)
  assert.equal(result, null, 'no project directory at all yields null')
}

// ── 3. A branch with zero commits ahead of its base yields null ───────────
// (main, freshly initialised, with an origin set — HEAD IS the base ref, so
// there is nothing "actually created during the run" to report.)
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  const result = await computeFixFacts(dir)
  assert.equal(result, null, 'a branch identical to its base (no commits ahead) yields null, not a fabricated diff')
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. The real, expected case: a feature branch with real commits ────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'git@github.com:alepolab/ocs_cpp14.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/SA-1203'])
  // One file edited (line 2 changed), one file added.
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2-changed\nline3\n')
  writeFileSync(join(dir, 'b.txt'), 'new file\nsecond line\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'fix the AVP loop bound'])
  appendFileSync(join(dir, 'a.txt'), 'line4\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'add a trailing line'])

  const result = await computeFixFacts(dir)
  assert.ok(result, 'a feature branch with real commits ahead of main computes facts')
  assert.equal(result.repo, 'alepolab/ocs_cpp14', 'the SSH remote URL is parsed down to owner/repo')

  // Ground truth from git itself, not hand-computed.
  const expectedCommits = git(dir, ['rev-list', 'main..HEAD']).split('\n').filter(Boolean)
  assert.equal(result.commits.length, expectedCommits.length, 'one entry per commit actually made on the branch')
  assert.ok(result.commits.every(c => /^[0-9a-f]{7,}$/.test(c)), 'every commit sha is a real hex sha, long enough for the schema minLength')

  const numstat = git(dir, ['diff', '--numstat', 'main..HEAD']).split('\n').filter(Boolean)
  let expectedLines = 0
  for (const line of numstat) {
    const [added, removed] = line.split('\t')
    expectedLines += (Number(added) || 0) + (Number(removed) || 0)
  }
  assert.equal(result.files_changed, numstat.length, 'files_changed matches the number of files git reports changed')
  assert.equal(result.lines_changed, expectedLines, 'lines_changed matches added+removed straight from git diff --numstat')
  assert.ok(result.files_changed >= 2, 'both the edited and the added file are counted')

  rmSync(dir, { recursive: true, force: true })
}

// ── 5. Detached HEAD yields null — there is no branch to diff ─────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/x'])
  writeFileSync(join(dir, 'c.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit'])
  const sha = git(dir, ['rev-parse', 'HEAD'])
  git(dir, ['checkout', '-q', sha]) // detach
  const result = await computeFixFacts(dir)
  assert.equal(result, null, 'a detached HEAD yields null, not a guessed branch point')
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. No origin remote at all yields null — nothing to name the repo from ─
{
  const dir = initRepo()
  git(dir, ['checkout', '-q', '-b', 'feature/no-origin'])
  writeFileSync(join(dir, 'd.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit with no origin configured'])
  const result = await computeFixFacts(dir)
  assert.equal(result, null, 'no origin remote yields null rather than an unnamed repo')
  rmSync(dir, { recursive: true, force: true })
}

// ── 7. A local-path origin (test-shaped, not a real GitHub URL) still
//    parses down to two segments — the schema only requires the SHAPE
//    owner/repo, not a real GitHub identity. ─────────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', join(tmpdir(), 'some-org', 'some-repo')])
  git(dir, ['checkout', '-q', '-b', 'feature/local-origin'])
  writeFileSync(join(dir, 'e.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit'])
  const result = await computeFixFacts(dir)
  assert.ok(result, 'a local-path origin still yields a result')
  assert.match(result.repo, /^[^/]+\/[^/]+$/, 'the parsed repo matches the schema pattern owner/repo')
  assert.equal(result.repo, 'some-org/some-repo')
  rmSync(dir, { recursive: true, force: true })
}

console.log('git facts: all checks passed')
