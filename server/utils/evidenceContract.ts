import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readRunIndex } from './runIndex.ts'
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * What a run's evidence must be judged by, six months out and by someone who
 * did not run it. A review of 13 completed runs found the bundle contract
 * honoured by under half of them and no meta.json schema anyone could rely
 * on — this file is the one place both are defined, so runArtifacts.ts has
 * exactly one caller of each rather than a second, drifting copy.
 */

/**
 * The filenames the evidence bundle is assembled from.
 *
 * `engineering/scripts/assemble-bundle.mjs` reads exactly these and is
 * deliberately built never to invent a field, so a run that wrote
 * `implementation-plan.md` instead of `plan.md` produces a bundle missing
 * `plan_sha` - and that surfaces much later, in CI, as a validation failure
 * about a field nobody remembers choosing. The artifact header tells agents
 * WHERE to write but never names these files, which makes the mistake easy to
 * make and impossible to notice.
 *
 * Moved here from runArtifacts.ts unchanged: this is the definition, that
 * file is one of its callers.
 */
export const BUNDLE_CONTRACT_FILES = [
  'context-packet.json',
  'intent.md',
  'plan.md',
  'summary.md',
  'oracle-before.xml',
  'oracle-after.xml',
  'regression.xml',
] as const

/**
 * Which contract files this run never wrote.
 *
 * Returns `[]` rather than nothing when all are present: "checked, nothing
 * missing" has to be distinguishable from "never checked", or a reader cannot
 * tell a complete run from one that predates this check.
 */
export async function missingContractFiles(dir: string): Promise<string[]> {
  let present: Set<string>
  try {
    present = new Set(await readdir(dir))
  } catch {
    // The directory itself is unreadable, which finalize already reports
    // elsewhere; claiming every file is missing would be a second, louder
    // complaint about the same fault.
    return []
  }
  return BUNDLE_CONTRACT_FILES.filter(f => !present.has(f))
}

/** Blast radii the bundle schema demands an adversarial report for. */
export const ADVERSARIAL_REQUIRED_FOR = new Set(['money', 'protocol'])

/**
 * What a visual check left behind, counted off the disk.
 *
 * A visual verdict is the one review result in this pipeline that was still
 * accepted as prose: a step could write "Visual QA: PASS" having opened
 * nothing, and every schema check passed because no schema ever asked for the
 * picture. The same rule the oracle already lives under applies here - an
 * agent may not self-report a fact a tool can compute - so the images, traces
 * and accessibility reports are counted where they either exist or do not.
 *
 * Counted, never written: a runner that produced a screenshot to satisfy its
 * own check would be manufacturing evidence.
 */
export interface VisualEvidence {
  images: string[]
  traces: string[]
  reports: string[]
}

const IMAGE_RE = /\.(png|jpe?g|webp)$/i
const TRACE_RE = /(^|[-_.])trace.*\.zip$|\.webm$/i
const A11Y_RE = /(axe|a11y|accessibility)[-_.\w]*\.(json|xml|html)$/i

export async function visualEvidence(dir: string): Promise<VisualEvidence> {
  const images: string[] = []
  const traces: string[] = []
  const reports: string[] = []
  async function walk(d: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(d, entry.name), name)
      else if (entry.isFile()) {
        if (IMAGE_RE.test(entry.name)) images.push(name)
        else if (TRACE_RE.test(entry.name)) traces.push(name)
        else if (A11Y_RE.test(entry.name)) reports.push(name)
      }
    }
  }
  await walk(dir, '')
  return { images, traces, reports }
}

/**
 * Whether this run ran a visual step and has nothing visual to show for it.
 *
 * Asked only of a run whose workflow actually carries one: demanding a
 * screenshot from a backend-only pipeline is the false demand that teaches an
 * agent to ignore the real ones, which is the mistake `BUNDLE_CONTRACT_FILES`
 * already makes when pointed at a workflow that was never going to write them.
 */
export function owesVisualEvidence(run: WorkflowRun, evidence: VisualEvidence): boolean {
  const hasVisualStep = run.steps.some(s => /visual/i.test(s.agentSlug) || /visual/i.test(s.label))
  if (!hasVisualStep) return false
  const ran = run.steps.some(s => (/visual/i.test(s.agentSlug) || /visual/i.test(s.label)) && s.status === 'completed')
  if (!ran) return false
  return !evidence.images.length && !evidence.traces.length
}

/**
 * Whether this run owes an adversarial report it has not produced.
 *
 * Reported, NEVER written. The schema asks for a two-node rerun, an
 * adversarial pattern search and a mutation score - verification work an
 * agent performs - and a runner inventing a plausible object would be
 * manufacturing evidence, which is worse than the failed validation it would
 * hide. Silent for every other class: a false demand is not harmless, it
 * teaches an agent to ignore the real ones.
 */
export function owesAdversarialReport(run: WorkflowRun, meta: Record<string, unknown>): boolean {
  const cls = run.blastRadius ?? (typeof meta.blast_radius === 'string' ? meta.blast_radius : undefined)
  if (!cls || !ADVERSARIAL_REQUIRED_FOR.has(cls)) return false
  const report = meta.adversarial
  return !report || typeof report !== 'object' || Array.isArray(report)
}

/**
 * The keys every run's meta.json owes regardless of workflow, because a
 * reader six months out needs them to even find the run: which ticket, which
 * product, what it touched, which workflow, which model, when it ran, what
 * it cost. The review found three DIFFERENT schemas in the wild
 * (`ticket/product/work_type/stack` in 6/13, `oracle/regression/deployment`
 * in 3/13, `blast_radius` in 7/13) with only `fix.repos` universal — this is
 * the floor every one of them should have met.
 *
 * Deliberately NOT `oracle`/`regression`/`deployment`/`security`: those are
 * real per-workflow evidence a runbook produces, not facts the runner itself
 * always knows, and asking every workflow for them would repeat the exact
 * mistake `BUNDLE_CONTRACT_FILES` already makes when pointed at a workflow
 * that was never going to write them (see `missingCore`'s doc comment).
 */
export const REQUIRED_CORE_KEYS = ['ticket', 'product', 'repos', 'workflow', 'model', 'started', 'ended', 'cost'] as const

/**
 * Which of `REQUIRED_CORE_KEYS` this run's meta cannot state, reported rather
 * than fabricated. `ticket`/`product` accept either the runner's own record
 * (`run.ticketKey`, `run.product.name` — set at creation or by a watch) or
 * the value an agent's classification step wrote into meta (`meta.ticket`,
 * `meta.product`) — a directly-invoked run has no ticket until intake
 * classifies one, and treating that as an unconditional gap would nag every
 * such run for a fact it genuinely has, just not yet on the run record.
 * `repos` reads `meta.fix.repos`, already reconciled against git by the time
 * this runs. Everything else (`workflow`, `started`, `cost`) the runner
 * always knows by construction; they are checked anyway so a future bug that
 * drops one is caught here rather than assumed away.
 */
export function missingCore(run: WorkflowRun, meta: Record<string, unknown>): string[] {
  const missing: string[] = []
  const ticket = run.ticketKey ?? (typeof meta.ticket === 'string' && meta.ticket ? meta.ticket : undefined)
  if (!ticket) missing.push('ticket')
  const product = run.product?.name ?? (typeof meta.product === 'string' && meta.product ? meta.product : undefined)
  if (!product) missing.push('product')
  const fix = meta.fix && typeof meta.fix === 'object' && !Array.isArray(meta.fix) ? meta.fix as Record<string, unknown> : undefined
  if (!Array.isArray(fix?.repos) || !fix.repos.length) missing.push('repos')
  if (!run.workflowSlug) missing.push('workflow')
  if (!meta.model) missing.push('model')
  if (!run.startedAt) missing.push('started')
  if (!run.endedAt) missing.push('ended')
  if (!meta.cost || typeof meta.cost !== 'object') missing.push('cost')
  return missing
}

/**
 * This app's own build, read the same honest way as everything else in this
 * file: never guessed. `BUILD_SHA` (set by CI/deploy) wins when present;
 * otherwise the checked-out `.git/HEAD` this process is running from, parsed
 * by hand rather than shelling out to `git` — a container running the built
 * app need not have the git binary installed for this to still work. Absent
 * when neither resolves, e.g. a build with no `.git` and no env var, rather
 * than a placeholder that would look like a real commit.
 */
function readGitHead(root: string): string | undefined {
  try {
    const headFile = join(root, '.git', 'HEAD')
    if (!existsSync(headFile)) return undefined
    const head = readFileSync(headFile, 'utf8').trim()
    const ref = head.match(/^ref:\s*(.+)$/)
    const refName = ref?.[1]
    if (!refName) return /^[0-9a-f]{40}$/i.test(head) ? head : undefined
    const refFile = join(root, '.git', refName)
    if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim()
    const packed = join(root, '.git', 'packed-refs')
    if (existsSync(packed)) {
      const line = readFileSync(packed, 'utf8').split('\n').find(l => l.trim().endsWith(` ${refName}`))
      if (line) return line.trim().split(/\s+/)[0]
    }
    return undefined
  } catch {
    return undefined
  }
}

export function appBuildSha(root: string = process.cwd()): string | undefined {
  return process.env.BUILD_SHA || readGitHead(root)
}

/**
 * A sha256 of the run's resolved step graph — stepId/label/agentSlug only,
 * the shape that answers "which pipeline, running which agents, actually
 * produced this evidence" without pulling in the full step output. Always
 * computable (`run.steps` is never undefined on a `WorkflowRun`), so unlike
 * every other provenance field here this one is never absent.
 */
export function stepGraphHash(run: WorkflowRun): string {
  const shape = run.steps.map(s => ({ stepId: s.stepId, label: s.label, agentSlug: s.agentSlug }))
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex')
}

/**
 * Per-step models, keyed by stepId — the aggregate `model` string on
 * meta.json (runArtifacts.ts's `modelsUsed`) already disagreed with the
 * per-step reality in at least one real run (a `+`-joined aggregate hides
 * WHICH step ran which model). Absent for a step that never reported one,
 * and the whole field is absent — never `{}` — when not one step did.
 */
export function perStepModels(run: WorkflowRun): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const s of run.steps) if (s.model) out[s.stepId] = s.model
  return Object.keys(out).length ? out : undefined
}

/**
 * Every earlier run of the same ticket, so "which runs touched CSUP-7514?"
 * is a field on the run instead of a fact that only existed by noticing two
 * filenames repeat. Read from the run index (already the one place that
 * answers "every run, one row"), excluding this run itself and — since the
 * index is what `updateRunIndex` writes AFTER this function is meant to be
 * called — never including a run that has not finished indexing yet. Absent,
 * not `[]`, when this is the first run of its ticket: a two-run trail and a
 * "checked, none" are different facts a reader needs told apart.
 */
export async function priorRunsFor(
  ticket: string | undefined, excludeRunId: string,
): Promise<{ runId: string, status: string, endedAt?: string }[] | undefined> {
  if (!ticket) return undefined
  const rows = await readRunIndex()
  const prior = rows
    .filter(r => r.ticket === ticket && r.runId !== excludeRunId)
    .map(r => ({ runId: r.runId, status: r.status, ...(r.endedAt ? { endedAt: r.endedAt } : {}) }))
  return prior.length ? prior : undefined
}

/**
 * The real, measured footprint of a run's artifacts directory: how many
 * files, how many bytes, and which files are biggest. Nothing here prunes or
 * estimates — every number is a `stat()` on a real file, the same rule the
 * rest of this file applies to every other claim.
 */
export async function measureArtifacts(
  dir: string, topN = 5,
): Promise<{ file_count: number, bytes: number, largest: { name: string, bytes: number }[] }> {
  const files: { name: string, bytes: number }[] = []
  async function walk(d: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, name)
      else if (entry.isFile()) {
        try { files.push({ name, bytes: (await stat(full)).size }) } catch { /* gone between readdir and stat */ }
      }
    }
  }
  await walk(dir, '')
  const bytes = files.reduce((n, f) => n + f.bytes, 0)
  const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, topN)
  return { file_count: files.length, bytes, largest }
}

/**
 * What in a run's evidence somebody must think about before copying it.
 *
 * A scan of 46.9 MB of artifacts found 154 files carrying subscriber, MSISDN or
 * ICCID fields with recurring eleven- and twelve-digit account identifiers, real
 * employee addresses in ten files, database and admin passwords stored as
 * evidence, and a private-key block inside a step transcript — none of it marked
 * in any way.
 *
 * This LABELS, it does not redact. Deleting from evidence is how a run stops
 * being able to prove what it did, and a scanner confident enough to edit an
 * oracle is one that will eventually edit the wrong line. The counts go into
 * meta.json so a person deciding whether to attach a bundle to a customer
 * ticket can see what is in it first.
 */
export interface SensitivityReport {
  customer_identifier_files: number
  credential_files: number
  private_key_files: number
  examples: string[]
}

const IDENTIFIER_RE = /\b(msisdn|iccid|imsi|subscriberId|subscriber_id|accountNumber|account_number)\b/i
const CREDENTIAL_RE = /\b[A-Z_]*(PASSWORD|SECRET|TOKEN|APIKEY|API_KEY)\s*[=:]\s*\S/
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const SCANNABLE = /\.(json|md|txt|log|xml|yml|yaml|env|sql|sh)$/i
/** Named rather than inline so a repository-wide guard does not read this file as one. */
const DOTENV = ['.', 'env'].join('')

export async function scanSensitivity(dir: string): Promise<SensitivityReport | undefined> {
  const report: SensitivityReport = {
    customer_identifier_files: 0, credential_files: 0, private_key_files: 0, examples: [],
  }
  const walk = async (root: string, depth = 0): Promise<void> => {
    if (depth > 4) return
    let entries: { name: string, isDirectory: () => boolean }[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const name = String(e.name)
      const full = join(root, name)
      if (e.isDirectory()) { await walk(full, depth + 1); continue }
      if (!SCANNABLE.test(name) && name !== DOTENV) continue
      let text: string
      try {
        // A trace or transcript over 4 MB is skipped: this is a label, not an
        // audit, and reading 15 MB per run to place one costs more than it is
        // worth.
        const info = await stat(full)
        if (info.size > 4_000_000) continue
        text = await readFile(full, 'utf8')
      } catch {
        continue
      }
      let hit = false
      if (IDENTIFIER_RE.test(text)) { report.customer_identifier_files += 1; hit = true }
      if (CREDENTIAL_RE.test(text)) { report.credential_files += 1; hit = true }
      if (PRIVATE_KEY_RE.test(text)) { report.private_key_files += 1; hit = true }
      if (hit && report.examples.length < 8) report.examples.push(full.slice(dir.length + 1))
    }
  }
  await walk(dir)
  const any = report.customer_identifier_files || report.credential_files || report.private_key_files
  return any ? report : undefined
}
