import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listRuns, getRun, saveRun } from './workflowRunStore.ts'
import { runArtifactsDir } from './runArtifacts.ts'
import type { WorkflowRun, RunCi } from '~~/shared/types/run'

const execFileP = promisify(execFile)

/**
 * After a run opens a PR, its CI is the last verdict nobody in the pipeline
 * sees. This polls `gh pr checks` for every completed run whose meta.json
 * names a real PR, records the outcome on the run, and stops once the checks
 * are final. Visibility only: nothing here re-runs or fixes anything.
 */
export const DEFAULT_CI_POLL_SECONDS = 60
const LOOKBACK_MS = 24 * 60 * 60 * 1000
const PLACEHOLDER_PR = 'https://example.invalid/pending'

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
    if (run.status !== 'completed') continue
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

let timer: ReturnType<typeof setInterval> | null = null
export function startCiPoller(seconds = Number(process.env.CI_POLL_SECONDS) || DEFAULT_CI_POLL_SECONDS): void {
  if (timer) return
  timer = setInterval(() => { void pollOnce().catch(err => console.error('[ciPoller]', err)) }, seconds * 1000)
  timer.unref?.()
}
export function stopCiPoller(): void { if (timer) { clearInterval(timer); timer = null } }
