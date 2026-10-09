/**
 * Which drafts a scan is about to file are already covered - by an open Jira
 * ticket, or by an agent-manager run still working on its own ticket - decided
 * by the code each one names, not by how it is worded.
 *
 * Triage compared findings with existing tickets by summary and a 400-character
 * excerpt. ASECRM-368 named three findings; the one ASECRM-584 duplicated
 * (SubscriberApprovalService's undo path) sat past the excerpt, and the summaries
 * said "approval rollback" and "approval-undo". Triage filed it, the gate
 * escalated it for its blast radius alone, and the review gave no hint. The run
 * for ASECRM-368 had changed that very file on a branch nobody had pushed.
 *
 * So the runner checks, before the gate reads the drafts: a draft whose code -
 * a file and the lines in it - overlaps what an open ticket's description names,
 * or what a live run for another ticket has changed, is marked
 * `possible_duplicate_of`. After the gate it holds the
 * line: a marked draft the gate approved anyway is moved to escalated, so a
 * person sees "possibly covered by ASECRM-368" before a second ticket exists.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolveRunArtifact, writeArtifactJson } from './runArtifacts.ts'
import { entriesOf } from '../../shared/utils/workflowGraph.ts'
import { EXISTING_TICKETS_ARTIFACT, type ExistingTicket } from './existingTickets.ts'
import { isLiveStatus, isTestRun } from '../../shared/types/run.ts'
import type { WorkflowRun } from '../../shared/types/run'

const execFileP = promisify(execFile)

export const DRAFTS_FILE = 'ticket-drafts.json'
export const APPROVED_FILE = 'approved-drafts.json'
export const ESCALATED_FILE = 'escalated-drafts.json'
export const DUPLICATE_CHECK_FILE = 'duplicate-check.json'

/** One reason a draft may already be covered. */
export interface DuplicateMatch {
  key: string
  /** Where the overlap was found: the ticket's own description, or a live run's diff. */
  source: 'ticket' | 'run'
  runId?: string
  /** The draft's code that overlaps - file and lines, as the draft names them. */
  matched: string[]
}

// ── code references ────────────────────────────────────────────────────────

const EXT = 'java|kt|kts|scala|groovy|ts|tsx|js|jsx|mjs|cjs|vue|py|go|rb|rs|cs|php|sql|xml|yml|yaml|json|gradle|properties|sh|html|css|scss'
/** A path: optional directories (an elided `.../` counts as one), then a file with a code extension, then an optional line or range. */
const PATH_RE = new RegExp(String.raw`((?:[\w@.-]+/|\.\.\./|…/)*[\w@.-]+\.(?:${EXT}))\b(?::(\d+)(?:\s*[-–]\s*(\d+))?)?`, 'g')
/** A markdown table row naming a file in one cell and its lines in the next. */
const TABLE_ROW_RE = new RegExp(String.raw`\|\s*\`?((?:[\w@.-]+/|\.\.\./|…/)*[\w@.-]+\.(?:${EXT}))\`?\s*\|\s*(\d+)(?:\s*[-–]\s*(\d+))?`, 'g')

/** File names too common to mean anything on their own. */
const GENERIC = new Set(['index.ts', 'index.js', 'index.vue', 'index.tsx', 'utils.ts', 'types.ts', 'main.ts', 'app.vue', 'package.json',
  'pom.xml', 'build.gradle', 'settings.gradle', 'application.yml', 'application.yaml', 'application.properties', 'readme.md', 'tsconfig.json'])

export interface CodeRef { path: string, from?: number, to?: number }

const asRef = (path: string, a?: string, b?: string): CodeRef => {
  const from = a ? Number(a) : undefined
  const to = b ? Number(b) : from
  return { path: path.replace(/^`|`$/g, ''), ...(from !== undefined ? { from, to } : {}) }
}

export const refString = (r: CodeRef) => r.from !== undefined ? `${r.path}:${r.from}${r.to !== r.from ? `-${r.to}` : ''}` : r.path

export function parseRefString(s: string): CodeRef | null {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(s.trim())
  return m ? asRef(m[1]!, m[2], m[3]) : null
}

/**
 * The file references a body of text names, in order, without repeats.
 * A version number or a URL is not a file: only names with a code extension
 * count, and links are removed first.
 */
export function extractCodeRefs(text: string, max = 40): CodeRef[] {
  const out = new Map<string, CodeRef>()
  const add = (r: CodeRef) => {
    const k = refString(r)
    if (!out.has(k)) out.set(k, r)
  }
  // A link is not a file, though it may end in one: links go before matching.
  const plain = text.replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
  for (const m of plain.matchAll(TABLE_ROW_RE)) add(asRef(m[1]!, m[2], m[3]))
  for (const m of plain.matchAll(PATH_RE)) add(asRef(m[1]!, m[2], m[3]))
  // A bare file name that a fuller reference already names adds nothing.
  const refs = [...out.values()]
  return refs.filter(r => !(r.from === undefined && refs.some(o => o !== r && basename(o.path) === basename(r.path) && segments(o.path).length > segments(r.path).length))).slice(0, max)
}

const basename = (p: string) => (p.split('/').pop() ?? p).toLowerCase()
/** The directories a path states, without the elisions. */
const segments = (p: string) => p.toLowerCase().split('/').slice(0, -1).filter(s => s && s !== '...' && s !== '…')

/** True when every directory `short` states appears in `long`, in order. */
function dirsCompatible(a: string, b: string): boolean {
  const [x, y] = [segments(a), segments(b)]
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  let i = 0
  for (const s of long) if (s === short[i]) i++
  return i === short.length
}

/** Whether two references name the same file - and so the same code, for a duplicate's purposes. */
export function sameFile(a: CodeRef, b: CodeRef): boolean {
  const name = basename(a.path)
  if (name !== basename(b.path)) return false
  if (GENERIC.has(name) && (!segments(a.path).length || !segments(b.path).length)) return false
  return dirsCompatible(a.path, b.path)
}

/**
 * Lines a draft and a ticket or a run's change may be apart and still be the
 * same code: the scanned branch has moved on since the ticket was written or the
 * run cut its branch, so line numbers drift.
 */
const LINE_SLACK = 30

/**
 * Same code, not merely the same file. Matching on the file alone flagged a
 * shared component (data-table.tsx) against every ticket that ever touched it;
 * a line range on both sides is what makes an overlap mean a duplicate.
 */
const overlaps = (a: CodeRef, b: CodeRef) =>
  a.from !== undefined && b.from !== undefined
  && a.from - LINE_SLACK <= (b.to ?? b.from) && b.from - LINE_SLACK <= (a.to ?? a.from)

const label = (r: CodeRef) => r.from !== undefined ? `${r.path.split('/').pop()}:${r.from}${r.to !== r.from ? `-${r.to}` : ''}` : r.path.split('/').pop()!

// ── the drafts' own references ────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Where a draft points: its findings' file and line, then whatever its text names. */
export function draftRefs(draft: Record<string, unknown>, findings: Map<string, { file?: string, line?: string | number }>): CodeRef[] {
  const refs: CodeRef[] = []
  const ids = Array.isArray(draft.finding_ids) ? draft.finding_ids.map(String) : []
  for (const id of ids) {
    const f = findings.get(id)
    if (!f?.file) continue
    const line = /^(\d+)(?:\s*[-–]\s*(\d+))?/.exec(String(f.line ?? ''))
    refs.push(asRef(f.file, line?.[1], line?.[2]))
  }
  const fields = (draft.fields && typeof draft.fields === 'object') ? draft.fields as Record<string, unknown> : {}
  const text = [str(draft.description), str(fields.description), str(draft.summary)].join('\n')
  for (const r of extractCodeRefs(text)) if (!refs.some(o => sameFile(o, r) && (o.from === r.from))) refs.push(r)
  return refs
}

/** The overlap between a draft's references and another's, as labels; empty for none. */
function overlapLabels(mine: CodeRef[], theirs: CodeRef[]): string[] {
  const out = new Set<string>()
  for (const m of mine) if (theirs.some(t => sameFile(m, t) && overlaps(m, t))) out.add(label(m))
  return [...out]
}

// ── live runs ─────────────────────────────────────────────────────────────

/** A live run's changes: one reference per changed hunk, in the lines of the base it started from. */
export interface RunChanges { runId: string, ticketKey: string, changes: CodeRef[] }

/** The hunks of a `git diff -U0`, as ranges of the OLD side - the base, which is what a scan of that branch reads. */
export function parseHunks(diff: string): CodeRef[] {
  const out: CodeRef[] = []
  let file: string | null = null
  for (const line of diff.split('\n')) {
    const f = /^diff --git a\/(.+?) b\//.exec(line)
    if (f) { file = f[1]!; continue }
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (h && file) {
      const from = Number(h[1]), count = h[2] === undefined ? 1 : Number(h[2])
      out.push({ path: file, from, to: from + Math.max(count, 1) - 1 })
    }
  }
  return out
}

/** What a live run has changed since it started: committed on its branch, and not yet committed. */
export async function changedFilesOf(run: Pick<WorkflowRun, 'projectDir' | 'baseCommit'>): Promise<CodeRef[]> {
  if (!run.projectDir || !run.baseCommit) return []
  try {
    const { stdout } = await execFileP('git', ['-C', run.projectDir, 'diff', '-U0', '--no-color', run.baseCommit], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
    return parseHunks(stdout)
  } catch {
    return []
  }
}

/**
 * The live runs whose work a scan's drafts could duplicate: another run, for a
 * ticket, on the same product, not a test, and not settled. A settled run's
 * work is either merged (and so on the scanned branch) or abandoned.
 */
export async function liveRunChanges(
  scan: Pick<WorkflowRun, 'id' | 'product'>,
  runs: WorkflowRun[],
  changed: (r: WorkflowRun) => Promise<CodeRef[]> = changedFilesOf,
): Promise<RunChanges[]> {
  const product = scan.product?.name
  // Every one, not the first few dozen: an instance holds a hundred-odd runs
  // paused at gates, and a cap of sixty dropped exactly ASECRM-368's.
  const candidates = runs.filter(r => r.id !== scan.id && r.ticketKey && isLiveStatus(r.status) && !isTestRun(r)
    && (!product || !r.product?.name || r.product.name === product))
  const out: RunChanges[] = []
  const BATCH = 8
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(r => changed(r).catch(() => [] as CodeRef[])))
    batch.forEach((r, n) => { if (results[n]!.length) out.push({ runId: r.id, ticketKey: r.ticketKey!, changes: results[n]! }) })
  }
  return out
}

// ── the check ─────────────────────────────────────────────────────────────

/** A ticket's references: its indexed locations, else whatever its excerpt names. */
const ticketRefs = (t: ExistingTicket) =>
  (t.locations?.length ? t.locations.map(parseRefString).filter((r): r is CodeRef => !!r) : extractCodeRefs(`${t.summary}\n${t.excerpt}`))

/** The matches for one draft. Pure, so the rule can be tested without a run. */
export function findDuplicates(
  draft: Record<string, unknown>,
  findings: Map<string, { file?: string, line?: string | number }>,
  tickets: ExistingTicket[],
  runs: RunChanges[],
): DuplicateMatch[] {
  const mine = draftRefs(draft, findings)
  if (!mine.length) return []
  const own = str(draft.jira_key)
  const out = new Map<string, DuplicateMatch>()
  const add = (m: DuplicateMatch) => {
    const prev = out.get(m.key)
    if (!prev) out.set(m.key, m)
    else prev.matched = [...new Set([...prev.matched, ...m.matched])]
  }
  for (const t of tickets) {
    if (t.key === own) continue
    const matched = overlapLabels(mine, ticketRefs(t))
    if (matched.length) add({ key: t.key, source: 'ticket', matched })
  }
  for (const r of runs) {
    if (r.ticketKey === own) continue
    const matched = overlapLabels(mine, r.changes)
    if (matched.length) add({ key: r.ticketKey, source: 'run', runId: r.runId, matched })
  }
  return [...out.values()]
}

/** One line for a person: "Possibly covered by ASECRM-368 (SubscriberApprovalService.java)". */
export function duplicateSentence(matches: DuplicateMatch[]): string {
  return `Possibly covered by ${matches.map(m => `${m.key} (${m.matched.join(', ')}${m.source === 'run' ? ', on its run\'s unmerged branch' : ''})`).join('; ')}`
}

type Entry = Record<string, unknown>

/** A JSON artifact and the entries inside it, however it is wrapped; null when absent or unreadable. */
async function readJson(runId: string, name: string): Promise<{ root: unknown, entries: Entry[] } | null> {
  const path = resolveRunArtifact(runId, name)
  if (!path) return null
  try {
    const root = JSON.parse(await readFile(path, 'utf8'))
    // A report keeps its findings under `findings` beside other arrays; a drafts
    // file is an array, or a wrapper holding one (entriesOf, as every reader).
    const list = Array.isArray((root as { findings?: unknown })?.findings) ? (root as { findings: unknown[] }).findings
      : Array.isArray((root as { tickets?: unknown })?.tickets) ? (root as { tickets: unknown[] }).tickets
        : entriesOf(root)
    if (!list) return null
    return { root, entries: list.filter((e): e is Entry => !!e && typeof e === 'object' && !Array.isArray(e)) }
  } catch {
    return null
  }
}

async function findingsOf(runId: string): Promise<Map<string, { file?: string, line?: string | number }>> {
  const map = new Map<string, { file?: string, line?: string | number }>()
  for (const name of ['scan-report.json', 'triage-report.json']) {
    for (const f of (await readJson(runId, name))?.entries ?? []) {
      if (typeof f.id === 'string' && typeof f.file === 'string') map.set(f.id, { file: f.file, line: f.line as string | number | undefined })
    }
  }
  return map
}

const existingTicketsOf = async (runId: string) => ((await readJson(runId, EXISTING_TICKETS_ARTIFACT))?.entries ?? []) as unknown as ExistingTicket[]

/**
 * Marks each draft in ticket-drafts.json that may already be covered, in place,
 * and records the check. Returns how many it marked; 0 when there are no drafts.
 * A draft's earlier mark is replaced, so a re-run gate sees today's answer.
 */
export async function annotateDuplicates(run: WorkflowRun, runs: WorkflowRun[], changed?: (r: WorkflowRun) => Promise<CodeRef[]>): Promise<number> {
  const drafts = await readJson(run.id, DRAFTS_FILE)
  if (!drafts?.entries.length) return 0
  const [findings, tickets, live] = await Promise.all([findingsOf(run.id), existingTicketsOf(run.id), liveRunChanges(run, runs, changed)])
  let marked = 0
  const report: { draft: string, possible_duplicate_of: DuplicateMatch[] }[] = []
  for (const d of drafts.entries) {
    const matches = findDuplicates(d, findings, tickets, live)
    if (matches.length) { d.possible_duplicate_of = matches; marked++ } else delete d.possible_duplicate_of
    report.push({ draft: str(d.draft_id) || str(d.summary), possible_duplicate_of: matches })
  }
  // The entries were changed in place, so the file keeps whatever shape it had.
  await writeArtifactJson(run.id, DRAFTS_FILE, drafts.root)
  await writeArtifactJson(run.id, DUPLICATE_CHECK_FILE, {
    checkedAt: new Date().toISOString(),
    tickets: tickets.length,
    runs: live.map(r => ({ runId: r.runId, ticketKey: r.ticketKey, hunks: r.changes.length })),
    drafts: report,
  })
  return marked
}

/**
 * After the gate: a marked draft is never auto-approved. One the gate approved
 * anyway moves to escalated-drafts.json with the reason a person needs, and an
 * escalated one carries its mark so the review shows it. Returns how many moved.
 */
export async function enforceDuplicateEscalation(runId: string): Promise<number> {
  const drafts = await readJson(runId, DRAFTS_FILE)
  if (!drafts) return 0
  const byId = new Map(drafts.entries.filter(d => typeof d.draft_id === 'string').map(d => [d.draft_id as string, d.possible_duplicate_of as DuplicateMatch[] | undefined]))
  const marks = (e: Entry) => (e.possible_duplicate_of as DuplicateMatch[] | undefined) ?? (typeof e.draft_id === 'string' ? byId.get(e.draft_id) : undefined)

  const approved = await readJson(runId, APPROVED_FILE)
  if (!approved) return 0
  const escalatedRead = await readJson(runId, ESCALATED_FILE)
  // The gate writes both files as arrays (its instructions say so); a wrapped one
  // is rewritten as the array it carries, which every reader accepts.
  const escalated: Entry[] = escalatedRead?.entries ?? []

  let changed = false
  for (const e of escalated) {
    const m = marks(e)
    if (m?.length && !e.possible_duplicate_of) { e.possible_duplicate_of = m; changed = true }
  }
  const keep: Entry[] = []
  let moved = 0
  for (const e of approved.entries) {
    const m = marks(e)
    if (!m?.length) { keep.push(e); continue }
    const gate = (e.gate && typeof e.gate === 'object') ? e.gate as Record<string, unknown> : {}
    const sentence = duplicateSentence(m)
    escalated.push({
      ...e,
      possible_duplicate_of: m,
      gate: {
        ...gate,
        verdict: 'escalated',
        // The panel shows the matches on their own line, from possible_duplicate_of;
        // the prompt names the keys and the reason says why it is here, once each.
        reason: `May duplicate open work, so it is never filed without a person.${gate.reason ? ` The gate had approved it: ${gate.reason}` : ''}`,
        decision_prompt: `${sentence}. File "${str(e.summary) || 'this draft'}" as a new ticket anyway, fold it into ${m.map(x => x.key).join(' or ')}, or skip it?`,
        escalation_criteria: [...new Set([...(Array.isArray(gate.escalation_criteria) ? gate.escalation_criteria.map(String) : []), 'possible_duplicate'])],
      },
    })
    moved++
  }
  if (moved) { await writeArtifactJson(runId, APPROVED_FILE, keep); changed = true }
  if (changed) await writeArtifactJson(runId, ESCALATED_FILE, escalated)
  return moved
}
