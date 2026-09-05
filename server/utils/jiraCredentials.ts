/**
 * Jira credential resolution — the one place this app reads Jira config
 * from the environment, and the one place a missing credential becomes an
 * explicit, named failure.
 *
 * No token is embedded, invented, or read from anywhere but these three
 * env vars. This mirrors Jira Cloud's own documented REST API auth (HTTP
 * Basic, `<account email>:<API token>` — see
 * developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis),
 * the same mechanism `.env.sample`'s existing `ANTHROPIC_API_KEY` pattern
 * already establishes for this repo: a named env var, resolved lazily at
 * use time, never a hardcoded fallback.
 *
 * `resolveJiraCredentials()` is called by `jiraTicketSource.ts` on every
 * `fetch()` and by `ticketNotifier.ts` only when posting is enabled — never
 * at module import time, so an app with no Jira configuration at all keeps
 * booting and running the file-backed stub exactly as it does today.
 */

import { createLogger, secretShape } from './log.ts'

const log = createLogger('jira')

export const JIRA_BASE_URL_VAR = 'JIRA_BASE_URL'
export const JIRA_EMAIL_VAR = 'JIRA_EMAIL'
export const JIRA_API_TOKEN_VAR = 'JIRA_API_TOKEN'

/**
 * Writing to Jira (posting or transitioning a comment) requires explicit,
 * separate opt-in — the user's own standard is that creating/transitioning
 * Jira issues or posting comments is a confirm-before-acting operation, so
 * this must default OFF regardless of whether credentials happen to be
 * configured. Must be exactly '1' — any other value (including 'true',
 * '0', unset) leaves posting disabled.
 */
export const JIRA_POST_ENABLED_VAR = 'JIRA_POST_ENABLED'

export interface JiraCredentials {
  baseUrl: string
  email: string
  apiToken: string
}

/**
 * Reads and validates the three required env vars. Throws a single error
 * naming every missing one by its exact env var name — never a generic
 * "not configured" — so the fix is unambiguous from the message alone. This
 * is the "clear, early failure" the missing-credential case must produce:
 * called eagerly by every real code path that needs Jira, never caught and
 * silently downgraded to "no tickets" by this module itself.
 */
export function resolveJiraCredentials(): JiraCredentials {
  const baseUrl = process.env[JIRA_BASE_URL_VAR]?.trim()
  const email = process.env[JIRA_EMAIL_VAR]?.trim()
  const apiToken = process.env[JIRA_API_TOKEN_VAR]?.trim()

  const missing = [
    !baseUrl && JIRA_BASE_URL_VAR,
    !email && JIRA_EMAIL_VAR,
    !apiToken && JIRA_API_TOKEN_VAR,
  ].filter((v): v is string => Boolean(v))

  if (missing.length > 0) {
    // Names only, never values — the missing list is exactly the set of env
    // var NAMES above, which is safe to log as-is.
    log.warn('jira credentials missing', { missing })
    throw new Error(
      `Jira credentials are not configured: missing ${missing.join(', ')}. ` +
      `Set ${missing.join(' and ')} in the environment to enable the Jira ticket source — ` +
      `this app never invents or falls back to a different credential.`,
    )
  }

  log.debug('jira credentials resolved', () => ({
    baseUrlLength: baseUrl!.length, email: secretShape(email), apiToken: secretShape(apiToken),
  }))
  return { baseUrl: baseUrl!.replace(/\/+$/, ''), email: email!, apiToken: apiToken! }
}

/**
 * Non-throwing presence check — "are all three vars set", not "are they
 * valid". Used only to decide WHICH `TicketSource` to wire at boot
 * (`server/plugins/watcher.ts`): real credential validation still happens
 * lazily, every call, via `resolveJiraCredentials` above.
 */
export function hasJiraCredentialsConfigured(): boolean {
  return Boolean(
    process.env[JIRA_BASE_URL_VAR]?.trim()
    && process.env[JIRA_EMAIL_VAR]?.trim()
    && process.env[JIRA_API_TOKEN_VAR]?.trim(),
  )
}

/** HTTP Basic auth header value for Jira Cloud's REST API: `email:apiToken`,
 *  base64-encoded. Never logged, never written to a file — callers pass it
 *  straight into a fetch `Authorization` header. */
export function jiraAuthHeader(creds: JiraCredentials): string {
  return `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`
}

/**
 * Whether this process is allowed to actually write to Jira. Checked
 * independently of `resolveJiraCredentials` — a deployment can have valid
 * credentials configured (needed to *read* tickets) while posting stays
 * off, which is in fact the required default. Must be exactly '1'.
 */
export function isJiraPostingEnabled(): boolean {
  const enabled = process.env[JIRA_POST_ENABLED_VAR] === '1'
  log.debug('jira posting enabled check', { enabled })
  return enabled
}
