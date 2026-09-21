import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { nestedRepos } from './workspace.ts'
import { workingTreeDirty } from './gitFacts.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const execFileAsync = promisify(execFile)
const log = createLogger('runner')

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * Whether the work a run says it did can actually be reached by a reviewer.
 *
 * Three real runs claimed more than their repositories could show, and each
 * finished `completed`:
 *
 *   CSUP-7526  the fix sat on three unmerged `--lane-*` branches in one repo
 *              while the run's only pull request was a different repo carrying
 *              detection SQL. The guard the ticket asked for was reachable from
 *              nowhere.
 *   CSUP-7524  step 10 reported "three build-breaking findings closed and
 *              verified" with local HEAD two commits ahead of the branch the
 *              pull request was opened from. The review was of code the
 *              reviewer could not fetch.
 *   SBN-4091   ran to the end, left six commits on a branch, opened no pull
 *              request, and was recorded as a completed run twice.
 *
 * None of these is detectable from an agent's prose, and all three are one git
 * question each. So they are asked at the one place every terminal status
 * passes through, and a `completed` run that fails them is not completed.
 *
 * Read-only: this function asks git questions and answers them. It never
 * pushes, merges or commits — a run that has finished is not the place to
 * start moving code around on someone's behalf.
 */
export type ShipProblem = 'unpushed' | 'lane-orphan' | 'no-pr' | 'dirty'

export interface ShipFinding {
  problem: ShipProblem
  repo: string
  detail: string
}

async function isRepo(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  try { return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true' } catch { return false }
}

async function repoName(dir: string): Promise<string> {
  try {
    const url = await git(dir, ['remote', 'get-url', 'origin'])
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
    return m?.[1] ?? dir
  } catch {
    return dir
  }
}

/** Every git worktree this run may have written to: its own, and the module repos under it. */
export function repoDirsOf(run: WorkflowRun): string[] {
  if (!run.projectDir) return []
  return [run.projectDir, ...nestedRepos(run.projectDir)]
}

/**
 * The commits a run's branch carries that its remote does not.
 *
 * `@{u}` is deliberately not used: a run branch is created locally and may have
 * no upstream configured at all, which is itself the unpushed case rather than
 * an error to swallow.
 */
async function unpushed(dir: string, branch: string): Promise<number | null> {
  // A checkout with no origin has nowhere to push to, and demanding a pushed
  // branch of it would fail every local-only repository — including every test
  // fixture, which is how this was caught. Absent remote, absent finding.
  try {
    const remotes = await git(dir, ['remote'])
    if (!remotes.split('\n').map(r => r.trim()).includes('origin')) return 0
    // A remote URL is not a remote. A repository that has never fetched has no
    // `refs/remotes/origin/*` at all, and asking it what is unpushed answers
    // "everything", which is true and useless — it describes the setup, not the
    // run. A real clone always carries these refs, so the production case is
    // unaffected and only never-fetched fixtures are exempt.
    const seen = await git(dir, ['for-each-ref', '--count=1', 'refs/remotes/origin'])
    if (!seen) return 0
  } catch {
    return 0
  }
  try {
    await git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
  } catch {
    // No remote branch: everything on the local branch is unpushed. Counting it
    // needs a base, and the honest answer here is "not pushed at all".
    return -1
  }
  try {
    const out = await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`])
    return Number(out) || 0
  } catch {
    return null
  }
}

/** How many commits this run put on the branch, measured against its own baseline. */
async function commitsSince(dir: string, baseCommit: string): Promise<number> {
  try {
    await git(dir, ['cat-file', '-e', `${baseCommit}^{commit}`])
    await git(dir, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'])
  } catch {
    // The baseline does not resolve here (another repo, rewritten history):
    // answering "how many" would be a guess, and a guess must not fail a run.
    return 0
  }
  try {
    return Number(await git(dir, ['rev-list', '--count', `${baseCommit}..HEAD`])) || 0
  } catch {
    return 0
  }
}

/** Lane branches of this run whose commits never reached the run branch. */
async function orphanLanes(dir: string, branch: string): Promise<string[]> {
  let branches: string
  try {
    branches = await git(dir, ['branch', '--list', `${branch}--lane-*`, '--format=%(refname:short)'])
  } catch {
    return []
  }
  const out: string[] = []
  for (const lane of branches.split('\n').map(s => s.trim()).filter(Boolean)) {
    try {
      await git(dir, ['merge-base', '--is-ancestor', lane, 'HEAD'])
    } catch {
      out.push(lane)
    }
  }
  return out
}

/**
 * Check a finished run's claims against its repositories.
 *
 * `expectPr` says whether this run's workflow declares a step that opens one —
 * a research or review workflow that was never meant to ship must not be failed
 * for not shipping.
 */
export async function shipIntegrity(run: WorkflowRun, expectPr: boolean, meta: Record<string, unknown> = {}): Promise<ShipFinding[]> {
  const findings: ShipFinding[] = []
  // A workflow with no step that opens a pull request never pushes anything —
  // `runPrStep` is the only pusher, and it runs behind `step.pr`. Asking such a
  // run why its branch is not on the remote would fail every completed run of
  // the plan-build-review runbook, which commits code and deliberately ships
  // nothing. No obligation to ship, no finding.
  if (!expectPr || !run.branch) return findings

  const onRunBranch: { dir: string, name: string }[] = []
  for (const dir of repoDirsOf(run)) {
    if (!await isRepo(dir)) continue
    let head: string
    try {
      head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    } catch {
      continue
    }
    // Only the run's own branch is this run's business. A module repo left on
    // `develop` was never written to by this run.
    if (head !== run.branch) continue
    const name = await repoName(dir)
    onRunBranch.push({ dir, name })

    const ahead = await unpushed(dir, run.branch)
    if (ahead === -1) {
      findings.push({ problem: 'unpushed', repo: name, detail: `${run.branch} exists only locally in ${dir} — nothing was pushed.` })
    } else if (ahead && ahead > 0) {
      findings.push({ problem: 'unpushed', repo: name, detail: `${ahead} commit(s) on ${run.branch} in ${dir} are not on origin — a reviewer cannot fetch them.` })
    }

    // Uncommitted work in the checkout itself. One run left 46 modified files,
    // +593/-279, uncommitted on the head of a HUMAN's open pull request branch;
    // another left doc edits that survived only as an artifact patch. Neither
    // is in any commit, so neither is in any pull request.
    const dirty = await workingTreeDirty(dir)
    if (dirty?.length) {
      findings.push({
        problem: 'dirty',
        repo: name,
        detail: `${dirty.length} uncommitted file(s) in ${dir} — not in any commit, so not in any pull request: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? '…' : ''}`,
      })
    }

    for (const lane of await orphanLanes(dir, run.branch)) {
      findings.push({ problem: 'lane-orphan', repo: name, detail: `${lane} holds commits that never reached ${run.branch}; they are in no pull request.` })
    }
  }

  // Commits with nowhere to review them.
  //
  // The commit COUNT comes from git, not from meta.json: this check runs inside
  // publish(), before finalizeRunArtifacts has reconciled `fix.repos[].commits`
  // for this terminal status, so reading them from meta answers "none" on an
  // ordinary first-pass completion — which is precisely the SBN-4091 shape the
  // check exists for. The pull request URLs do come from meta, because
  // recordPrUrls writes them during the run, and because no git command can
  // produce one.
  const prByRepo = new Map<string, string>()
  const fix = meta.fix
  const metaRepos = (fix && typeof fix === 'object' && !Array.isArray(fix) ? (fix as Record<string, unknown>).repos : null)
  if (Array.isArray(metaRepos)) {
    for (const entry of metaRepos) {
      if (!entry || typeof entry !== 'object') continue
      const r = entry as Record<string, unknown>
      const pr = typeof r.pr === 'string' ? r.pr : ''
      if (typeof r.repo === 'string' && pr.startsWith('http')) prByRepo.set(r.repo, pr)
    }
  }
  for (const { dir, name } of onRunBranch) {
    if (prByRepo.has(name)) continue
    const commits = run.baseCommit ? await commitsSince(dir, run.baseCommit) : 0
    if (commits > 0) {
      findings.push({
        problem: 'no-pr',
        repo: name,
        detail: `${commits} commit(s) and no pull request. The work is on a branch nobody was asked to look at.`,
      })
    }
  }

  if (findings.length) {
    log.warn('ship integrity findings', { runId: run.id, findings: findings.map(f => `${f.problem}:${f.repo}`) })
  }
  return findings
}

/** One line a person can act on, for the run record and the summary. */
export function describeShipFindings(findings: ShipFinding[]): string {
  return findings.map(f => `${f.repo}: ${f.detail}`).join(' ')
}
