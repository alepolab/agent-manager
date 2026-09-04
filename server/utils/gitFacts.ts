import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return stdout.trim()
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
 * The ref this branch is diffed against — "the branch point" the brief asks
 * for. Prefers the remote's recorded default branch (`origin/HEAD`, when a
 * local clone has it set up); falls back to the first of the usual default
 * branch names that actually resolves. Returns null when none of them do —
 * there is then no branch point to diff against, and the caller must treat
 * that the same as "cannot compute", not guess at one.
 */
async function resolveBaseRef(cwd: string): Promise<string | null> {
  try {
    const ref = await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref
  } catch { /* origin/HEAD isn't recorded locally - common on a fresh or shallow clone */ }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
      return candidate
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * Computes the facts an agent's self-report of `fix.repos` / `files_changed`
 * / `lines_changed` cannot be trusted for, straight from git, in
 * `projectDir`. Returns `null` — never a guess, never a partial result —
 * when any precondition isn't met:
 *   - `projectDir` absent, or not inside a git working tree at all
 *   - HEAD is detached (no branch name, so no branch point to diff against)
 *   - no base ref resolves (no origin/HEAD, no main/master anywhere)
 *   - HEAD and the base ref share no merge base
 *   - the branch has produced no commits ahead of its base (the run made no
 *     commits — a real and legitimate outcome, not an error)
 *   - `origin` has no remote URL to name the repo from
 * The caller (runArtifacts.ts's finalizeRunArtifacts) treats `null` the same
 * way it already treats a missing artifact file: the field stays absent and
 * validation rejects the bundle, rather than falling back to what an agent
 * wrote into meta.json.
 */
export async function computeFixFacts(projectDir: string | undefined): Promise<ComputedFix | null> {
  if (!projectDir) return null

  try {
    const inside = await git(projectDir, ['rev-parse', '--is-inside-work-tree'])
    if (inside !== 'true') return null
  } catch {
    return null // not a git repository
  }

  let branch: string
  try {
    branch = await git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    return null
  }
  if (!branch || branch === 'HEAD') return null // detached HEAD: no branch to diff against

  const baseRef = await resolveBaseRef(projectDir)
  if (!baseRef) return null

  let mergeBase: string
  try {
    mergeBase = await git(projectDir, ['merge-base', 'HEAD', baseRef])
  } catch {
    return null // HEAD and baseRef share no common history
  }

  let commitsRaw: string
  try {
    commitsRaw = await git(
      projectDir,
      ['rev-list', '--reverse', '--abbrev-commit', '--abbrev=12', `${mergeBase}..HEAD`],
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
    numstat = await git(projectDir, ['diff', '--numstat', `${mergeBase}..HEAD`])
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
