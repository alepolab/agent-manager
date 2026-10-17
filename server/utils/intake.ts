/**
 * The signed webhook intake: Jira (or anything that can sign a body) tells this
 * instance a ticket wants a run.
 *
 * Authentication is an HMAC-SHA256 over the RAW request body with the shared
 * `agentManager.intakeSecret` from settings.json, presented in
 * `X-Alepo-Signature` as hex (a `sha256=` prefix is accepted, as GitHub sends
 * it). Compared in constant time. No secret configured means every call is
 * refused: a webhook that accepts anything when unconfigured is an open run
 * starter.
 *
 * Idempotent per issue key, by the same rule a watch uses to decide not to
 * dispatch a ticket twice: a live run on that key (findLiveRunForTicket, the
 * check manual starts use) means the intake is recorded as a duplicate and no
 * second run starts. Every intake, accepted or not, lands in
 * `<CLAUDE_DIR>/intake/<issueKey>.json` so a replayed webhook can be seen.
 *
 * `X-Shadow: 1` records the intake and starts nothing: the switch a team flips
 * while it watches what a live hook WOULD do before letting it do it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { agentManagerSettings, settingString } from './appSettings.ts'
import { resolveClaudeFile, resolveClaudePath } from './claudeDir.ts'
import { findLiveRunForTicket } from './manualStart.ts'
import { createLogger } from './log.ts'

const log = createLogger('intake')

export const INTAKE_DIR_NAME = 'intake'
export const INTAKE_SIGNATURE_HEADER = 'x-alepo-signature'
export const INTAKE_SHADOW_HEADER = 'x-shadow'

export interface IntakePayload {
  issueKey: string
  project?: string
  reporter?: string
}

export type IntakeDisposition = 'started' | 'shadow' | 'duplicate' | 'recorded'

export interface IntakeRecord {
  issueKey: string
  project?: string
  reporter?: string
  receivedAt: number
  disposition: IntakeDisposition
  /** The run this intake started, or the live run it was a duplicate of. */
  runId?: string
  /** How many times this key has arrived, this record included. */
  deliveries: number
}

/** The secret the route checks against; undefined when unset. */
export function intakeSecret(): string | undefined {
  return settingString(agentManagerSettings().intakeSecret)
}

export function signIntake(rawBody: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Constant-time check of the presented signature over the raw body. */
export function verifyIntakeSignature(rawBody: string | Buffer, presented: string | undefined, secret: string | undefined): boolean {
  if (!secret || !presented) return false
  const want = Buffer.from(signIntake(rawBody, secret), 'hex')
  const hex = presented.trim().replace(/^sha256=/i, '')
  if (!/^[0-9a-f]+$/i.test(hex)) return false
  const got = Buffer.from(hex, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

/** The payload, or why it is not one. Keys look like `ABC-123`; anything else is refused. */
export function parseIntake(raw: unknown): { payload: IntakePayload } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the body must be a JSON object' }
  const b = raw as Record<string, unknown>
  const issueKey = typeof b.issueKey === 'string' ? b.issueKey.trim().toUpperCase() : ''
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(issueKey)) return { error: 'issueKey must look like ABC-123' }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return { payload: { issueKey, project: str(b.project) ?? issueKey.split('-')[0], reporter: str(b.reporter) } }
}

const recordPath = (issueKey: string) => resolveClaudeFile(INTAKE_DIR_NAME, issueKey)

export async function readIntake(issueKey: string): Promise<IntakeRecord | null> {
  const path = recordPath(issueKey)
  if (!existsSync(path)) return null
  try { return JSON.parse(await readFile(path, 'utf-8')) as IntakeRecord } catch { return null }
}

async function writeIntake(record: IntakeRecord): Promise<void> {
  const dir = resolveClaudePath(INTAKE_DIR_NAME)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(recordPath(record.issueKey), `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
}

/** What starts a run for an accepted intake. A seam, so the route is testable without the runner. */
export type IntakeStarter = (payload: IntakePayload) => Promise<{ runId: string } | null>

/**
 * Records the intake and, unless shadowed or a duplicate, hands it to `start`.
 * `start` returning null means nothing is configured to start (no intake
 * workflow); the intake is then `recorded`, which is also what a team gets
 * before they have wired one.
 */
export async function acceptIntake(payload: IntakePayload, opts: { shadow: boolean, start: IntakeStarter }): Promise<IntakeRecord> {
  const prior = await readIntake(payload.issueKey)
  const base = { ...payload, receivedAt: Date.now(), deliveries: (prior?.deliveries ?? 0) + 1 }
  let record: IntakeRecord
  if (opts.shadow) {
    record = { ...base, disposition: 'shadow', ...(prior?.runId ? { runId: prior.runId } : {}) }
  } else {
    // The duplicate check watches and manual starts share: a live run on the
    // key. Settled runs do not count - a ticket reopened a month later is a
    // new piece of work, and an intake for it should start one.
    const live = await findLiveRunForTicket(payload.issueKey)
    if (live) {
      record = { ...base, disposition: 'duplicate', runId: live.id }
    } else {
      const started = await opts.start(payload)
      record = started ? { ...base, disposition: 'started', runId: started.runId } : { ...base, disposition: 'recorded' }
    }
  }
  await writeIntake(record)
  log.info('intake', { issueKey: record.issueKey, disposition: record.disposition, runId: record.runId, deliveries: record.deliveries })
  return record
}
