import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * As `git`, but WITHOUT trimming. Required for any format whose leading
 * whitespace is significant - `status --porcelain` above all, whose lines are
 * `XY<space><path>`: for an unstaged modification X is a literal space, so
 * `.trim()` silently eats the first line's status column and every offset
 * computed from it is off by one. It corrupts only the FIRST line, which is
 * what makes it so easy to miss - the rest of the list parses perfectly.
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

/** What `computeFixFacts` can prove straight from git, in the run's project
 *  directory. Deliberately NOT `pr` — a pull request is a GitHub construct
 *  no git command can produce, so the caller (runArtifacts.ts) is the one
 *  that may carry an agent-reported `pr` forward for a matching repo. */
export interface ComputedFix {
  repo: string
  commits: string[]
  files_changed: number
  lines_changed: number
}

/**
 * `git remote get-url origin` in any of its usual shapes
 * (`git@host:owner/repo.git`, `https://host/owner/repo.git`,
 * `https://host/owner/repo`, even a bare local path used as a remote in a
 * test) down to `owner/repo` — the shape the bundle schema's `repo` pattern
 * (`^[^/]+/[^/]+$`) requires. Takes the last two `/`- or `:`-delimited
 * segments; returns null if there aren't two.
 */
function parseOwnerRepo(remoteUrl: string): string | null {
  const cleaned = remoteUrl.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = cleaned.split(/[/:]/).filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[parts.length - 2]
  const repo = parts[parts.length - 1]
  if (!owner || !repo) return null
  return `${owner}/${repo}`
}

/**
 * Captures `projectDir`'s HEAD sha at the instant a run starts — the ONLY
 * honest definition of "what this run's own work looks like" on a
 * long-lived branch. Called once, by `startRun` (workflowRunner.ts), before
 * any step has run; the resulting sha is persisted on the run itself
 * (`WorkflowRun.baseCommit`) as runner-owned provenance, exactly like
 * `watch` and `identity` — an agent has no channel to influence it.
 *
 * Returns `undefined` — never a guess — when there is nothing to capture:
 * `projectDir` absent, not inside a git working tree, or an unborn HEAD (a
 * freshly initialised repo with no commits yet, where `rev-parse HEAD`
 * itself fails). `computeFixFacts` treats an undefined baseline the same
 * way it treats every other "cannot compute" precondition: emit nothing,
 * never fall back to a branch's default base.
 */
export async function captureBaseline(projectDir: string | undefined): Promise<string | undefined> {
  if (!projectDir) return undefined
  try {
    const inside = await git(projectDir, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return undefined
  } catch {
    return undefined // not a git repository
  }
  try {
    return await git(projectDir, ['rev-parse', 'HEAD'])
  } catch {
    return undefined // unborn HEAD: no commits exist yet to capture
  }
}

/**
 * Computes the facts an agent's self-report of `fix.repos` / `files_changed`
 * / `lines_changed` cannot be trusted for, straight from git, in
 * `projectDir` — measured against `baseCommit`, the sha `captureBaseline`
 * recorded when THIS run started, never against a branch's default base
 * (`main`/`origin/HEAD`). Diffing against `main` was the defect this
 * function used to have: on any long-lived branch, every commit the branch
 * ever made — not just this run's — reads as "ahead of main", so a run that
 * made zero commits could still attest to someone else's entire history.
 * Diffing against the run's own recorded starting point cannot make that
 * mistake, because the baseline moves with the run instead of sitting fixed
 * at a distant, shared ancestor.
 *
 * Returns `null` — never a guess, never a partial result — when any
 * precondition isn't met:
 *   - `projectDir` absent, or not inside a git working tree at all
 *   - `baseCommit` absent (see `captureBaseline`'s doc comment for why: an
 *     older run with no recorded baseline, a project dir that was not a git
 *     repo at start, an unborn HEAD at start) — this is the one precondition
 *     with NO fallback. Falling back to `main` here would silently
 *     reintroduce the exact fabrication this function exists to prevent.
 *   - `baseCommit` no longer resolves to a real commit in this repo (e.g. a
 *     shallow clone, or history rewritten out from under it)
 *   - `baseCommit` is not an ancestor of the current `HEAD` (e.g. the
 *     project directory was rebased, or switched to an unrelated branch,
 *     between run start and now) — diffing across unrelated history would
 *     attribute someone else's commits to this run, the same class of
 *     mistake diffing against `main` made
 *   - the branch has produced no commits since `baseCommit` (the run made
 *     no commits — a real and legitimate outcome, not an error)
 *   - `origin` has no remote URL to name the repo from
 * The caller (runArtifacts.ts's finalizeRunArtifacts) treats `null` the same
 * way it already treats a missing artifact file: the field stays absent and
 * validation rejects the bundle, rather than falling back to what an agent
 * wrote into meta.json.
 */
export async function computeFixFacts(
  projectDir: string | undefined,
  baseCommit: string | undefined,
): Promise<ComputedFix | null> {
  if (!projectDir || !baseCommit) return null

  try {
    const inside = await git(projectDir, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return null
  } catch {
    return null // not a git repository
  }

  try {
    await git(projectDir, ['cat-file', '-e', `${baseCommit}^{commit}`])
  } catch {
    return null // the recorded baseline no longer resolves in this repo
  }

  try {
    await git(projectDir, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'])
  } catch {
    return null // baseline is not an ancestor of HEAD: unrelated history, don't guess
  }

  let commitsRaw: string
  try {
    commitsRaw = await git(
      projectDir,
      ['rev-list', '--reverse', '--abbrev-commit', '--abbrev=12', `${baseCommit}..HEAD`],
    )
  } catch {
    return null
  }
  const commits = commitsRaw.split('\n').map(s => s.trim()).filter(Boolean)
  if (commits.length === 0) return null // the run produced no commits

  let remoteUrl: string
  try {
    remoteUrl = await git(projectDir, ['remote', 'get-url', 'origin'])
  } catch {
    return null // no origin remote to name the repo from
  }
  const repo = parseOwnerRepo(remoteUrl)
  if (!repo) return null

  let numstat: string
  try {
    numstat = await git(projectDir, ['diff', '--numstat', `${baseCommit}..HEAD`])
  } catch {
    return null
  }
  let linesChanged = 0
  const files = numstat.split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of files) {
    const [added, removed] = line.split('\t')
    const a = Number(added)
    const r = Number(removed)
    // Binary files report "-" for both columns — they still count as a
    // changed file (below) but contribute no line count, since there is
    // none to report honestly.
    if (Number.isFinite(a)) linesChanged += a
    if (Number.isFinite(r)) linesChanged += r
  }

  return { repo, commits, files_changed: files.length, lines_changed: linesChanged }
}

/**
 * The paths already modified, staged, or untracked in `projectDir` at the
 * instant a run starts — i.e. work that exists BEFORE this run and must not
 * be attributed to it.
 *
 * Why this is worth a function of its own: `computeFixFacts` measures
 * `baseCommit..HEAD`, so uncommitted changes cannot inflate its numbers
 * directly. The leak is one step later. If any step in the pipeline runs a
 * broad `git commit -a`, every pre-existing change in the tree is swept into
 * the run's own commit and from that moment IS counted, honestly and
 * irreversibly, as the run's work.
 *
 * This is not hypothetical. Run f7ccb4b2's intake step — holding only
 * [Read, Grep, Glob, Write] — followed instructions addressed to later
 * stages and wrote the whole ticket's implementation into
 * alepo-dev-team-infra: a bats suite, a compose profile, and a README
 * runbook. It then died on turn exhaustion, leaving 78 uncommitted lines
 * behind. The next run started on top of them, so its oracle stage faced a
 * repository where the capability it was supposed to prove missing was
 * already present.
 *
 * Returns `null` when there is nothing to measure (no `projectDir`, or not a
 * git working tree) — the same "say nothing rather than guess" contract the
 * rest of this module keeps. An empty array means a genuinely clean tree.
 */
export async function workingTreeDirty(projectDir: string | undefined): Promise<string[] | null> {
  if (!projectDir) return null
  try {
    const inside = await git(projectDir, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return null
  } catch {
    return null // not a git repository
  }
  try {
    // --porcelain is the stable, script-facing format; -uall lists files
    // inside untracked directories rather than collapsing them to "dir/",
    // which would under-report a whole tree of new files as one entry.
    // -z delimits with NUL and, crucially, leaves paths UNQUOTED - without it
    // git wraps any path containing a space or non-ASCII byte in quotes with
    // escapes, so an ordinary "my file.yml" is reported under a name that
    // matches nothing on disk.
    const out = await gitRaw(projectDir, ['status', '--porcelain', '-uall', '-z'])
    const entries = out.split('\0').filter(Boolean)
    const paths: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      // Each record is `XY<space><path>`; the status column is exactly two
      // bytes, so the path begins at offset 3 - no trimming, which would
      // corrupt a path legitimately ending in whitespace.
      const status = entry.slice(0, 2)
      paths.push(entry.slice(3))
      // A rename/copy record is followed by a SECOND NUL-delimited field
      // holding the ORIGIN path. Consume it, or it is read as the next status
      // record and reported as a separate file missing its first 3 characters.
      if (status[0] === 'R' || status[0] === 'C') i++
    }
    return paths
  } catch {
    return null
  }
}
