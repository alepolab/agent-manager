/**
 * The runner pushes the run's branch and opens the pull request.
 *
 * This exists because nothing else did it. A run committed a 286-line CRM gate
 * and 170 lines of documentation, its final step - labelled "Evidence, Docs &
 * Pull Request" - reported success, and there was no pull request: that step's
 * agent curates documentation, and no agent in the estate opens a PR at all.
 * The branches sat unpushed while the ticket received a comment saying the work
 * was done. The template's own comment claimed the step "pushes the branch and
 * opens a pull request", which nothing implemented.
 *
 * So it belongs here, beside the Jira calls, for the same reason those are
 * runner-owned: a pull request URL is a fact a reviewer acts on, and a fact an
 * agent reports in prose is a fact nobody can check. `meta.fix.repos[].pr` is
 * read by the run page and by the outcome comment; only this module writes it.
 *
 * WHICH repositories, and why not `computeFixFacts`: that function measures
 * `run.projectDir` alone, which is correct for counting a run's diff and wrong
 * for opening its pull requests. Run 3ebe1e6e committed the gate to a nested
 * module repository and the documentation to the parent, and its `meta.fix`
 * recorded only the parent - so a PR step built on the same seam would have
 * opened the documentation PR and silently dropped the code.
 *
 * The rule instead: a repository is this run's when its checked-out branch IS
 * the run's branch. The runner creates that branch, and its name carries the
 * run id, so commits on it are the run's by construction. A module sitting on
 * `develop` with forty commits of someone else's work is skipped, which is the
 * case that makes a branch-name check worth more than a diff count.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorkflowRun } from '../../shared/types/run.ts'
import { createLogger } from './log.ts'

// 'runner' rather than a namespace of its own: Namespace is a closed union in
// log.ts, and this is the runner doing its own work.
const log = createLogger('runner')
const execFileP = promisify(execFile)

/** Injected so the tests can describe a checkout instead of building one. */
export type ExecLike = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>

const realExec: ExecLike = async (cmd, args, opts) => {
  const { stdout } = await execFileP(cmd, args, { cwd: opts?.cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

export interface PrStepOptions {
  exec?: ExecLike
  /** Candidate directories, for tests. Discovered from the run checkout otherwise. */
  repoDirs?: string[]
}

export interface PrStepResult {
  /** One honest sentence per repository, in the order they were considered. */
  lines: string[]
  /** Only pull requests that were actually opened, or already existed. */
  prs: { repo: string, url: string }[]
}

/** `owner/repo` from any origin URL shape, or null rather than a guess. */
function parseOwnerRepo(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)
  return m?.[1] ?? null
}

/**
 * The run's own checkout plus its immediate module repositories. A super-repo
 * keeps each product module in `modules/<name>`, each its own git repository -
 * which is how one run ends up committing to two of them.
 */
function discoverRepoDirs(projectDir: string): string[] {
  const dirs = [projectDir]
  const modules = join(projectDir, 'modules')
  if (!existsSync(modules)) return dirs
  try {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(modules, entry.name, '.git'))) dirs.push(join(modules, entry.name))
    }
  } catch { /* an unreadable modules dir is not a reason to open no pull request */ }
  return dirs
}

/**
 * Push every repository that is on this run's branch and open its pull request.
 *
 * Never throws: a failure to push or to open one repository's PR is reported as
 * a sentence and leaves that repository without a URL, because the alternative
 * - a placeholder, or a swallowed error - is how a run once told a customer's
 * ticket that a pull request was ready at `https://example.invalid/pending`.
 */
export async function runPrStep(run: WorkflowRun, opts: PrStepOptions = {}): Promise<PrStepResult> {
  const exec = opts.exec ?? realExec
  const lines: string[] = []
  const prs: { repo: string, url: string }[] = []

  if (!run.branch || !run.baseBranch) {
    // Inventing either is how a run opens a pull request against the wrong
    // base and somebody merges it.
    lines.push(`No pull request: this run has no ${!run.branch ? 'branch' : 'base branch'} recorded, and neither is safe to guess.`)
    return { lines, prs }
  }
  if (!run.projectDir) {
    lines.push('No pull request: this run has no checkout to push from.')
    return { lines, prs }
  }

  const dirs = opts.repoDirs ?? discoverRepoDirs(run.projectDir)

  for (const dir of dirs) {
    let branch: string
    try {
      branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    } catch {
      continue // not a git repository; nothing to say about it
    }
    if (branch !== run.branch) continue // someone else's branch, someone else's work

    let repo = dir
    try {
      const url = await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir })
      repo = parseOwnerRepo(url) ?? dir
    } catch {
      lines.push(`${dir}: no origin remote, so there is nowhere to open a pull request.`)
      continue
    }

    let ahead = 0
    try {
      ahead = Number(await exec('git', ['rev-list', '--count', `origin/${run.baseBranch}..HEAD`], { cwd: dir })) || 0
    } catch {
      // An unknown base on the remote is worth saying out loud; the push below
      // would fail anyway and the reason would be less clear.
      lines.push(`${repo}: cannot compare against origin/${run.baseBranch}, so no pull request was opened.`)
      continue
    }
    if (ahead === 0) {
      lines.push(`${repo}: no commits on ${run.branch} beyond origin/${run.baseBranch}; no pull request opened.`)
      continue
    }

    try {
      await exec('git', ['push', '--set-upstream', 'origin', `${run.branch}:refs/heads/${run.branch}`], { cwd: dir })
    } catch (err) {
      lines.push(`${repo}: push of ${run.branch} failed, so no pull request was opened - ${message(err)}`)
      continue
    }

    const title = `${run.ticketKey ? `${run.ticketKey}: ` : ''}${firstLine(run.initialPrompt) || run.branch}`
    const body = prBody(run, repo, ahead)
    try {
      const out = await exec('gh', [
        'pr', 'create',
        '--base', run.baseBranch,
        '--head', run.branch,
        '--title', title,
        '--body', body,
      ], { cwd: dir })
      const url = firstUrl(out)
      if (!url) {
        lines.push(`${repo}: gh reported no pull request URL, so none is recorded.`)
        continue
      }
      prs.push({ repo, url })
      lines.push(`${repo}: opened ${url} (${ahead} commit${ahead === 1 ? '' : 's'} into ${run.baseBranch}).`)
    } catch (err) {
      // A branch that already has a PR is the common case on a restart: ask gh
      // for the existing one rather than reporting a failure a reviewer cannot act on.
      const existing = await exec('gh', ['pr', 'view', run.branch, '--json', 'url', '-q', '.url'], { cwd: dir }).catch(() => '')
      const url = firstUrl(existing)
      if (url) {
        prs.push({ repo, url })
        lines.push(`${repo}: pull request already open at ${url}; pushed ${ahead} commit${ahead === 1 ? '' : 's'} to it.`)
      } else {
        lines.push(`${repo}: branch pushed, but opening the pull request failed - ${message(err)}`)
      }
    }
  }

  if (!dirs.length) lines.push('No repositories to consider for a pull request.')
  log.info('pr step done', () => ({ runId: run.id, opened: prs.length, considered: dirs.length }))
  return { lines, prs }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 2).join(' ').trim()
const firstLine = (s: string | undefined) => (s ?? '').split('\n')[0]?.trim() ?? ''
const firstUrl = (s: string) => s.split(/\s+/).find(t => t.startsWith('http')) ?? ''

function prBody(run: WorkflowRun, repo: string, commits: number): string {
  const rows = [
    run.ticketKey && `**Ticket:** ${run.ticketKey}`,
    `**Run:** \`${run.id}\` (${run.workflowName})`,
    `**Commits:** ${commits} on \`${run.branch}\` into \`${run.baseBranch}\``,
  ].filter(Boolean).join('  \n')
  return `${firstLine(run.initialPrompt)}\n\n${rows}\n\nOpened by the pipeline runner. The evidence this run produced is attached to the ticket and kept with the run; a reviewer should read it before merging.`
}
