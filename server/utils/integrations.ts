import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { encrypt, decrypt } from './users.ts'

/**
 * Instance-wide integrations an operator configures, rather than a deployer.
 *
 * Slack notification has been code-complete and fully wired for some time —
 * the runner announces every transition, the CI poller announces a red check
 * and a gate left waiting — and it reached nobody, because the only way to
 * point it at a channel was a SLACK_WEBHOOK_URL environment variable on the
 * container. A platform review of thirteen real runs found the path "never
 * once fired"; a run sat paused on its budget for twenty hours and a gate
 * went fifteen hours unanswered, and the feature that existed to say so was
 * switched off by omission with no way to switch it on from the app.
 *
 * So the webhook is storable here as well. Same shape as the per-developer
 * credentials in users.ts and for the same reasons: encrypted at rest with
 * AGENT_MANAGER_SECRET, kept in ~/.agent-manager rather than the team's
 * ~/.claude so no secret lands in the config tree, and never returned to the
 * browser — the API answers `configured: true`, never the URL.
 *
 * The environment variable still wins where it is set, so a deployment that
 * already configures one keeps working and nothing here can silently
 * redirect it.
 */

export interface Integrations {
  /** Encrypted. Absent when nothing has been stored. */
  slackWebhook?: string
  updatedAt?: number
}

/** What the browser is allowed to know: that it is set, never what it is. */
export interface PublicIntegrations {
  slack: {
    configured: boolean
    /** 'env' when the deployment supplies it, 'stored' when an operator did. */
    source: 'env' | 'stored' | 'none'
    /** Why it cannot be stored, when that is the case. */
    unavailable?: string
    updatedAt?: number
  }
}

const dir = () => process.env.AGENT_USERS_DIR || join(homedir(), '.agent-manager', 'users')
const filePath = () => join(dirname(dir()), 'integrations.json')

async function read(): Promise<Integrations> {
  const p = filePath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as Integrations
  } catch {
    // A corrupt file must not take the instance down, and must not read as
    // "nothing configured" to a writer that would then overwrite it blind.
    // Callers see no webhook; the write path below refuses to clobber, since
    // it writes a whole fresh object only on an explicit set.
    return {}
  }
}

async function write(next: Integrations): Promise<void> {
  const p = filePath()
  await mkdir(dirname(p), { recursive: true })
  // Same atomic replace users.ts uses: a half-written credential file is
  // worse than an absent one.
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  await rename(tmp, p)
}

/** Whether a webhook can be stored at all on this instance. */
export function canStoreSecrets(): string | null {
  return process.env.AGENT_MANAGER_SECRET ? null : 'AGENT_MANAGER_SECRET is not set, so this instance cannot store a credential.'
}

/**
 * The webhook to post to, or null.
 *
 * The environment wins: a deployment that sets it keeps the behaviour it had,
 * and an operator cannot quietly redirect an instance's notifications by
 * storing a different one.
 */
export async function slackWebhookUrl(): Promise<string | null> {
  const fromEnv = process.env.SLACK_WEBHOOK_URL
  if (fromEnv) return fromEnv
  const stored = (await read()).slackWebhook
  if (!stored) return null
  try {
    return decrypt(stored)
  } catch {
    // A secret that no longer decrypts — AGENT_MANAGER_SECRET rotated — is
    // not a webhook. Saying nothing is configured is the honest answer, and
    // the settings page shows the same thing, so the two agree.
    return null
  }
}

export async function publicIntegrations(): Promise<PublicIntegrations> {
  const unavailable = canStoreSecrets()
  if (process.env.SLACK_WEBHOOK_URL) {
    return { slack: { configured: true, source: 'env' } }
  }
  const current = await read()
  const stored = !!current.slackWebhook
  return {
    slack: {
      configured: stored,
      source: stored ? 'stored' : 'none',
      ...(unavailable ? { unavailable } : {}),
      ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
    },
  }
}

/** Slack's own shape for an incoming webhook. Rejected early so a typo does
 *  not become a silent non-delivery weeks later, which is the failure this
 *  whole module exists to end. */
export function slackWebhookProblem(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'That is not a URL.' }
  if (parsed.protocol !== 'https:') return 'A Slack webhook URL is https.'
  if (parsed.hostname !== 'hooks.slack.com') return `A Slack webhook is hosted at hooks.slack.com, not ${parsed.hostname}.`
  if (!parsed.pathname.startsWith('/services/')) return 'A Slack webhook path begins with /services/.'
  return null
}

/** Store a webhook, or clear it with an empty string. */
export async function setSlackWebhook(url: string): Promise<void> {
  const trimmed = url.trim()
  if (!trimmed) {
    const current = await read()
    delete current.slackWebhook
    await write({ ...current, updatedAt: Date.now() })
    return
  }
  const problem = slackWebhookProblem(trimmed)
  if (problem) throw new Error(problem)
  await write({ ...(await read()), slackWebhook: encrypt(trimmed), updatedAt: Date.now() })
}
