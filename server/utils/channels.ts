import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { encrypt, decrypt } from './users.ts'
import { createLogger } from './log.ts'

/**
 * Named notification channels for this instance: a Teams or Slack webhook an
 * operator configures once and then refers to BY NAME from a workflow step.
 *
 * The name-not-URL indirection is a correctness requirement, not a preference.
 * Workflow definitions are staged into the distributable image
 * (scripts/stage-claude-config.sh) and written onto the shared team volume by
 * teamSync, so a webhook URL written into a step's config would ship inside a
 * Docker image and sit in a config tree every developer's instance reconciles
 * against. The URL lives here instead, encrypted, under ~/.agent-manager
 * alongside the per-developer profiles - outside the Claude config directory,
 * for exactly the reason users.ts states: nothing in the config tree holds a
 * secret.
 *
 * One file rather than a directory of files, unlike users.ts. A login is a
 * natural shard and profiles are written by different sessions concurrently;
 * channels are a short table an operator edits as a whole, and a single
 * atomic rename is what makes a multi-row save consistent.
 */

const log = createLogger('notify')

/**
 * Slack posts a plain `{ text }`. Teams needs one of two shapes depending on
 * which Microsoft product issued the URL - see bodyFor. Email is not a webhook
 * at all: it carries recipients instead of a URL and sends through the
 * instance's one SMTP relay.
 */
export type ChannelKind = 'teams' | 'slack' | 'email'

export interface Channel {
  /** The identifier a workflow step references. */
  name: string
  kind: ChannelKind
  /** Encrypted, in the same `v1:iv:tag:data` format as a user's Jira token.
   *  Absent on an email channel, which addresses people rather than a URL. */
  url?: string
  /** Email only: who receives it. */
  to?: string[]
  updatedAt: number
  /** The login that last saved it, so a shared instance can answer "who changed this". */
  updatedBy?: string
}

/**
 * The one SMTP relay this instance sends through.
 *
 * Instance-level rather than per-channel, because it is a property of the
 * deployment and not of an audience: five email channels are five recipient
 * lists over one relay, and copying host/port/credentials into each of them
 * would be five places to rotate one password.
 */
export interface SmtpConfig {
  host: string
  port: number
  /** Implicit TLS (port 465). STARTTLS on 587 is the default and needs no flag. */
  secure?: boolean
  user?: string
  /** Encrypted, like a webhook URL. */
  password?: string
  /** The From address. Relays reject a From they do not own, so it is required. */
  from: string
}

export type PublicSmtp = Omit<SmtpConfig, 'password'> & { hasPassword: boolean }

/**
 * What the browser is allowed to see.
 *
 * Mirrors users.ts's PublicProfile: everything except the secret, plus the one
 * fact a person needs to tell two channels apart without being shown either.
 * `host` is safe to reveal - the secrecy of both webhook kinds lives entirely
 * in the path - and it answers "did I paste the Teams URL into the Slack row",
 * which is otherwise unanswerable once the value is write-only.
 */
export type PublicChannel = Omit<Channel, 'url'> & { hasUrl: boolean, host?: string }

interface ChannelStore {
  channels: Channel[]
  smtp?: SmtpConfig
}

const storePath = () => process.env.AGENT_CHANNELS_FILE || join(homedir(), '.agent-manager', 'channels.json')

/**
 * A channel name is a JSON key and a value chosen from a dropdown, never a
 * path segment, so there is no traversal to defend against. The constraint
 * exists so a step's `channel` string and a settings row match exactly:
 * leading spaces and control characters are the ways two names look identical
 * and compare unequal.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/

export function validateChannelName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('A channel name must start with a letter or digit and use only letters, digits, spaces, hyphens and underscores (40 characters max)')
  }
  return name
}

export function validateChannelKind(kind: unknown): ChannelKind {
  if (kind !== 'teams' && kind !== 'slack' && kind !== 'email') {
    throw new Error(`Unknown channel kind ${JSON.stringify(kind)}; it must be "teams", "slack" or "email"`)
  }
  return kind
}

/** Deliberately shallow. A relay is the authority on whether an address exists;
 *  this catches the paste that is obviously not one. */
export function validateRecipients(to: unknown): string[] {
  const list = Array.isArray(to) ? to : String(to ?? '').split(/[,\n;]/)
  const cleaned = list.map(x => String(x).trim()).filter(Boolean)
  if (!cleaned.length) throw new Error('An email channel needs at least one recipient')
  const bad = cleaned.filter(a => !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(a))
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`)
  return cleaned
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Refuses anything that is not an https URL. Every webhook Slack and Teams
 * issue is one, and an http:// paste sends a message somebody can read off the
 * wire — worth catching before it is sealed rather than after it has been used.
 *
 * Loopback is the one exception, so the feature can be exercised against a
 * local sink. It is narrow on purpose: a plaintext webhook to another host is
 * the mistake this catches, and "http to my own machine" is not that mistake.
 */
export function validateWebhookUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) throw new Error('A webhook URL is required')
  let parsed: URL
  try { parsed = new URL(url.trim()) } catch { throw new Error('That is not a URL') }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) {
    throw new Error('A webhook URL must be https (http is allowed only for localhost)')
  }
  return url.trim()
}

async function readStore(): Promise<ChannelStore> {
  const p = storePath()
  if (!existsSync(p)) return { channels: [] }
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8')) as ChannelStore
    return Array.isArray(parsed?.channels) ? parsed : { channels: [] }
  } catch (err) {
    // A store that cannot be read is reported, not silently treated as empty:
    // "no channels configured" and "the channel file is corrupt" lead to very
    // different actions, and a notify step saying the former about the latter
    // would send an operator looking in the wrong place.
    throw new Error(`${p} could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function writeStore(store: ChannelStore): Promise<void> {
  const p = storePath()
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  await rename(tmp, p)
}

function hostOf(sealed: string | undefined): string | undefined {
  if (!sealed) return undefined
  try { return new URL(decrypt(sealed)).host } catch { return undefined }
}

export function toPublicChannel(c: Channel): PublicChannel {
  const { url, ...rest } = c
  const host = url ? hostOf(url) : undefined
  return { ...rest, hasUrl: !!url, ...(host ? { host } : {}) }
}

/** Every channel, secrets included. Server-side callers only. */
export async function listChannels(): Promise<Channel[]> {
  return (await readStore()).channels
}

export async function listPublicChannels(): Promise<PublicChannel[]> {
  return (await listChannels()).map(toPublicChannel)
}

export async function getChannel(name: string): Promise<Channel | null> {
  return (await listChannels()).find(c => c.name === name) ?? null
}

/**
 * Creates or replaces one channel.
 *
 * An absent or empty `url` KEEPS the stored one, which is the same idiom the
 * profile route uses for a Jira token: the value is write-only once saved, so
 * the form cannot echo it back, and an empty field means "unchanged" rather
 * than "clear it". Without this, editing a channel's kind would silently wipe
 * its webhook.
 */
export async function saveChannel(
  name: string,
  patch: { kind: unknown, url?: unknown, to?: unknown },
  updatedBy?: string,
): Promise<PublicChannel> {
  validateChannelName(name)
  const kind = validateChannelKind(patch.kind)
  const store = await readStore()
  const existing = store.channels.find(c => c.name === name)

  let url: string | undefined
  let to: string[] | undefined
  if (kind === 'email') {
    // Recipients are not a secret, so unlike a webhook they are echoed back to
    // the form and an empty list means "no recipients", not "unchanged".
    to = validateRecipients(patch.to)
  } else {
    const hasNewUrl = typeof patch.url === 'string' && patch.url.trim()
    if (!hasNewUrl && existing?.url === undefined) throw new Error('A webhook URL is required')
    url = hasNewUrl ? encrypt(validateWebhookUrl(patch.url)) : existing!.url
  }

  const next: Channel = {
    name, kind, updatedAt: Date.now(),
    ...(url ? { url } : {}), ...(to ? { to } : {}),
    ...(updatedBy ? { updatedBy } : {}),
  }
  store.channels = [...store.channels.filter(c => c.name !== name), next].sort((a, b) => a.name.localeCompare(b.name))
  await writeStore(store)
  log.info('channel saved', { name, kind, by: updatedBy })
  return toPublicChannel(next)
}

/**
 * Removes a channel.
 *
 * Deliberately does NOT scan workflows for steps that name it. A step pointing
 * at a channel that no longer exists says so in its own output when it runs,
 * which is a sentence on the run page; blocking the delete would instead
 * require an operator to hunt through every workflow definition to retire a
 * dead webhook, and the webhook being dead is the usual reason to retire it.
 */
export async function deleteChannel(name: string): Promise<boolean> {
  const store = await readStore()
  const before = store.channels.length
  store.channels = store.channels.filter(c => c.name !== name)
  if (store.channels.length === before) return false
  await writeStore(store)
  log.info('channel deleted', { name })
  return true
}

/** The decrypted URL, for the transport. Separate from getChannel so a caller has to ask. */
export function channelUrl(c: Channel): string {
  if (!c.url) throw new Error(`the channel "${c.name}" has no webhook URL`)
  return decrypt(c.url)
}

/** The instance's SMTP settings, password decrypted, or null when unconfigured. */
export async function getSmtp(): Promise<(Omit<SmtpConfig, 'password'> & { password?: string }) | null> {
  const smtp = (await readStore()).smtp
  if (!smtp?.host || !smtp?.from) return null
  return { ...smtp, password: smtp.password ? decrypt(smtp.password) : undefined }
}

export async function getPublicSmtp(): Promise<PublicSmtp | null> {
  const smtp = (await readStore()).smtp
  if (!smtp) return null
  const { password, ...rest } = smtp
  return { ...rest, hasPassword: !!password }
}

/** An absent or empty password keeps the stored one, exactly as a webhook URL does. */
export async function saveSmtp(patch: {
  host?: unknown, port?: unknown, secure?: unknown, user?: unknown, password?: unknown, from?: unknown,
}): Promise<PublicSmtp> {
  const host = String(patch.host ?? '').trim()
  const from = String(patch.from ?? '').trim()
  if (!host) throw new Error('An SMTP host is required')
  if (!from) throw new Error('A From address is required; relays reject a From they do not own')
  const port = Number(patch.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('An SMTP port must be a number between 1 and 65535')

  const store = await readStore()
  const hasNewPassword = typeof patch.password === 'string' && patch.password.trim()
  const smtp: SmtpConfig = {
    host, port, from,
    ...(patch.secure ? { secure: true } : {}),
    ...(String(patch.user ?? '').trim() ? { user: String(patch.user).trim() } : {}),
    ...(hasNewPassword
      ? { password: encrypt(String(patch.password)) }
      : (store.smtp?.password ? { password: store.smtp.password } : {})),
  }
  store.smtp = smtp
  await writeStore(store)
  log.info('smtp saved', { host, port, from, secure: !!smtp.secure })
  const { password, ...rest } = smtp
  return { ...rest, hasPassword: !!password }
}
