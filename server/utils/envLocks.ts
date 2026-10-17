/**
 * Environment locks: one holder per lab host at a time.
 *
 * A Claude Code session or a sandbox run that is about to deploy to, or test
 * against, a shared host asks for a lock first and gets an ALEPO_ENV_LOCK_TOKEN
 * back; the hooks that gate deployment can then insist on seeing one. Two
 * sessions aiming at the same host cannot both hold a lock, and a lock that is
 * never released still goes away: the TTL is capped at four hours.
 *
 * The store is one JSON file under the Claude directory, `env-locks.json`,
 * written whole on every change (the file is small: a handful of hosts). It is
 * read on every call rather than cached, so two server processes sharing a
 * config directory see the same state - the same reasoning as appSettings.ts.
 * Within one process the write is serialised through `chain`, so two requests
 * for the same host that land together cannot both see it free.
 *
 * Tokens are 32 random bytes, hex. The file holds the token itself, not a
 * hash: the token is a capability to release one lock on a lab host, which is
 * no secret worth a hash, and an operator revoking a lock from the list route
 * needs to see which token the holder was given.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'

export const ENV_LOCKS_FILE = 'env-locks.json'
export const MAX_TTL_MINUTES = 240
export const DEFAULT_TTL_MINUTES = 60

export interface EnvLock {
  host: string
  token: string
  requester: string
  reason: string
  /** Epoch ms. */
  issuedAt: number
  /** Epoch ms; the lock is gone once `now >= expiresAt`. */
  expiresAt: number
}

/** What the list route returns: the token is shown only in its last four characters. */
export type EnvLockView = Omit<EnvLock, 'token'> & { tokenTail: string }

export function envLocksPath(): string {
  return resolveClaudePath(ENV_LOCKS_FILE)
}

/** A host name as given, trimmed and lowercased; anything that is not a hostname or an address is refused. */
export function normalizeHost(host: string): string {
  const h = String(host ?? '').trim().toLowerCase()
  if (!h || h.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) {
    throw new Error(`"${host}" is not a host name`)
  }
  return h
}

async function readAll(): Promise<EnvLock[]> {
  const path = envLocksPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    const locks = Array.isArray(parsed?.locks) ? parsed.locks : []
    return locks.filter((l: unknown): l is EnvLock => !!l && typeof l === 'object' && typeof (l as EnvLock).host === 'string' && typeof (l as EnvLock).token === 'string')
  } catch {
    // An unreadable file is an empty one. The next write replaces it whole.
    return []
  }
}

async function writeAll(locks: EnvLock[]): Promise<void> {
  const path = envLocksPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ locks }, null, 2)}\n`, 'utf-8')
  await rename(tmp, path)
}

let chain: Promise<unknown> = Promise.resolve()
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn)
  chain = next.catch(() => {})
  return next
}

const live = (locks: EnvLock[], now: number) => locks.filter(l => l.expiresAt > now)

export const toView = (l: EnvLock): EnvLockView => {
  const { token, ...rest } = l
  return { ...rest, tokenTail: token.slice(-4) }
}

/** Every lock still in force, expired ones dropped. */
export async function listEnvLocks(now = Date.now()): Promise<EnvLock[]> {
  return live(await readAll(), now)
}

export class EnvLockHeldError extends Error {
  readonly holder: EnvLockView
  constructor(holder: EnvLockView) {
    super(`${holder.host} is locked by ${holder.requester} until ${new Date(holder.expiresAt).toISOString()} (${holder.reason})`)
    this.holder = holder
  }
}

/**
 * Issues a lock on `host` to `requester`, or throws EnvLockHeldError naming
 * the current holder. A requester who already holds the host gets a fresh
 * token and a fresh expiry rather than a refusal: that is a renewal, and
 * refusing it would push a long session into racing its own expiry.
 */
export async function requestEnvLock(input: { host: string, reason: string, ttlMinutes?: number, requester: string }, now = Date.now()): Promise<EnvLock> {
  const host = normalizeHost(input.host)
  const reason = String(input.reason ?? '').trim()
  if (!reason) throw new Error('reason is required: say what the host is being locked for')
  const ttl = input.ttlMinutes === undefined ? DEFAULT_TTL_MINUTES : Number(input.ttlMinutes)
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MINUTES) {
    throw new Error(`ttlMinutes must be between 1 and ${MAX_TTL_MINUTES}`)
  }
  return serialised(async () => {
    const locks = live(await readAll(), now)
    const held = locks.find(l => l.host === host)
    if (held && held.requester !== input.requester) throw new EnvLockHeldError(toView(held))
    const lock: EnvLock = {
      host, reason, requester: input.requester,
      token: randomBytes(32).toString('hex'),
      issuedAt: now,
      expiresAt: now + Math.round(ttl * 60_000),
    }
    await writeAll([...locks.filter(l => l.host !== host), lock])
    return lock
  })
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Releases the lock this token was issued for. False when no live lock carries it. */
export async function releaseEnvLock(token: string, now = Date.now()): Promise<{ released: boolean, host?: string }> {
  const t = String(token ?? '').trim()
  if (!t) return { released: false }
  return serialised(async () => {
    const locks = live(await readAll(), now)
    const hit = locks.find(l => sameToken(l.token, t))
    if (!hit) return { released: false }
    await writeAll(locks.filter(l => l !== hit))
    return { released: true, host: hit.host }
  })
}

/** An operator's revoke, by host: removes whatever lock the host carries. */
export async function revokeEnvLock(host: string, now = Date.now()): Promise<EnvLockView | null> {
  const h = normalizeHost(host)
  return serialised(async () => {
    const locks = live(await readAll(), now)
    const hit = locks.find(l => l.host === h)
    if (!hit) return null
    await writeAll(locks.filter(l => l !== hit))
    return toView(hit)
  })
}

/** Is this token a live lock on `host`? For a hook that wants to check before deploying. */
export async function verifyEnvLock(host: string, token: string, now = Date.now()): Promise<boolean> {
  const h = normalizeHost(host)
  const locks = await listEnvLocks(now)
  return locks.some(l => l.host === h && sameToken(l.token, String(token ?? '')))
}
