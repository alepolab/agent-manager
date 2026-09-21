import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listRuns, getRun, saveRun } from './workflowRunStore.ts'
import { PLACEHOLDER_PR, runArtifactsDir } from './runArtifacts.ts'
import { notifyCiFailing } from './notify.ts'
import type { WorkflowRun, RunCi } from '~~/shared/types/run'

const execFileP = promisify(execFile)

/**
 * After a run opens a PR, its CI is the last verdict nobody in the pipeline
 * sees. This polls `gh pr checks` for every completed run whose meta.json names
 * a real PR, records the outcome on the run, and keeps looking until the pull
 * request is merged or closed. Visibility only: nothing here re-runs or fixes
 * anything.
 *
 * It used to stop much earlier than that, and a review of thirteen real runs
 * measured what each shortcut cost:
 *
 *  - It stopped at the first non-pending result. A red check that was fixed and
 *    a green one that later broke both read as the same frozen verdict, and a
 *    PR that went green and was never merged looked finished.
 *  - It polled `urls[0]` only. A multi-repo run opens one PR per repo; the
 *    second and third were never looked at once.
 *  - It recorded no merge. Not one of the thirteen runs could answer "did this
 *    ship?" — the record ended at "checks passed", which is not the same fact.
 *    `merged_sha` and `merged_at` are that answer, per pull request.
 *  - It gave up after 24 hours. A PR waiting on a reviewer over a weekend aged
 *    out of the poller before anyone merged it.
 *  - It told nobody anything. A bucket turning red updated a field on a record
 *    and stopped there; now it calls the notifier, once per PR per transition.
 */
export const DEFAULT_CI_POLL_SECONDS = 60

/**
 * How far back a run is worth polling at all. Thirty days, not one: the old
 * 24-hour window expired PRs that were still open and still someone's job,
 * which is the defect. `final` (every PR merged or closed) is what normally
 * stops the polling; this only stops a PR nobody will ever touch again from
 * costing a `gh` call a minute forever.
 */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

export type CheckReader = (prUrl: string) => Promise<{ name: string, bucket: string }[]>

const realCheckReader: CheckReader = async (prUrl) => {
  // gh 2.63+: bucket is pass | fail | pending | skipping | cancel
  const { stdout } = await execFileP('gh', ['pr', 'checks', prUrl, '--json', 'name,bucket'], { timeout: 30_000 })
  const parsed = JSON.parse(stdout || '[]')
  return Array.isArray(parsed) ? parsed.map(c => ({ name: String(c.name ?? ''), bucket: String(c.bucket ?? 'pending') })) : []
}
let checkReader: CheckReader = realCheckReader
/** Test seam. */
export function setCheckReader(fn: CheckReader) { checkReader = fn }

/** Did it ship, and as what. `unknown` when gh could not say — never guessed
 *  into `open`, which would keep a merged PR being polled forever. */
export type PrState = 'open' | 'merged' | 'closed' | 'unknown'
export interface PrFacts { state: PrState, merged_sha?: string, merged_at?: string }
export type PrReader = (prUrl: string) => Promise<PrFacts>

const realPrReader: PrReader = async (prUrl) => {
  const { stdout } = await execFileP('gh', ['pr', 'view', prUrl, '--json', 'state,mergeCommit,mergedAt'], { timeout: 30_000 })
  const j = JSON.parse(stdout || '{}')
  const state = String(j?.state ?? '').toLowerCase()
  return {
    state: state === 'merged' || state === 'closed' || state === 'open' ? state : 'unknown',
    merged_sha: j?.mergeCommit?.oid ? String(j.mergeCommit.oid) : undefined,
    merged_at: j?.mergedAt ? String(j.mergedAt) : undefined,
  }
}
let prReader: PrReader = realPrReader
/** Test seam. */
export function setPrReader(fn: PrReader) { prReader = fn }

/** One pull request of a run: its checks and whether it shipped.
 *
 *  Kept here rather than widening shared/types/run.ts (the same choice
 *  runArtifacts.ts makes for StepWithUsage): `RunCi` keeps the exact shape the
 *  run page and runSummary.ts already read, and the per-PR detail rides along
 *  on `prs` for readers that want it. */
export interface RunCiPr extends PrFacts {
  pr: string
  status: RunCi['status']
  checks: { name: string, bucket: string }[]
  error?: string
}
export type RunCiMulti = RunCi & { prs: RunCiPr[], merged_sha?: string, merged_at?: string }

export function classify(checks: { bucket: string }[]): RunCi['status'] {
  if (!checks.length) return 'pending'
  if (checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failing'
  if (checks.every(c => c.bucket === 'pass' || c.bucket === 'skipping')) return 'passing'
  return 'pending'
}

/** The run's verdict over all its pull requests: one red repo is a red run. */
export function worstOf(prs: RunCiPr[]): RunCi['status'] {
  if (prs.some(p => p.status === 'failing')) return 'failing'
  if (prs.some(p => p.status === 'pending')) return 'pending'
  if (prs.length && prs.every(p => p.status === 'passing')) return 'passing'
  return 'unknown'
}

/** The PR URLs a run's meta.json records, excluding the placeholder. */
export async function prUrlsOf(run: WorkflowRun): Promise<string[]> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    const repos = Array.isArray(meta?.fix?.repos) ? meta.fix.repos : []
    const urls = repos.map((r: any) => r?.pr).filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http') && u !== PLACEHOLDER_PR)
    return [...new Set<string>(urls)]
  } catch {
    return []
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Every pull request of one run, checks and merge state together. */
async function readPr(url: string): Promise<RunCiPr> {
  let status: RunCi['status'] = 'unknown'
  let checks: { name: string, bucket: string }[] = []
  let error: string | undefined
  try {
    checks = await checkReader(url)
    status = classify(checks)
  } catch (err) {
    error = message(err)
  }
  let facts: PrFacts = { state: 'unknown' }
  try {
    facts = await prReader(url)
  } catch (err) {
    error ??= message(err)
  }
  return { pr: url, status, checks, error, ...facts }
}

/** One pass over the runs worth polling. Returns how many were checked. */
export async function pollOnce(now = Date.now()): Promise<number> {
  let checked = 0
  for (const run of await listRuns()) {
    // A failed run can still have opened its PR (a budget cap after the PR step, say); its checks matter as much.
    if (run.status !== 'completed' && run.status !== 'failed') continue
    if ((run.endedAt ?? run.startedAt) < now - LOOKBACK_MS) continue
    if (run.ci?.final) continue
    const urls = await prUrlsOf(run)
    if (!urls.length) continue

    const prs: RunCiPr[] = []
    for (const url of urls) prs.push(await readPr(url))

    const status = worstOf(prs)
    // Final means "there is nothing left to watch": every pull request is
    // merged or closed. It used to mean "the checks stopped changing", which
    // ended the watch while the PR was still open and unmerged.
    const settled = prs.every(p => p.state === 'merged' || p.state === 'closed')
    const merged = prs.find(p => p.state === 'merged')
    const ci: RunCiMulti = {
      pr: urls[0]!,
      status,
      checks: prs.flatMap(p => p.checks),
      checkedAt: now,
      final: settled,
      prs,
      error: prs.find(p => p.error)?.error,
      merged_sha: merged?.merged_sha,
      merged_at: merged?.merged_at,
    }

    // Re-read before writing: the record may have moved on since the listing.
    const fresh = await getRun(run.id)
    if (!fresh) continue
    const was = fresh.ci?.status
    await saveRun({ ...fresh, ci })
    // Only the TRANSITION is worth a message; a bucket that has been red since
    // yesterday is not news once a minute.
    if (status === 'failing' && was !== 'failing') notifyCiFailing({ ...fresh, ci }, ci)
    checked++
  }
  return checked
}

let timer: ReturnType<typeof setInterval> | null = null
export function startCiPoller(seconds = Number(process.env.CI_POLL_SECONDS) || DEFAULT_CI_POLL_SECONDS): void {
  if (timer) return
  timer = setInterval(() => { void pollOnce().catch(err => console.error('[ciPoller]', err)) }, seconds * 1000)
  timer.unref?.()
}
export function stopCiPoller(): void { if (timer) { clearInterval(timer); timer = null } }
