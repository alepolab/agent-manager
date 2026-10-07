/**
 * Sign-in with a username and password, for an instance that has no GitHub
 * OAuth app, or wants one door that does not depend on it.
 *
 * One account, configured in the environment: AGENT_MANAGER_LOGIN_USER and
 * AGENT_MANAGER_LOGIN_PASSWORD_HASH. Only a salted scrypt hash is ever stored;
 * `node scripts/hash-password.mjs` makes one without the password touching a
 * file or a command line. Off unless both are set.
 *
 * Guessing is slowed per account, not per address: the production runtime
 * hands requests over without a client address, so a per-address limit was
 * one shared bucket, and a hard lockout on it let anyone keep the owner out.
 * Attempts are checked one at a time, each failure makes the next attempt wait
 * longer (capped at a few seconds), and nothing ever refuses the right
 * password.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { getProfile } from './users.ts'

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number, r: number, p: number, maxmem: number }) => Promise<Buffer>

// OWASP's floor for scrypt. A hash made with other parameters keeps verifying:
// they are read back from the hash itself.
const N = 2 ** 17, R = 8, P = 1, KEYLEN = 32
// 128 * N * r is 128 MiB at the default; room for one step stronger.
const MAXMEM = 256 * 1024 * 1024

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
  } catch (err: any) {
    // Still a refusal, never a 500 - but a hash this server cannot check is a
    // configuration fault, and reported as a wrong password nobody would find it.
    console.error(`[password login] AGENT_MANAGER_LOGIN_PASSWORD_HASH cannot be checked (${err?.code ?? err?.message}); make a new one with scripts/hash-password.mjs`)
    return false
  }
}

export function passwordLoginConfigured(): boolean {
  return !!process.env.AGENT_MANAGER_LOGIN_USER?.trim() && !!process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH?.trim()
}

/**
 * A short digest of the configured hash, sealed into each password session.
 * Changing the password changes it, which signs every password session out
 * without touching AGENT_MANAGER_SECRET or anyone's stored tokens.
 */
export function passwordFingerprint(): string | null {
  if (!passwordLoginConfigured()) return null
  return createHash('sha256').update(process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH!.trim()).digest('base64url').slice(0, 16)
}

/**
 * True when the configured username is a GitHub user's login here. The
 * password session would then be that person: their stored GitHub token on
 * every run started from it, their commit identity, their profile.
 */
export async function passwordAccountTakenBy(login: string): Promise<boolean> {
  const profile = await getProfile(login)
  return !!(profile?.githubId || profile?.githubToken)
}

// ── backoff ───────────────────────────────────────────────────────────────

const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 4000
/** A failure older than this no longer slows anyone down. */
const FORGET_AFTER_MS = 15 * 60 * 1000
/** Attempts allowed to wait their turn; more than this are refused at once. */
const MAX_WAITING = 8

let failures = 0
let lastFailureAt = 0
let waiting = 0
let turn: Promise<unknown> = Promise.resolve()
let sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

/** How long an attempt waits after `n` failures in a row. */
export function backoffMs(n: number): number {
  return n <= 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS)
}

/**
 * Checks a sign-in attempt. Attempts take turns, so a burst sent at once is
 * checked one after another, each after the delay the failures before it
 * earned: the count is read and updated inside the turn, never across an
 * await another attempt could slip into. The username is compared as well as
 * the password, both in constant time, so a wrong username looks and takes
 * the same as a wrong password.
 *
 * `busy` means too many attempts are already waiting: refused without being
 * checked, so a flood cannot queue up hours of work.
 */
export async function checkPasswordLogin(username: string, password: string):
  Promise<{ ok: true, login: string } | { ok: false, busy?: number }> {
  if (!passwordLoginConfigured()) return { ok: false }
  if (waiting >= MAX_WAITING) return { ok: false, busy: Math.ceil(MAX_DELAY_MS / 1000) }
  waiting++
  const mine = turn.then(async () => {
    if (Date.now() - lastFailureAt > FORGET_AFTER_MS) failures = 0
    await sleep(backoffMs(failures))
    const user = process.env.AGENT_MANAGER_LOGIN_USER!.trim()
    const a = Buffer.from(username.trim().toLowerCase()), b = Buffer.from(user.toLowerCase())
    const nameOk = a.length === b.length && timingSafeEqual(a, b)
    const passOk = await verifyPassword(password, process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH!.trim())
    if (nameOk && passOk) {
      failures = 0
      return { ok: true as const, login: user }
    }
    failures++
    lastFailureAt = Date.now()
    return { ok: false as const }
  })
  turn = mine.catch(() => {})
  try {
    return await mine
  } finally {
    waiting--
  }
}

/** For tests. */
export function _resetBackoff(opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  failures = 0; lastFailureAt = 0; waiting = 0; turn = Promise.resolve()
  sleep = opts.sleep ?? (ms => new Promise<void>(res => setTimeout(res, ms)))
}
