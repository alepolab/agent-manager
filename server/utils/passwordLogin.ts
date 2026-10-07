/**
 * Sign-in with a username and password, for an instance that has no GitHub
 * OAuth app, or wants one door that does not depend on it.
 *
 * One account, configured in the environment: AGENT_MANAGER_LOGIN_USER and
 * AGENT_MANAGER_LOGIN_PASSWORD_HASH. Only a salted scrypt hash is ever stored;
 * `node scripts/hash-password.mjs` makes one without the password touching a
 * file or a command line. Off unless both are set.
 *
 * Guessing is slowed, never locked out. The production runtime hands requests
 * over without a client address, so attempts cannot be told apart by where
 * they come from; they are told apart by a known-device cookie instead:
 *
 * - A browser that has signed in before carries one (an HMAC, so it cannot be
 *   made up, over the login and the password's fingerprint, so it ends when
 *   the password changes). Its attempts have a lane of their own, with their
 *   own backoff: a stranger flooding the sign-in form can never keep a known
 *   device out, and the right password from one always gets in, at worst
 *   after a few seconds.
 * - Every other attempt shares one lane. Attempts in it are checked one at a
 *   time, each failure makes the next wait longer (capped at a few seconds),
 *   and beyond a handful waiting the rest are refused unchecked. A stranger
 *   who keeps that lane full can make a NEW browser wait or be turned away.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
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

/** True when `login` is the password account's name, compared as sign-in compares it. */
export function isPasswordAccountName(login: string): boolean {
  const user = process.env.AGENT_MANAGER_LOGIN_USER?.trim().toLowerCase()
  return !!user && login.trim().toLowerCase() === user
}

// ── known devices ────────────────────────────────────────────────────────

export const DEVICE_COOKIE = 'am_device'
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 90

function deviceKey(): Buffer | null {
  const secret = process.env.AGENT_MANAGER_SECRET
  if (!secret || secret.length < 32) return null
  // Its own key, so a device MAC can never be mistaken for anything else sealed with the secret.
  return createHmac('sha256', secret).update('agent-manager/password-login/known-device/v1').digest()
}

function deviceMac(key: Buffer, id: string, fingerprint: string): string {
  const login = process.env.AGENT_MANAGER_LOGIN_USER!.trim().toLowerCase()
  return createHmac('sha256', key).update(`${id}\n${login}\n${fingerprint}`).digest('base64url')
}

/**
 * The device id in a known-device cookie, or null for a missing, forged or
 * stale one - stale meaning made for another login or an earlier password.
 */
export function knownDevice(cookie: string | null | undefined): string | null {
  const key = deviceKey(), fingerprint = passwordFingerprint()
  if (!cookie || !key || !fingerprint) return null
  const [id, mac] = cookie.split('.')
  if (!id || !mac || !/^[\w-]{16,64}$/.test(id)) return null
  const want = Buffer.from(deviceMac(key, id, fingerprint)), got = Buffer.from(mac)
  return want.length === got.length && timingSafeEqual(want, got) ? id : null
}

/** A known-device cookie for this browser, keeping its id when it already had one. */
export function deviceCookie(id?: string | null): string | null {
  const key = deviceKey(), fingerprint = passwordFingerprint()
  if (!key || !fingerprint) return null
  const deviceId = id || randomBytes(18).toString('base64url')
  return `${deviceId}.${deviceMac(key, deviceId, fingerprint)}`
}

// ── backoff ───────────────────────────────────────────────────────────────

const BASE_DELAY_MS = 250
const MAX_DELAY_MS = 4000
/** A failure older than this no longer slows anyone down. */
const FORGET_AFTER_MS = 15 * 60 * 1000
/** Attempts allowed to wait their turn in the shared lane; more are refused at once. */
const MAX_WAITING = 8
/** A known device's own lane: a person signs in from it, nobody floods it. */
const MAX_WAITING_DEVICE = 2

interface Lane { failures: number, lastFailureAt: number, waiting: number, turn: Promise<unknown> }
const newLane = (): Lane => ({ failures: 0, lastFailureAt: 0, waiting: 0, turn: Promise.resolve() })

let shared = newLane()
const devices = new Map<string, Lane>()
let sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))

/** How long an attempt waits after `n` failures in a row. */
export function backoffMs(n: number): number {
  return n <= 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS)
}

/**
 * Checks a sign-in attempt. Attempts in a lane take turns, so a burst sent at
 * once is checked one after another, each after the delay the failures before
 * it earned: the count is read and updated inside the turn, never across an
 * await another attempt could slip into. The username is compared as well as
 * the password, both in constant time, so a wrong username looks and takes
 * the same as a wrong password.
 *
 * `device` is the attempt's known-device cookie, if any: a valid one puts the
 * attempt in that device's own lane instead of the shared one.
 *
 * `busy` means too many attempts are already waiting in the lane: refused
 * without being checked, so a flood cannot queue up hours of work.
 */
export async function checkPasswordLogin(username: string, password: string, device?: string | null):
  Promise<{ ok: true, login: string, device: string | null } | { ok: false, busy?: number }> {
  if (!passwordLoginConfigured()) return { ok: false }
  const deviceId = knownDevice(device)
  let lane = shared, cap = MAX_WAITING
  if (deviceId) {
    lane = devices.get(deviceId) ?? newLane()
    devices.set(deviceId, lane)
    cap = MAX_WAITING_DEVICE
  }
  if (lane.waiting >= cap) return { ok: false, busy: Math.ceil(MAX_DELAY_MS / 1000) }
  lane.waiting++
  const mine = lane.turn.then(async () => {
    if (Date.now() - lane.lastFailureAt > FORGET_AFTER_MS) lane.failures = 0
    await sleep(backoffMs(lane.failures))
    const user = process.env.AGENT_MANAGER_LOGIN_USER!.trim()
    const a = Buffer.from(username.trim().toLowerCase()), b = Buffer.from(user.toLowerCase())
    const nameOk = a.length === b.length && timingSafeEqual(a, b)
    const passOk = await verifyPassword(password, process.env.AGENT_MANAGER_LOGIN_PASSWORD_HASH!.trim())
    if (nameOk && passOk) {
      lane.failures = 0
      return { ok: true as const, login: user, device: deviceId }
    }
    lane.failures++
    lane.lastFailureAt = Date.now()
    return { ok: false as const }
  })
  lane.turn = mine.catch(() => {})
  try {
    return await mine
  } finally {
    lane.waiting--
  }
}

/** For tests. */
export function _resetBackoff(opts: { sleep?: (ms: number) => Promise<void> } = {}) {
  shared = newLane(); devices.clear()
  sleep = opts.sleep ?? (ms => new Promise<void>(res => setTimeout(res, ms)))
}
