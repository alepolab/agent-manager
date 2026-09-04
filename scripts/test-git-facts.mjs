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

const { computeFixFacts, captureBaseline } = await import('../server/utils/gitFacts.ts')

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
  assert.equal(await captureBaseline(dir), undefined, 'a non-git directory yields no baseline')
  const result = await computeFixFacts(dir, 'deadbeef')
  assert.equal(result, null, 'a non-git directory yields null, never a guess')
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. projectDir absent entirely ──────────────────────────────────────────
{
  assert.equal(await captureBaseline(undefined), undefined, 'no project directory yields no baseline')
  const result = await computeFixFacts(undefined, 'deadbeef')
  assert.equal(result, null, 'no project directory at all yields null')
}

// ── 3. No baseline recorded at all — the field is simply absent (an older
//    run, or a projectDir that was never a git repo at start). Must NOT
//    fall back to main or any other guessed base. ──────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/no-baseline'])
  writeFileSync(join(dir, 'z.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit made after this run started, but with no baseline recorded'])
  const result = await computeFixFacts(dir, undefined)
  assert.equal(result, null, 'an absent baseline yields null even though the branch clearly has commits ahead of main')
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. THE regression this fix exists for: a repo with real pre-existing
//    history on its branch BEFORE the run starts (unlike every other repo
//    in this script, which is fresh). Capturing the baseline at that point
//    and making no new commits must report nothing — not the branch's
//    entire prior history. ──────────────────────────────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'git@github.com:alepolab/alepo-dev-team-infra.git'])
  git(dir, ['checkout', '-q', '-b', 'develop'])
  // Pre-existing history on the branch, well ahead of main — exactly the
  // shape of a real long-lived branch (e.g. develop) diffing against `main`
  // used to misreport wholesale as "this run's commits".
  for (let i = 0; i < 5; i += 1) {
    appendFileSync(join(dir, 'a.txt'), `pre-existing line ${i}\n`)
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', `pre-existing commit ${i}`])
  }
  const preExistingAheadOfMain = git(dir, ['rev-list', 'main..HEAD']).split('\n').filter(Boolean)
  assert.equal(preExistingAheadOfMain.length, 5, 'sanity: the branch really is 5 commits ahead of main before the run starts')

  // The run starts NOW: capture the baseline at the branch's current tip.
  const baseline = await captureBaseline(dir)
  assert.equal(baseline, git(dir, ['rev-parse', 'HEAD']), 'the baseline is the branch tip at the moment it is captured')

  // 4a. The run halts here — no commits made, working tree clean. This is
  // the exact DEVOPS-15 scenario: a real repo, a long-lived branch with real
  // prior history, and a run that did nothing.
  {
    const result = await computeFixFacts(dir, baseline)
    assert.equal(result, null,
      'a run that made no commits since its OWN baseline reports null, even though the branch is 5 commits ahead of main')
  }

  // 4b. The run then makes exactly ONE commit. Only that commit — not the 5
  // pre-existing ones — must be attributed to it.
  {
    writeFileSync(join(dir, 'b.txt'), 'the one thing this run actually did\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'the only commit this run made'])
    const thisRunsSha = git(dir, ['rev-parse', 'HEAD'])

    const result = await computeFixFacts(dir, baseline)
    assert.ok(result, 'the one real commit since the baseline computes facts')
    assert.equal(result.commits.length, 1, 'exactly one commit is attributed — not the 5 pre-existing ones')
    assert.ok(thisRunsSha.startsWith(result.commits[0]),
      'the attributed commit is the one made after the baseline, not one of the pre-existing five')
    assert.equal(result.repo, 'alepolab/alepo-dev-team-infra')
    assert.equal(result.files_changed, 1, 'only the file touched by the new commit is counted')
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── 5. The real, expected case: a feature branch with real commits, and no
//    prior history before the baseline (baseline == the branch's own
//    starting point == the pre-run initial commit). ────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'git@github.com:alepolab/ocs_cpp14.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/SA-1203'])
  const baseline = await captureBaseline(dir)
  // One file edited (line 2 changed), one file added.
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2-changed\nline3\n')
  writeFileSync(join(dir, 'b.txt'), 'new file\nsecond line\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'fix the AVP loop bound'])
  appendFileSync(join(dir, 'a.txt'), 'line4\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'add a trailing line'])

  const result = await computeFixFacts(dir, baseline)
  assert.ok(result, 'a feature branch with real commits ahead of its own baseline computes facts')
  assert.equal(result.repo, 'alepolab/ocs_cpp14', 'the SSH remote URL is parsed down to owner/repo')

  // Ground truth from git itself, not hand-computed.
  const expectedCommits = git(dir, ['rev-list', `${baseline}..HEAD`]).split('\n').filter(Boolean)
  assert.equal(result.commits.length, expectedCommits.length, 'one entry per commit actually made on the branch')
  assert.ok(result.commits.every(c => /^[0-9a-f]{7,}$/.test(c)), 'every commit sha is a real hex sha, long enough for the schema minLength')

  const numstat = git(dir, ['diff', '--numstat', `${baseline}..HEAD`]).split('\n').filter(Boolean)
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

// ── 6. A branch identical to its OWN baseline (no commits since the run
//    started) yields null, not a fabricated diff. ──────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  const baseline = await captureBaseline(dir)
  const result = await computeFixFacts(dir, baseline)
  assert.equal(result, null, 'HEAD identical to the recorded baseline (no commits since) yields null')
  rmSync(dir, { recursive: true, force: true })
}

// ── 7. A baseline that no longer resolves in this repo (e.g. a shallow
//    clone, or a sha from an entirely different repository) yields null. ───
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/bad-baseline'])
  writeFileSync(join(dir, 'z.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit'])
  const result = await computeFixFacts(dir, '0'.repeat(40))
  assert.equal(result, null, 'a baseline sha that does not resolve in this repo yields null, never a guess')
  rmSync(dir, { recursive: true, force: true })
}

// ── 8. A baseline that resolves but is NOT an ancestor of HEAD (e.g. the
//    project directory switched to an unrelated branch after the run
//    started) yields null rather than diffing across unrelated history. ────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  // A baseline captured on one line of history...
  git(dir, ['checkout', '-q', '-b', 'branch-a'])
  writeFileSync(join(dir, 'a.txt'), 'branch a content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'branch a commit'])
  const baselineOnBranchA = await captureBaseline(dir)
  // ...then HEAD moves to a sibling branch that shares only the ORIGINAL
  // root commit, not baselineOnBranchA itself.
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['checkout', '-q', '-b', 'branch-b'])
  writeFileSync(join(dir, 'b.txt'), 'branch b content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'branch b commit'])
  const result = await computeFixFacts(dir, baselineOnBranchA)
  assert.equal(result, null, 'a baseline that is not an ancestor of the current HEAD yields null, not a cross-branch guess')
  rmSync(dir, { recursive: true, force: true })
}

// ── 9. Detached HEAD after the baseline was captured still computes facts
//    correctly — the baseline is a literal sha, not a branch name, so there
//    is no branch-name dependency left to break. ───────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/alepolab/test-repo.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/detached'])
  const baseline = await captureBaseline(dir)
  writeFileSync(join(dir, 'c.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit'])
  const sha = git(dir, ['rev-parse', 'HEAD'])
  git(dir, ['checkout', '-q', sha]) // detach
  const result = await computeFixFacts(dir, baseline)
  assert.ok(result, 'a detached HEAD still computes facts against a literal baseline sha')
  assert.equal(result.commits.length, 1)
  rmSync(dir, { recursive: true, force: true })
}

// ── 10. No origin remote at all yields null — nothing to name the repo from
{
  const dir = initRepo()
  git(dir, ['checkout', '-q', '-b', 'feature/no-origin'])
  const baseline = await captureBaseline(dir)
  writeFileSync(join(dir, 'd.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit with no origin configured'])
  const result = await computeFixFacts(dir, baseline)
  assert.equal(result, null, 'no origin remote yields null rather than an unnamed repo')
  rmSync(dir, { recursive: true, force: true })
}

// ── 11. A local-path origin (test-shaped, not a real GitHub URL) still
//    parses down to two segments — the schema only requires the SHAPE
//    owner/repo, not a real GitHub identity. ─────────────────────────────
{
  const dir = initRepo()
  git(dir, ['remote', 'add', 'origin', join(tmpdir(), 'some-org', 'some-repo')])
  git(dir, ['checkout', '-q', '-b', 'feature/local-origin'])
  const baseline = await captureBaseline(dir)
  writeFileSync(join(dir, 'e.txt'), 'content\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'a commit'])
  const result = await computeFixFacts(dir, baseline)
  assert.ok(result, 'a local-path origin still yields a result')
  assert.match(result.repo, /^[^/]+\/[^/]+$/, 'the parsed repo matches the schema pattern owner/repo')
  assert.equal(result.repo, 'some-org/some-repo')
  rmSync(dir, { recursive: true, force: true })
}

// ── 12. An unborn repo (no commits at all yet) yields no baseline ──────────
{
  const dir = mkdtempSync(join(tmpdir(), 'gitfacts-unborn-'))
  git(dir, ['init', '-q', '-b', 'main'])
  const baseline = await captureBaseline(dir)
  assert.equal(baseline, undefined, 'a repo with no commits yet (unborn HEAD) yields no baseline to capture')
  rmSync(dir, { recursive: true, force: true })
}

console.log('git facts: all checks passed')
