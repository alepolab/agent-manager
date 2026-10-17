import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listRuns, getRun, saveRun } from './workflowRunStore.ts'
import { PLACEHOLDER_PR, runArtifactsDir } from './runArtifacts.ts'
import { productByKey } from './registry.ts'
import type { WorkflowRun, RunCi } from '~~/shared/types/run'
import { isTestRun } from '../../shared/types/run.ts'

const execFileP = promisify(execFile)

/**
 * After a run opens a PR, its CI is the last verdict nobody in the pipeline
 * sees. This polls `gh pr checks` for every completed run whose meta.json
 * names a real PR, records the outcome on the run, and stops once the checks
 * are final. Visibility only: nothing here re-runs or fixes anything.
 */
export const DEFAULT_CI_POLL_SECONDS = 60
const LOOKBACK_MS = 24 * 60 * 60 * 1000

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

export function classify(checks: { bucket: string }[]): RunCi['status'] {
  if (!checks.length) return 'pending'
  if (checks.some(c => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failing'
  if (checks.every(c => c.bucket === 'pass' || c.bucket === 'skipping')) return 'passing'
  return 'pending'
}

/** The PR URLs a run's meta.json records, excluding the placeholder. */
export async function prUrlsOf(run: WorkflowRun): Promise<string[]> {
  try {
    const meta = JSON.parse(await readFile(join(runArtifactsDir(run.id), 'meta.json'), 'utf8'))
    const repos = Array.isArray(meta?.fix?.repos) ? meta.fix.repos : []
    return repos.map((r: any) => r?.pr).filter((u: unknown): u is string => typeof u === 'string' && u.startsWith('http') && u !== PLACEHOLDER_PR)
  } catch {
    return []
  }
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
    const url = urls[0]!
    let ci: RunCi
    try {
      const checks = await checkReader(url)
      const status = classify(checks)
      ci = { pr: url, status, checks, checkedAt: now, final: status !== 'pending' }
    } catch (err) {
      ci = { pr: url, status: 'unknown', checks: [], checkedAt: now, final: false, error: err instanceof Error ? err.message : String(err) }
    }
    // Re-read before writing: the record may have moved on since the listing.
    const fresh = await getRun(run.id)
    if (!fresh) continue
    await saveRun({ ...fresh, ci })
    checked++
  }
  return checked
}

export type ReviewRequester = (prUrl: string, reviewers: string[]) => Promise<void>
// The REST endpoint, not `gh pr edit --add-reviewer`: that one also queries
// Projects (classic), which GitHub has retired, and fails on every PR.
const realReviewRequester: ReviewRequester = async (prUrl, reviewers) => {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) throw new Error(`not a GitHub pull request URL: ${prUrl}`)
  await execFileP('gh', ['api', '-X', 'POST', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/requested_reviewers`, ...reviewers.flatMap(r => ['-f', `reviewers[]=${r}`])], { timeout: 30_000 })
}
let reviewRequester: ReviewRequester = realReviewRequester
/** Test seam. */
export function setReviewRequester(fn: ReviewRequester) { reviewRequester = fn }

/**
 * Asks the product's reviewers (the registry's `reviewers`) to review every
 * pull request a run has opened, once per PR, whatever step opened it and
 * whatever the run is doing now: a run that opens its PR and then waits at a
 * gate is exactly the one a reviewer should be looking at. The product is read
 * from the registry now rather than from the run, so a reviewer added today
 * reaches the runs already in flight. A request that fails is tried again on
 * the next pass; one that succeeds is recorded on the run and never repeated.
 */
export async function requestReviewsOnce(now = Date.now()): Promise<number> {
  let requested = 0
  for (const run of await listRuns()) {
    if (!run.product?.name || (run.endedAt ?? now) < now - 7 * LOOKBACK_MS) continue
    const urls = (await prUrlsOf(run)).filter(u => !run.reviewRequested?.includes(u))
    if (!urls.length) continue
    const reviewers = (await productByKey(run.product.name).catch(() => undefined))?.reviewers ?? []
    if (!reviewers.length) continue
    const done: string[] = []
    for (const url of urls) {
      try { await reviewRequester(url, reviewers); done.push(url) } catch (err) {
        console.error('[ciPoller] could not request review', url, err instanceof Error ? err.message : String(err))
      }
    }
    if (!done.length) continue
    const fresh = await getRun(run.id)
    if (!fresh) continue
    await saveRun({ ...fresh, reviewRequested: [...(fresh.reviewRequested ?? []), ...done] })
    requested += done.length
  }
  return requested
}

export type MergeReader = (prUrl: string) => Promise<{ merged: boolean, mergeCommit?: string, baseBranch?: string }>
const realMergeReader: MergeReader = async (prUrl) => {
  const { stdout } = await execFileP('gh', ['pr', 'view', prUrl, '--json', 'state,mergeCommit,baseRefName'], { timeout: 30_000 })
  const parsed = JSON.parse(stdout || '{}')
  return { merged: parsed?.state === 'MERGED', mergeCommit: parsed?.mergeCommit?.oid ?? undefined, baseBranch: parsed?.baseRefName ?? undefined }
}
let mergeReader: MergeReader = realMergeReader
/** Test seam. */
export function setMergeReader(fn: MergeReader) { mergeReader = fn }

export type VerificationStarter = (s: { issueKey: string, pr: string, revision?: string, branch?: string, watch: string, startedBy?: string, productKey?: string }) => Promise<{ run: { id: string } }>
let verificationStarter: VerificationStarter | null = null
/** Set at boot (server/plugins/ciPoller.ts) to the real Runbook V starter; a test substitutes its own. Null means "detect, never start". */
export function setVerificationStarter(fn: VerificationStarter | null) { verificationStarter = fn }

/**
 * A run's pull request has merged: start Runbook V for its ticket, once.
 *
 * Polled beside the checks for runs that finished with a PR within the
 * lookback window. The run records `verification` the moment the merge is
 * seen - with the verification run's id when one started, or the reason none
 * did - so a PR is never verified twice, and a refusal is on the record
 * rather than retried every minute. Returns how many merges were seen.
 */
export async function detectMergedOnce(now = Date.now()): Promise<number> {
  let seen = 0
  for (const run of await listRuns()) {
    if (run.status !== 'completed' && run.status !== 'failed') continue
    if (isTestRun(run) || !run.ticketKey) continue
    if ((run.endedAt ?? run.startedAt) < now - 7 * LOOKBACK_MS) continue
    if (run.verification) continue
    const urls = await prUrlsOf(run)
    if (!urls.length) continue
    const url = urls[0]!
    let merge: Awaited<ReturnType<MergeReader>>
    try { merge = await mergeReader(url) } catch { continue }
    if (!merge.merged) continue
    seen++
    const fresh = await getRun(run.id)
    if (!fresh || fresh.verification) continue
    let verification: NonNullable<WorkflowRun['verification']>
    if (!verificationStarter) {
      verification = { pr: url, mergedAt: now, reason: 'no verification starter is wired on this instance' }
    } else {
      try {
        const { run: v } = await verificationStarter({ issueKey: fresh.ticketKey!, pr: url, revision: merge.mergeCommit, branch: merge.baseBranch, watch: `ci-poller:${fresh.id}`, startedBy: fresh.startedBy, productKey: fresh.product?.name })
        verification = { pr: url, mergedAt: now, runId: v.id }
      } catch (err) {
        verification = { pr: url, mergedAt: now, reason: err instanceof Error ? err.message : String(err) }
      }
    }
    await saveRun({ ...fresh, verification })
  }
  return seen
}

let timer: ReturnType<typeof setInterval> | null = null
export function startCiPoller(seconds = Number(process.env.CI_POLL_SECONDS) || DEFAULT_CI_POLL_SECONDS): void {
  if (timer) return
  timer = setInterval(() => {
    void pollOnce().catch(err => console.error('[ciPoller]', err))
    void requestReviewsOnce().catch(err => console.error('[ciPoller] review requests', err))
    void detectMergedOnce().catch(err => console.error('[ciPoller] merge detection', err))
  }, seconds * 1000)
  timer.unref?.()
}
export function stopCiPoller(): void { if (timer) { clearInterval(timer); timer = null } }
