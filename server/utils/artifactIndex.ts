import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUNDLE_CONTRACT_FILES } from './evidenceContract.ts'
import type { WorkflowRun } from '~~/shared/types/run'

/**
 * What every file in a run's evidence directory IS, and which step wrote it.
 *
 * Thirteen runs produced 584 distinct filenames, 556 of them appearing in
 * exactly one run: `csup-7519-qa-probe-tax.spec.ts.txt`, `qa2-gates-backend.log`,
 * `t7-child-journey-assessment-CSUP-7526.md`, `verify-t4`. Every one is real
 * evidence and every one is unfindable — there is no convention to search by,
 * no grouping, and nothing anywhere says which step produced which file.
 *
 * The obvious fix is to rename them. That is the wrong one: the assembler reads
 * fixed names, the ticket comments link the current ones, and a rename breaks
 * every link in an evidence trail whose whole job is to still be readable in six
 * months. So nothing here renames anything. It CLASSIFIES — one row per file,
 * written beside the evidence as `artifacts.json` — which gives categorisation
 * and search over the names that already exist, including the ones a future run
 * invents that nobody thought of here.
 *
 * Provenance comes from mtime against each step's own [startedAt, completedAt]
 * window, and is recorded ONLY when exactly one step's window contains it.
 * Parallel lanes overlap; attributing a file to one of two candidate steps would
 * be a guess, and a guessed provenance line is worse than none — it is the kind
 * of plausible-looking field a reader trusts. Absent means absent.
 */

export type ArtifactKind =
  | 'summary' | 'plan' | 'decision' | 'contract' | 'oracle' | 'test-red' | 'test-green'
  | 'qa' | 'review' | 'deploy' | 'pr' | 'docs' | 'evidence' | 'patch' | 'media'
  | 'result' | 'script' | 'log' | 'other'

/**
 * Ordered — the first match wins, so a specific prefix beats the extension
 * fallbacks at the bottom. Built from the 584 real names, not invented: every
 * rule here is one a file on this instance actually matches.
 */
const RULES: [RegExp, ArtifactKind][] = [
  [/^(meta\.json|bundle\.json|artifacts\.json|context-packet\.json|summary\.md|RUN-SUMMARY\.md|intent\.md)$/i, 'summary'],
  [/^(plan|task-board|oracle-plan|plan-oracle)\b/i, 'plan'],
  [/^adr[-_]/i, 'decision'],
  [/^(api-)?contract/i, 'contract'],
  [/^oracle/i, 'oracle'],
  [/^(red|.*-red)[-.]/i, 'test-red'],
  [/^green[-.]/i, 'test-green'],
  [/^(qa|regression|flake|rework\d*|adversarial|baseline|preexisting|refactor)[-.\d]/i, 'qa'],
  [/^(review|reviewer|security-review|self-review)/i, 'review'],
  [/^(deploy|compose|docker-build|stack-|push\.log|insert-seed|rehearsal|served-build)/i, 'deploy'],
  [/^(pr|jira|checks-watch)[-.]/i, 'pr'],
  [/^docs?[-.]/i, 'docs'],
  [/^(evidence|bug|root-cause|repro|prior-art|research|customer-impact|client-impact|coverage|blocked|salvage|env-probe|verify)/i, 'evidence'],
  [/\.(patch|diff)$/i, 'patch'],
  [/\.(png|jpe?g|gif|webm|mp4|zip|gz|pdf|class|jar)$/i, 'media'],
  [/^(result|claim)-/i, 'result'],
  [/\.(sh|mjs|cjs|js|ts|py|sql|java|xml|yml|yaml)$/i, 'script'],
  [/\.(log|txt|tap|stderr)$/i, 'log'],
]

/** A ticket key anywhere in the filename, in either of the two shapes runs
 *  actually write it: `CSUP-7519` and `csup7514`. */
const TICKET_RE = /\b([A-Za-z]{2,10})-?(\d{3,6})\b/

/**
 * The rules anchor at the start of the name, and one real run prefixes EVERY
 * file with its ticket (`csup-7519-root-cause.md`), which pushes the meaningful
 * word out of reach. So the ticket is stripped first, and then leading segments
 * are dropped one at a time until a rule matches — `data-migration-CSUP-7524-review.md`
 * becomes `migration-review.md` becomes `review.md`, which is a review. Bounded
 * by the segment count, and it only ever runs when the full name matched
 * nothing: a name that classifies on its own is never re-interpreted.
 */
function kindOf(base: string): ArtifactKind {
  const stripped = base.replace(TICKET_RE, '').replace(/-{2,}/g, '-').replace(/^-/, '')
  for (const candidate of [base, stripped]) {
    let rest = candidate
    for (let i = 0; i < 8 && rest; i += 1) {
      const hit = RULES.find(([re]) => re.test(rest))?.[1]
      if (hit) return hit
      const cut = rest.indexOf('-')
      if (cut === -1) break
      rest = rest.slice(cut + 1)
    }
  }
  return 'other'
}

export function classifyArtifact(name: string): { kind: ArtifactKind, ticket?: string } {
  const base = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  const kind = kindOf(base)
  const m = TICKET_RE.exec(base)
  // `run1`/`2credits`/`adr-0001` are not tickets: a ticket key needs letters.
  const prefix = m?.[1] ?? ''
  const ticket = prefix.length >= 2 && !/^(run|adr|t|db|qa|pass)$/i.test(prefix)
    ? `${prefix.toUpperCase()}-${m![2]}`
    : undefined
  return ticket ? { kind, ticket } : { kind }
}

const BINARY = /\.(png|jpe?g|gif|webm|mp4|zip|gz|pdf|class|jar|webp|ico)$/i

export interface ArtifactRow {
  name: string
  kind: ArtifactKind
  bytes: number
  /** Present only when true, so a row stays one line for the common case. */
  binary?: true
  ticket?: string
  /** Step whose run window contains this file's mtime — only when unambiguous. */
  step?: string
  agent?: string
  /** How this row's `kind` was decided. Absent means the rules decided it;
   *  'agent' means a light model read the name and disagreed or filled a gap.
   *  Recorded because a reader must be able to tell a measured classification
   *  from an interpreted one — the same rule the rest of this evidence follows. */
  by?: 'agent'
}

/** Steps with a closed window, newest-first lookups excluded: a file is
 *  attributed only when EXACTLY one window contains its mtime. */
function stepWindows(run: WorkflowRun) {
  return run.steps
    .filter(s => s.startedAt && s.completedAt)
    .map(s => ({ from: s.startedAt as number, to: s.completedAt as number, label: s.label, agent: s.agentSlug }))
}

export async function buildArtifactIndex(dir: string, run: WorkflowRun): Promise<ArtifactRow[]> {
  const windows = stepWindows(run)
  const rows: ArtifactRow[] = []
  async function walk(d: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = rel ? `${rel}/${entry.name}` : entry.name
      const full = join(d, entry.name)
      if (entry.isDirectory()) { await walk(full, name); continue }
      if (!entry.isFile()) continue
      let info
      try { info = await stat(full) } catch { continue }
      const { kind, ticket } = classifyArtifact(name)
      const owners = windows.filter(w => info.mtimeMs >= w.from && info.mtimeMs <= w.to)
      rows.push({
        name,
        kind,
        bytes: info.size,
        ...(BINARY.test(name) ? { binary: true as const } : {}),
        ...(ticket ? { ticket } : {}),
        ...(owners.length === 1 && owners[0] ? { step: owners[0].label, agent: owners[0].agent } : {}),
      })
    }
  }
  await walk(dir, '')
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export interface ArtifactIndexSummary {
  kinds: Record<string, number>
  binary_bytes: number
  attributed: number
  unattributed: number
}

/** Writes `artifacts.json` beside the evidence and returns the counts meta.json
 *  carries, so a reader sees the shape of a run's evidence without opening it. */
export async function writeArtifactIndex(dir: string, run: WorkflowRun): Promise<ArtifactIndexSummary> {
  const rows = await buildArtifactIndex(dir, run)
  const kinds: Record<string, number> = {}
  let binary_bytes = 0
  let attributed = 0
  for (const r of rows) {
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
    if (r.binary) binary_bytes += r.bytes
    if (r.step) attributed += 1
  }
  await writeFile(join(dir, 'artifacts.json'), `${JSON.stringify(rows, null, 2)}\n`)
  return { kinds, binary_bytes, attributed, unattributed: rows.length - attributed }
}

/** Names whose meaning is DEFINED — the evidence bundle's own contract files
 *  plus the runner's — so nothing interprets them into a different kind. */
const PROTECTED = new Set<string>([
  ...BUNDLE_CONTRACT_FILES, 'meta.json', 'artifacts.json', 'RUN-SUMMARY.md', 'bundle.json',
])

const KINDS = new Set<string>([
  'summary', 'plan', 'decision', 'contract', 'oracle', 'test-red', 'test-green', 'qa', 'review',
  'deploy', 'pr', 'docs', 'evidence', 'patch', 'media', 'result', 'script', 'log', 'other',
])

const CLASSIFIER_SYSTEM = `You classify the evidence files a software agent pipeline left behind.
You are given filenames, one per line, from one run's artifacts directory.
Answer with ONE JSON object: every input filename as a key, one of these kinds as its value.

${[...KINDS].join(' | ')}

What the kinds mean:
- summary: the run's own index/summary files (meta.json, summary.md, RUN-SUMMARY.md, bundle.json)
- plan: a plan or task board written before the work
- decision: an architecture decision record
- contract: an API or interface contract
- oracle: the acceptance oracle (the test that defines "fixed")
- test-red: a test run captured BEFORE the fix, expected to fail
- test-green: a test run captured AFTER the fix, expected to pass
- qa: QA, regression, coverage, lint or adversarial runs and their harnesses
- review: a review, security review or reviewer checklist
- deploy: building, composing, deploying or health-checking a stack
- pr: pull request bodies, checks, comments, ticket write-backs
- docs: documentation drift checks and sync
- evidence: investigation — reproduction, root cause, prior art, customer impact, probes
- patch: a diff or patch file
- media: screenshots, videos, traces, archives
- result: an agent's own report or claim about work it did
- script: a helper script or source file kept as evidence
- log: raw command output that fits nothing more specific
- other: genuinely none of the above

Rules: output JSON only, no prose, no code fence. Use a key for EVERY filename given.
Never invent a kind outside the list. If a name tells you nothing, answer "other".`

/**
 * Re-read the run's index with a light model and upgrade the kinds it can read
 * better than a regex can.
 *
 * Runs in the BACKGROUND, never on the path that finishes a run: the rules
 * index is already on disk and complete before this starts, so a slow, failed
 * or disabled model call costs a run nothing and changes nothing. What it adds
 * is interpretation — `verify-t4`, `t7-child-journey-assessment-CSUP-7526.md`,
 * and whatever a future run invents that no rule anticipated.
 *
 * Only rows whose answer is a KNOWN kind are taken, and every taken row is
 * marked `by: 'agent'`. A model that answers with something not on the list is
 * ignored for that row, not argued with.
 */
export async function enhanceArtifactIndex(dir: string): Promise<number> {
  const path = join(dir, 'artifacts.json')
  let rows: ArtifactRow[]
  try {
    rows = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return 0
  }
  if (!Array.isArray(rows) || !rows.length) return 0
  const { askLight, parseJsonObject } = await import('./lightAgent.ts')
  // Generous: this is a background pass with nothing waiting on it, and a run
  // with 300 evidence files is a long answer to generate. A stingy timeout here
  // is how a feature ends up permanently falling back to its own fallback.
  const answer = parseJsonObject(await askLight(
    CLASSIFIER_SYSTEM, rows.map(r => r.name).join('\n'), { timeoutMs: 180_000 },
  ))
  if (!answer) return 0
  let changed = 0
  for (const row of rows) {
    // A file's own extension is a fact, not a reading: a `.zip` trace is
    // `media` whatever a model calls it, and the binary accounting downstream
    // is keyed on that. Measured beats interpreted, every time.
    if (row.binary) continue
    // So is a contract filename. `oracle-before.xml` IS the oracle because the
    // bundle contract says that name means that thing — a model reading it as
    // "a test run that failed" is not wrong about the content and is wrong
    // about the file, and `--kind oracle` would stop finding the oracle.
    if (PROTECTED.has(row.name)) continue
    const kind = answer[row.name]
    if (typeof kind !== 'string' || !KINDS.has(kind) || kind === row.kind) continue
    row.kind = kind as ArtifactKind
    row.by = 'agent'
    changed += 1
  }
  if (!changed) return 0
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`)
  // meta.json carries the counts, and the run summary reads them from there —
  // leaving them at the rules pass would have the two files disagree about the
  // same run, which is worse than not enhancing at all.
  const metaPath = join(dir, 'meta.json')
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    const kinds: Record<string, number> = {}
    for (const r of rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
    meta.artifacts = { ...(meta.artifacts ?? {}), kinds, interpreted: changed }
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
  } catch { /* the rows are the record; the counts are a convenience */ }
  return changed
}
