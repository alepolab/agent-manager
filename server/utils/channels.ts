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
 * which Microsoft product issued the URL - see bodyFor.
 *
 * Additive by design: 'email' joins this union without touching the store, the
 * routes or the step config.
 */
export type ChannelKind = 'teams' | 'slack'

export interface Channel {
  /** The identifier a workflow step references. */
  name: string
  kind: ChannelKind
  /** Encrypted, in the same `v1:iv:tag:data` format as a user's Jira token. Never leaves the server. */
  url: string
  updatedAt: number
  /** The login that last saved it, so a shared instance can answer "who changed this". */
  updatedBy?: string
}

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
  if (kind !== 'teams' && kind !== 'slack') throw new Error(`Unknown channel kind ${JSON.stringify(kind)}; it must be "teams" or "slack"`)
  return kind
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

function hostOf(sealed: string): string | undefined {
  try { return new URL(decrypt(sealed)).host } catch { return undefined }
}

export function toPublicChannel(c: Channel): PublicChannel {
  const { url, ...rest } = c
  return { ...rest, hasUrl: !!url, ...(hostOf(url) ? { host: hostOf(url) } : {}) }
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
  patch: { kind: unknown, url?: unknown },
  updatedBy?: string,
): Promise<PublicChannel> {
  validateChannelName(name)
  const kind = validateChannelKind(patch.kind)
  const store = await readStore()
  const existing = store.channels.find(c => c.name === name)
  const hasNewUrl = typeof patch.url === 'string' && patch.url.trim()
  if (!hasNewUrl && !existing) throw new Error('A webhook URL is required')
  const url = hasNewUrl ? encrypt(validateWebhookUrl(patch.url)) : existing!.url

  const next: Channel = { name, kind, url, updatedAt: Date.now(), ...(updatedBy ? { updatedBy } : {}) }
  store.channels = [...store.channels.filter(c => c.name !== name), next].sort((a, b) => a.name.localeCompare(b.name))
  await writeStore(store)
  log.info('channel saved', { name, kind, urlChanged: !!hasNewUrl, by: updatedBy })
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
  return decrypt(c.url)
}
