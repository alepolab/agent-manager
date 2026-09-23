import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { runArtifactsDir, PLACEHOLDER_PR } from './runArtifacts.ts'
import { summarizeRunCost } from './costReport.ts'
import { runElapsedMinutes } from '../../shared/utils/runClock.ts'
import { parseReviewVerdict } from '../../shared/utils/workflowGraph.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('artifacts')

/**
 * One row per run, machine-readable, grep- and jq-able.
 *
 * The gap this closes: 13 real runs, 13 bare UUID directories, no way to
 * answer "which run is CSUP-7516?" without opening every meta.json. Every
 * field here is read straight off the run record or its meta.json — nothing
 * is computed by a heuristic that could be wrong, and nothing is guessed to
 * fill a gap. A field the run genuinely never produced (no model reported, no
 * cost measured, no blast radius classified) is ABSENT from the row, never a
 * null or a zero standing in for "unknown" — see runArtifacts.ts's `modelsUsed`
 * and `tokenTotals` for the same rule applied to meta.json itself.
 */
export interface RunIndexRow {
  runId: string
  ticket?: string
  /** Workflow slug, e.g. `csup-to-pr`. `workflowName` is the human label. */
  workflow: string
  workflowName: string
  product?: string
  status: string
  /** ISO 8601 UTC. */
  startedAt: string
  /** ISO 8601 UTC; absent while the run is still going. */
  endedAt?: string
  activeMinutes: number
  /** Absent when not one step reported usage — see summarizeRunCost's `complete`. */
  costUsd?: number
  /** The model(s) the run's steps actually reported, '+'-joined when they differ. */
  model?: string
  repos: string[]
  /** Flattened across every repo in meta.fix.repos — which repo made which commit is in meta.json, not here. */
  commits: string[]
  prs: { repo: string, url: string }[]
  blastRadius?: string
  /** Only the keys a verdict was actually found for. */
  verdicts?: { review?: string, security?: string }
  stepCount: number
  failedSteps: string[]
  artifactCount: number
  artifactBytes: number
  /** True when any step left uncommitted work behind in its lane — see RunStep.laneKept. */
  laneKept: boolean
  recovered: boolean
}

/** `meta.fix.repos[].repo` / `.commits`, flattened. Shared by the index row and
 *  the summary's front matter so the two documents can never quietly disagree
 *  about what a run touched. */
export function fixReposAndCommits(meta: Record<string, unknown>): { repos: string[], commits: string[] } {
  const fix = meta.fix
  if (!fix || typeof fix !== 'object' || Array.isArray(fix)) return { repos: [], commits: [] }
  const repoEntries = (fix as Record<string, unknown>).repos
  if (!Array.isArray(repoEntries)) return { repos: [], commits: [] }
  const repos: string[] = []
  const commits: string[] = []
  for (const entry of repoEntries) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.repo === 'string') repos.push(rec.repo)
    if (Array.isArray(rec.commits)) commits.push(...rec.commits.filter((c): c is string => typeof c === 'string'))
  }
  return { repos, commits }
}

/** `meta.fix.repos[].pr`, excluding the pre-ship placeholder — see PLACEHOLDER_PR's doc comment in runArtifacts.ts. */
function pullRequestsFrom(meta: Record<string, unknown>): { repo: string, url: string }[] {
  const fix = meta.fix
  if (!fix || typeof fix !== 'object' || Array.isArray(fix)) return []
  const repos = (fix as Record<string, unknown>).repos
  if (!Array.isArray(repos)) return []
  return repos
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter(r => typeof r.pr === 'string' && r.pr !== PLACEHOLDER_PR && (r.pr as string).startsWith('http'))
    .map(r => ({ repo: String(r.repo ?? 'repository'), url: String(r.pr) }))
}

/** The model(s) this run's steps actually reported, joined. Mirrors
 *  runArtifacts.ts's private `modelsUsed` — not imported from there, since that
 *  file is not exported and is under separate ownership on this change. */
function modelsUsed(run: WorkflowRun): string | undefined {
  const reported = [...new Set(run.steps.map(s => s.model).filter((m): m is string => Boolean(m)))]
  return reported.length ? reported.join('+') : undefined
}

/** The run's own stated review verdict, if any step's output said one — read
 *  from the LAST step that stated one, since a run can send work back through
 *  a reviewer more than once and the latest statement is the one that stood. */
function reviewVerdict(run: WorkflowRun): string | undefined {
  for (let i = run.steps.length - 1; i >= 0; i -= 1) {
    const v = parseReviewVerdict(run.steps[i]!.output)
    if (v) return v
  }
  return undefined
}

/** `meta.security.verdict` (PASS|FAIL), the shape the evidence-bundle schema
 *  requires when a workflow ran a security-review step. Absent otherwise. */
function securityVerdict(meta: Record<string, unknown>): string | undefined {
  const security = meta.security
  if (!security || typeof security !== 'object' || Array.isArray(security)) return undefined
  const v = (security as Record<string, unknown>).verdict
  return typeof v === 'string' ? v : undefined
}

/** Files and total bytes under a run's artifacts directory, recursively.
 *  `{ count: 0, bytes: 0 }` when the directory is gone rather than a throw —
 *  a run whose evidence was cleaned up is a fact about the run, not an error. */
async function artifactFootprint(dir: string): Promise<{ count: number, bytes: number }> {
  let count = 0
  let bytes = 0
  async function walk(d: string): Promise<void> {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        count += 1
        try { bytes += (await stat(full)).size } catch { /* gone between readdir and stat */ }
      }
    }
  }
  await walk(dir)
  return { count, bytes }
}

/**
 * Builds one run's index row from its record and (optional) meta.json. Never
 * writes anything; `updateRunIndex` is the only writer.
 */
export async function buildRunIndexRow(run: WorkflowRun, meta: Record<string, unknown> = {}): Promise<RunIndexRow> {
  const { repos, commits } = fixReposAndCommits(meta)
  const cost = summarizeRunCost(run)
  const blastRadius = run.blastRadius ?? (typeof meta.blast_radius === 'string' ? meta.blast_radius : undefined)
  const verdicts: { review?: string, security?: string } = {}
  const review = reviewVerdict(run)
  const security = securityVerdict(meta)
  if (review) verdicts.review = review
  if (security) verdicts.security = security
  const { count: artifactCount, bytes: artifactBytes } = await artifactFootprint(runArtifactsDir(run.id))

  return {
    runId: run.id,
    ...(run.ticketKey ? { ticket: run.ticketKey } : {}),
    workflow: run.workflowSlug,
    workflowName: run.workflowName,
    ...(run.product?.name ? { product: run.product.name } : {}),
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
    ...(run.endedAt ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
    activeMinutes: Math.round(runElapsedMinutes(run)),
    ...(cost.totals.measured_step_count > 0 ? { costUsd: cost.totals.cost_usd } : {}),
    ...((() => { const m = modelsUsed(run); return m ? { model: m } : {} })()),
    repos,
    commits,
    prs: pullRequestsFrom(meta),
    ...(blastRadius ? { blastRadius } : {}),
    ...(Object.keys(verdicts).length ? { verdicts } : {}),
    stepCount: run.steps.length,
    failedSteps: run.steps.filter(s => s.status === 'failed').map(s => s.label),
    artifactCount,
    artifactBytes,
    laneKept: run.steps.some(s => Boolean(s.laneKept)),
    recovered: Boolean(run.recovered),
  }
}

function indexPath(): string {
  return resolveClaudePath('workflow-runs', 'index.jsonl')
}

/**
 * Every row currently in the index, oldest corruption tolerated silently: a
 * line that isn't valid JSON, or doesn't carry a string `runId`, is skipped
 * rather than thrown on — a hand-edited or half-written line must not make
 * every other run's row unreadable.
 */
export async function readRunIndex(): Promise<RunIndexRow[]> {
  let raw: string
  try {
    raw = await readFile(indexPath(), 'utf8')
  } catch {
    return []
  }
  const rows: RunIndexRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && typeof parsed.runId === 'string') rows.push(parsed as RunIndexRow)
      else log.warn('index line skipped: no string runId', { line: trimmed.slice(0, 120) })
    } catch {
      log.warn('index line skipped: not valid JSON', { line: trimmed.slice(0, 120) })
    }
  }
  return rows
}

/** Newest first, matching workflowRunStore.ts's listRuns ordering — a reader
 *  scanning the file top-down sees recent runs first, same as the runs page. */
async function writeRunIndex(rows: RunIndexRow[]): Promise<void> {
  const path = indexPath()
  await mkdir(dirname(path), { recursive: true })
  const sorted = [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const body = sorted.map(r => JSON.stringify(r)).join('\n')
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, sorted.length ? `${body}\n` : '', 'utf8')
  await rename(tmp, path)
}

/**
 * Appends this run's row, or replaces its existing one — newest write wins
 * for a given `runId`. Read-modify-write of the whole (small) file rather than
 * a real database: this is 13 runs today and hundreds at the outside, and a
 * flat file a person can `grep`/`jq` is the point of this task.
 *
 * Throws only on a genuine I/O failure (disk full, permission denied) —
 * a malformed EXISTING line is skipped by `readRunIndex`, never fatal here.
 * The caller (not this function) is responsible for not letting that failure
 * take a run down.
 */
export async function updateRunIndex(run: WorkflowRun, meta: Record<string, unknown> = {}): Promise<void> {
  const row = await buildRunIndexRow(run, meta)
  const rows = await readRunIndex()
  const next = rows.filter(r => r.runId !== run.id)
  next.push(row)
  await writeRunIndex(next)
  log.debug('run index updated', { runId: run.id, rows: next.length })
}

/** Convenience filter over the index — intentionally not a query language:
 *  this is a flat file, not a search engine. `Array.prototype.filter` on the
 *  result of `readRunIndex` does exactly as well; this just names the idiom. */
export async function queryRunIndex(pred: (row: RunIndexRow) => boolean): Promise<RunIndexRow[]> {
  return (await readRunIndex()).filter(pred)
}
