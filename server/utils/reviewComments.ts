/**
 * Reading the review a GitHub Actions run leaves on a pull request.
 *
 * The pipeline opens a PR and a workflow reviews it. Until now nothing read the
 * result: review comments on three real pull requests sat unanswered until a
 * person happened to look. This is the read side of closing that loop - the
 * runner collects the review into the run's own artifacts, as a runner-owned
 * fact, so a step can act on findings instead of prose nobody fetched.
 *
 * Read-only by design. Nothing here writes to GitHub, waits, or claims a
 * comment was addressed; the agent's claim to have fixed something is the diff,
 * never a sentence, and a "fixed" reply posted by the pipeline would be a claim
 * made in the reviewer's own channel.
 *
 * Three facts from the real pull requests shape this module, each of them a way
 * a naive reader lies:
 *
 *  - HUMAN COMMENTS ARE INTERLEAVED with the bot's in the same REST array
 *    (measured: 2 of 4 on liferay-extension_lbss#74, 4 of 8 on
 *    administrator_lbss#117). An agent acting on a colleague's comment as if it
 *    were the review bot's would answer a human conversation it is not part of.
 *    The login is matched EXACTLY against the REST spelling, because GraphQL
 *    reports the same account as `github-actions` with no `[bot]` suffix - one
 *    constant used against both surfaces matches nothing on one side.
 *  - AN OUTDATED COMMENT has `line: null` and only `original_line` (measured on
 *    ase_lbss#159). Trusting `line` yields null; silently substituting
 *    `original_line` reports a stale line as current. Both are carried and
 *    `lineIsCurrent` says which one it is.
 *  - THE REVIEW WORKFLOW sets `concurrency: cancel-in-progress: true`, so a
 *    push while it runs CANCELS the review. "Not finished yet" and "will never
 *    finish" are different states, and only one of them is worth waiting on -
 *    hence `terminal` on the readiness verdict.
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorkflowRun } from '../../shared/types/run.ts'
import { createLogger } from './log.ts'
import { runArtifactsDir } from './runArtifacts.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

/**
 * The REST login of the account the review workflow posts as. Exact, and
 * deliberately not shared with any GraphQL comparison: see the module header.
 */
export const REVIEW_BOT_LOGIN = 'github-actions[bot]'

/** Substrings that identify the review workflow's check among a PR's checks. */
const REVIEW_CHECK_HINTS = ['claude-review', 'code-review', 'claude code review']

export interface CheckRow { name: string, bucket?: string, state?: string, completedAt?: string }
export interface RawComment {
  id?: number
  user?: { login?: string }
  path?: string
  line?: number | null
  start_line?: number | null
  original_line?: number | null
  body?: string
  html_url?: string
  in_reply_to_id?: number
  commit_id?: string
}

export interface ReviewComment {
  id: number
  author: string
  authorIsReviewBot: boolean
  path: string
  /** The current line when the comment is live, else the line it was written against. */
  line: number | null
  startLine: number | null
  /** False when `line` came from `original_line` because the comment is outdated. */
  lineIsCurrent: boolean
  severity: string | null
  category: string | null
  title: string
  body: string
  url: string | null
  inReplyTo: number | null
}

export interface ReviewReadiness {
  check: string | null
  state: string | null
  completedAt: string | null
  ready: boolean
  /** True when this state will not become ready by waiting - a cancelled review. */
  terminal: boolean
  why: string
}

export interface ShapedComments {
  comments: ReviewComment[]
  excluded: { id: number | null, author: string, reason: string }[]
  counts: { total: number, actionable: number, humanComments: number, duplicates: number }
}

export interface ReviewCommentsArtifact {
  fetchedAt: number
  prs: {
    repo: string
    url: string
    number: number
    review: ReviewReadiness
    comments: ReviewComment[]
    counts: ShapedComments['counts']
    error?: string
  }[]
  note?: string
}

export type ChecksReader = (prUrl: string) => Promise<CheckRow[]>
export type CommentReader = (pr: { owner: string, repo: string, number: number }) => Promise<RawComment[]>

const realChecksReader: ChecksReader = async (prUrl) => {
  const { stdout } = await execFileP('gh', ['pr', 'checks', prUrl, '--json', 'name,bucket,state,completedAt'], { timeout: 30_000 })
  const parsed = JSON.parse(stdout || '[]')
  return Array.isArray(parsed) ? parsed : []
}

const realCommentReader: CommentReader = async ({ owner, repo, number }) => {
  // --paginate, because a busy PR's review exceeds one page and a truncated
  // read would look like a shorter review rather than a partial one.
  const { stdout } = await execFileP(
    'gh',
    ['api', '--paginate', `repos/${owner}/${repo}/pulls/${number}/comments`],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  )
  // --paginate concatenates JSON arrays; join them before parsing.
  const joined = stdout.replace(/\]\s*\[/g, ',')
  const parsed = JSON.parse(joined || '[]')
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Whether the review has finished, and whether waiting would ever help.
 *
 * `ready` is the ONLY thing that licenses a step to act on the comments: a
 * review still running has not said everything it is going to say, and acting
 * on half of it produces a fix for finding 1 while findings 2 and 3 arrive
 * afterwards.
 */
export function reviewReady(checks: CheckRow[]): ReviewReadiness {
  const check = checks.find(c => REVIEW_CHECK_HINTS.some(h => (c.name ?? '').toLowerCase().includes(h)))
  if (!check) {
    const names = checks.map(c => c.name).filter(Boolean)
    return {
      check: null, state: null, completedAt: null, ready: false, terminal: true,
      why: names.length
        ? `no code-review check among this PR's checks (${names.join(', ')}) - the review workflow did not run`
        : 'no checks reported on this PR at all - the review workflow did not run',
    }
  }
  const state = (check.state ?? '').toUpperCase()
  const bucket = (check.bucket ?? '').toLowerCase()
  const base = { check: check.name, state: check.state ?? null, completedAt: check.completedAt ?? null }

  if (state === 'CANCELLED' || bucket === 'cancel') {
    // cancel-in-progress: a push during the review kills it. Waiting is a hang.
    return { ...base, ready: false, terminal: true, why: `the ${check.name} check was CANCELLED - a push during the review cancels it, so no review exists for this head` }
  }
  if (bucket === 'pending' || state === 'IN_PROGRESS' || state === 'QUEUED' || state === 'PENDING') {
    return { ...base, ready: false, terminal: false, why: `the ${check.name} check is still in progress` }
  }
  if (bucket === 'pass' || state === 'SUCCESS' || state === 'NEUTRAL' || state === 'SKIPPED') {
    return { ...base, ready: true, terminal: false, why: `the ${check.name} check completed${check.completedAt ? ` at ${check.completedAt}` : ''}` }
  }
  // A failed review job still posted whatever it posted before failing, but it
  // is not a complete review and is reported as such rather than as ready.
  return { ...base, ready: false, terminal: true, why: `the ${check.name} check reported ${check.state ?? check.bucket ?? 'an unknown state'}` }
}

/** `🟡 Nit [Design] — Duplicated default risks silent divergence` -> its parts. */
function parseHeading(body: string): { severity: string | null, category: string | null, title: string } {
  const first = (body ?? '').split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
  const m = first.match(/^\S*\s*([A-Za-z]+)\s*\[([^\]]+)\]\s*[—\-–:]\s*(.+)$/)
  if (!m) return { severity: null, category: null, title: first }
  return { severity: m[1]!, category: m[2]!, title: m[3]!.trim() }
}

/**
 * The bot's distinct findings, plus an honest account of what was left out.
 *
 * Exclusions are returned rather than dropped: a PR where a human is arguing in
 * the same thread is a PR an agent should not answer alone, and the counts are
 * what tells a reader that conversation exists.
 */
export function shapeComments(raw: RawComment[]): ShapedComments {
  const comments: ReviewComment[] = []
  const excluded: ShapedComments['excluded'] = []
  const seen = new Set<number>()
  let duplicates = 0
  let humanComments = 0

  for (const c of raw ?? []) {
    const author = c.user?.login ?? ''
    if (author !== REVIEW_BOT_LOGIN) {
      humanComments++
      excluded.push({ id: c.id ?? null, author, reason: 'not-review-bot' })
      continue
    }
    const id = c.id ?? -1
    if (seen.has(id)) { duplicates++; continue }
    seen.add(id)

    const liveLine = typeof c.line === 'number' ? c.line : null
    const originalLine = typeof c.original_line === 'number' ? c.original_line : null
    const body = c.body ?? ''
    const { severity, category, title } = parseHeading(body)

    comments.push({
      id,
      author,
      authorIsReviewBot: true,
      path: c.path ?? '',
      line: liveLine ?? originalLine,
      startLine: typeof c.start_line === 'number' ? c.start_line : null,
      lineIsCurrent: liveLine !== null,
      severity,
      category,
      title,
      body,
      url: c.html_url ?? null,
      inReplyTo: typeof c.in_reply_to_id === 'number' ? c.in_reply_to_id : null,
    })
  }

  return {
    comments,
    excluded,
    counts: { total: (raw ?? []).length, actionable: comments.length, humanComments, duplicates },
  }
}

/** `https://github.com/owner/repo/pull/74` -> its parts, or null rather than a guess. */
export function parsePrUrl(url: string): { owner: string, repo: string, number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

export interface CollectOptions {
  /** The run's PR urls. Pass `prUrlsOf(run)` in production. */
  prUrls: string[]
  readChecks?: ChecksReader
  readComments?: CommentReader
}

/**
 * Collect every PR's review into `review-comments.json` in the run's artifacts.
 *
 * The file lands beside the run's other evidence - the directory the app serves
 * and the artifact header already points every agent at - rather than under
 * `steps/`, because it is INPUT to a step, not the record of one.
 *
 * A reader that throws is recorded on that PR as an `error` and never collapses
 * into an empty comment list: "the review found nothing" and "we could not read
 * the review" are opposite facts, and confusing them is how a finding gets
 * closed without being seen.
 */
export async function collectReviewComments(run: WorkflowRun, opts: CollectOptions): Promise<ReviewCommentsArtifact> {
  const readChecks = opts.readChecks ?? realChecksReader
  const readComments = opts.readComments ?? realCommentReader
  const artifact: ReviewCommentsArtifact = { fetchedAt: Date.now(), prs: [] }

  if (!opts.prUrls.length) {
    artifact.note = 'This run recorded no pull request, so there is no review to read.'
  }

  for (const url of opts.prUrls) {
    const parsed = parsePrUrl(url)
    if (!parsed) {
      artifact.prs.push({
        repo: url, url, number: 0,
        review: { check: null, state: null, completedAt: null, ready: false, terminal: true, why: 'the recorded pull request URL could not be parsed' },
        comments: [], counts: { total: 0, actionable: 0, humanComments: 0, duplicates: 0 },
        error: 'unparsable pull request URL',
      })
      continue
    }
    const repo = `${parsed.owner}/${parsed.repo}`
    let review: ReviewReadiness
    try {
      review = reviewReady(await readChecks(url))
    } catch (err) {
      review = { check: null, state: null, completedAt: null, ready: false, terminal: false, why: `could not read this PR's checks - ${message(err)}` }
    }

    try {
      const shaped = shapeComments(await readComments(parsed))
      artifact.prs.push({ repo, url, number: parsed.number, review, comments: shaped.comments, counts: shaped.counts })
    } catch (err) {
      artifact.prs.push({
        repo, url, number: parsed.number, review,
        comments: [], counts: { total: 0, actionable: 0, humanComments: 0, duplicates: 0 },
        error: message(err),
      })
    }
  }

  const dir = runArtifactsDir(run.id)
  const path = join(dir, 'review-comments.json')
  try {
    // `initRunArtifacts` normally created this directory at run start, but the
    // collector must not depend on having been preceded by it: a review can be
    // read for a run whose artifacts were cleaned, and the file is the whole
    // point of the call.
    await mkdir(dir, { recursive: true })
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`)
  } catch (err) {
    // The caller still gets the data; losing the file must not lose the read.
    log.warn('could not write review-comments.json', { runId: run.id, error: message(err) })
  }
  log.info('review comments collected', () => ({
    runId: run.id,
    prs: artifact.prs.length,
    actionable: artifact.prs.reduce((n, p) => n + p.counts.actionable, 0),
    ready: artifact.prs.filter(p => p.review.ready).length,
  }))
  return artifact
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim()
