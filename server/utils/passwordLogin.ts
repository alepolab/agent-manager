/**
 * Sign-in with a username and password, for an instance that has no GitHub
 * OAuth app, or wants one door that does not depend on it.
 *
 * One account, configured in the environment: AGENT_MANAGER_LOGIN_USER and
 * AGENT_MANAGER_LOGIN_PASSWORD_HASH. Only a salted scrypt hash is ever stored;
 * `node scripts/hash-password.mjs` makes one without the password touching a
 * file or a command line. Off unless both are set.
 *
 * Repeated failures from one address are refused for a while before the
 * password is even checked, so the form cannot be used to guess at speed.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number, r: number, p: number, maxmem: number }) => Promise<Buffer>

const N = 16384, R = 8, P = 1, KEYLEN = 32
const MAXMEM = 64 * 1024 * 1024

/** `scrypt$N$r$p$<salt b64>$<hash b64>`: everything needed to check it again. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  if (!expected.length) return false
  try {
    const actual = await scrypt(plain, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM })
    return timingSafeEqual(actual, expected)
  } catch {
    // A malformed parameter in the stored hash is a wrong password, never a 500.
    return false
  }
}

export function passwordLoginConfigured(): boolean {
  return !!process.env.AGENT_MANAGER_LOGIN_USER?.trim() && !!process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH?.trim()
}

// ── throttle ──────────────────────────────────────────────────────────────

const MAX_FAILURES = 5
const WINDOW_MS = 10 * 60 * 1000
const failures = new Map<string, number[]>()

const recent = (addr: string, now: number) => (failures.get(addr) ?? []).filter(t => now - t < WINDOW_MS)

/** Seconds until `addr` may try again, or 0. */
export function lockedFor(addr: string, now = Date.now()): number {
  const times = recent(addr, now)
  if (times.length < MAX_FAILURES) return 0
  return Math.ceil((times[0]! + WINDOW_MS - now) / 1000)
}

/**
 * Checks a sign-in attempt from `addr`. The username is compared as well as
 * the password, both in constant time, so the answer to a wrong username
 * looks and takes the same as the answer to a wrong password.
 */
export async function checkPasswordLogin(username: string, password: string, addr: string, now = Date.now()):
  Promise<{ ok: true, login: string } | { ok: false, retryAfter?: number }> {
  if (!passwordLoginConfigured()) return { ok: false }
  const wait = lockedFor(addr, now)
  if (wait) return { ok: false, retryAfter: wait }
  const user = process.env.AGENT_MANAGER_LOGIN_USER!.trim()
  const a = Buffer.from(username.trim().toLowerCase()), b = Buffer.from(user.toLowerCase())
  const nameOk = a.length === b.length && timingSafeEqual(a, b)
  const passOk = await verifyPassword(password, process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH!.trim())
  if (nameOk && passOk) {
    failures.delete(addr)
    return { ok: true, login: user }
  }
  failures.set(addr, [...recent(addr, now), now])
  return { ok: false }
}

/** For tests. */
export function _resetThrottle() { failures.clear() }
