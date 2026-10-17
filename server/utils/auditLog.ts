/**
 * The instance-wide, hash-chained audit log.
 *
 * Each run already has its own `audit.jsonl` (runArtifacts.ts's appendRunAudit)
 * answering "who did what to this run". This is the other question an auditor
 * asks: across the whole instance, in order, what changed and who changed it -
 * the policy, the roles, every gate decision, every run that started and
 * ended, and every tool call a hook chose to report. One file, append-only,
 * and each record carries the sha256 of the one before it, so a line removed
 * or edited after the fact breaks every hash that follows and verifyAuditChain
 * says where.
 *
 * Location: `<AGENT_RUNS_DIR or CLAUDE_DIR>/audit/audit.jsonl`. Beside the
 * run evidence when that root is configured (the same reasoning as
 * runArtifacts.ts: that directory is written by the server with `fs`, never
 * through an agent's Write tool), otherwise under the config directory.
 *
 * The chain is a tamper-EVIDENT control, not a tamper-PROOF one. Someone with
 * write access to the file can rewrite the whole chain from the first broken
 * record on; what they cannot do is change one line and leave the rest
 * looking untouched. Shipping the latest hash somewhere else - a Jira comment,
 * a Slack message - is what turns evident into proof, and that is a later
 * change, not this one.
 *
 * A failed append is logged and never thrown to the caller: the action it
 * records (a role changed, a gate approved) has already happened, and failing
 * the request would tell the operator it had not. `appendAudit` resolves to
 * the record it wrote, or null when it could not.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir } from './claudeDir.ts'
import { createLogger } from './log.ts'

const log = createLogger('runner')

export const AUDIT_DIR_NAME = 'audit'
export const AUDIT_FILE_NAME = 'audit.jsonl'

/** What a record is about. Free-form on the type side so a hook can name a kind of its own, but these are the ones this app writes. */
export type AuditKind = 'policy' | 'roles' | 'decision' | 'run-start' | 'run-end' | 'tool-use' | (string & {})

export interface AuditRecord {
  /** 1-based position in the chain. */
  seq: number
  /** ISO-8601 time the record was appended. */
  ts: string
  /** Who did it: a login, `api-token:<login>`, `runner`, or an agent's `agent:<slug>`. */
  actor: string
  kind: AuditKind
  /** What it is about: a run id, a ticket key, a login, 'risk-policy'. */
  ref: string
  payload: Record<string, unknown>
  /** The previous record's `hash`; the 64-zero string for the first record. */
  prevHash: string
  /** sha256 (hex) of the canonical JSON of this record without `hash`. */
  hash: string
}

/** What a caller hands appendAudit: the chain fields are filled in here. */
export type AuditInput = Pick<AuditRecord, 'actor' | 'kind' | 'ref' | 'payload'> & { ts?: string }

export const GENESIS_HASH = '0'.repeat(64)

/** Where the chain lives. A function, not a constant: tests move the roots. */
export function auditLogPath(): string {
  const root = process.env.AGENT_RUNS_DIR || getClaudeDir()
  return join(root, AUDIT_DIR_NAME, AUDIT_FILE_NAME)
}

/**
 * Canonical JSON: keys sorted at every depth, no whitespace, so the hash does
 * not depend on the order a caller built an object in. Arrays keep their
 * order, which is part of their meaning. `undefined` values are dropped, as
 * JSON.stringify would drop them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** The hash a record should carry: sha256 of its canonical JSON without `hash`. */
export function hashRecord(record: Omit<AuditRecord, 'hash'> & { hash?: string }): string {
  const { hash: _hash, ...rest } = record
  return sha256(canonicalJson(rest))
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Every parseable line, in file order. A line that is not JSON is kept as `null` so positions still line up with the file. */
async function readLines(): Promise<(AuditRecord | null)[]> {
  const path = auditLogPath()
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf-8')
  return text.split('\n').filter(l => l.trim()).map((l) => {
    try { return JSON.parse(l) as AuditRecord } catch { return null }
  })
}

/** The whole chain, parseable records only, in order. */
export async function readAudit(): Promise<AuditRecord[]> {
  return (await readLines()).filter((r): r is AuditRecord => r !== null)
}

/**
 * Walk the chain and check every link. `brokenAt` is the `seq` of the first
 * record whose hash does not match its content, whose `prevHash` does not match
 * the record before it, or whose `seq` is out of order - or the 1-based line
 * number of a line that is not JSON at all. `count` is how many records were
 * read, broken or not.
 */
export async function verifyAuditChain(): Promise<{ ok: boolean, count: number, brokenAt?: number, reason?: string }> {
  const lines = await readLines()
  let prev = GENESIS_HASH
  for (let i = 0; i < lines.length; i++) {
    const r = lines[i]
    const seq = i + 1
    if (!r) return { ok: false, count: lines.length, brokenAt: seq, reason: 'line is not JSON' }
    if (r.seq !== seq) return { ok: false, count: lines.length, brokenAt: seq, reason: `seq is ${r.seq}, expected ${seq}` }
    if (r.prevHash !== prev) return { ok: false, count: lines.length, brokenAt: seq, reason: 'prevHash does not match the record before it' }
    if (hashRecord(r) !== r.hash) return { ok: false, count: lines.length, brokenAt: seq, reason: 'hash does not match the record\'s content' }
    prev = r.hash
  }
  return { ok: true, count: lines.length }
}

export interface AuditQuery {
  /** Matches `ref`, or `payload.ticket` / `payload.ticketKey`. */
  ticket?: string
  actor?: string
  kind?: string
  /** ISO time or epoch ms; inclusive. */
  from?: string | number
  /** ISO time or epoch ms; inclusive. */
  to?: string | number
  /** Newest first, capped here. Default 200. */
  limit?: number
}

const toMs = (v: string | number | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : (/^\d+$/.test(v) ? Number(v) : Date.parse(v))
  return Number.isFinite(n) ? n : undefined
}

/** Records matching every given filter, newest first. */
export async function queryAudit(q: AuditQuery = {}): Promise<AuditRecord[]> {
  const from = toMs(q.from), to = toMs(q.to)
  const limit = Math.max(1, Math.min(Number(q.limit) || 200, 5000))
  const all = await readAudit()
  const out: AuditRecord[] = []
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const r = all[i]!
    if (q.kind && r.kind !== q.kind) continue
    if (q.actor && r.actor !== q.actor) continue
    if (q.ticket && r.ref !== q.ticket && r.payload?.ticket !== q.ticket && r.payload?.ticketKey !== q.ticket) continue
    const ts = Date.parse(r.ts)
    if (from !== undefined && ts < from) continue
    if (to !== undefined && ts > to) continue
    out.push(r)
  }
  return out
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * The tail of the chain as last seen by this process, so an append need not
 * re-read the file each time. Loaded from disk on the first append (or after a
 * reset), and after any append that failed, since the file's real tail is then
 * unknown. Process-local, like every other claim in this app.
 */
let tail: { path: string, seq: number, hash: string } | null = null

/** Appends run strictly one after another: two concurrent appends must not both read the same tail. */
let chain: Promise<unknown> = Promise.resolve()

async function loadTail(path: string): Promise<{ path: string, seq: number, hash: string }> {
  const lines = await readLines()
  const last = lines.length ? lines[lines.length - 1] : null
  // A trailing line that does not parse (a crash mid-write) is still a line:
  // verifyAuditChain will report it, and the next record continues after it
  // by position so that report stays accurate.
  return { path, seq: lines.length, hash: last?.hash ?? (lines.length ? '' : GENESIS_HASH) }
}

/**
 * Append one record to the chain. Resolves to the record as written, or null
 * when the write failed (which is logged, never thrown - see the file header).
 */
export function appendAudit(input: AuditInput): Promise<AuditRecord | null> {
  const next = chain.then(async () => {
    const path = auditLogPath()
    try {
      if (!tail || tail.path !== path) tail = await loadTail(path)
      const partial: Omit<AuditRecord, 'hash'> = {
        seq: tail.seq + 1,
        ts: input.ts ?? new Date().toISOString(),
        actor: input.actor,
        kind: input.kind,
        ref: input.ref,
        payload: input.payload ?? {},
        prevHash: tail.hash,
      }
      const record: AuditRecord = { ...partial, hash: hashRecord(partial) }
      await mkdir(join(path, '..'), { recursive: true })
      await appendFile(path, `${JSON.stringify(record)}\n`, 'utf-8')
      tail = { path, seq: record.seq, hash: record.hash }
      return record
    } catch (err) {
      tail = null
      log.warn('audit append failed', { kind: input.kind, ref: input.ref, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  })
  chain = next.catch(() => {})
  return next
}

/** Forget the cached tail. Tests that rewrite the file call this. */
export function resetAuditCache(): void {
  tail = null
}
