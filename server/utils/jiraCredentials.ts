/**
 * Jira credential resolution — the one place this app reads Jira config, and
 * the one place a missing credential becomes an explicit, named failure.
 *
 * The TOKEN is still env-only and never invented: that rule is unchanged. The
 * host and the posting gate also read `settings.json` when their variable is
 * unset, so they can be set from the Settings page on an instance nobody has
 * shell access to — an env var set to a non-empty value always wins, so a
 * container pins them exactly as before. See appSettings.ts for the rule.
 *
 * This mirrors Jira Cloud's own documented REST API auth (HTTP
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
import { agentManagerSettings, envFlag, envString, settingString } from './appSettings.ts'

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
 * The instance's Jira host. `JIRA_BASE_URL` still wins, so a container pins it;
 * otherwise it comes from the Settings page. Not a secret - the token is, and
 * that stays per-developer and encrypted in users.ts.
 *
 * `JIRA_SERVER` is kept as the last fallback so a deployment relying on it
 * keeps working unchanged.
 */
export function jiraBaseUrl(): string | undefined {
  const configured = envString(JIRA_BASE_URL_VAR)
    ?? settingString(agentManagerSettings().jira?.baseUrl)
    ?? envString('JIRA_SERVER')
  return configured ? configured.replace(/\/+$/, '') : undefined
}

/**
 * Reads and validates the three required credentials. Throws a single error
 * naming every missing one by its exact env var name — never a generic
 * "not configured" — so the fix is unambiguous from the message alone. This
 * is the "clear, early failure" the missing-credential case must produce:
 * called eagerly by every real code path that needs Jira, never caught and
 * silently downgraded to "no tickets" by this module itself.
 */
export function resolveJiraCredentials(): JiraCredentials {
  const baseUrl = jiraBaseUrl()
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
  return { baseUrl: baseUrl!, email: email!, apiToken: apiToken! }
}

/**
 * Non-throwing presence check — "are all three vars set", not "are they
 * valid". Used only to decide WHICH `TicketSource` to wire at boot
 * (`server/plugins/watcher.ts`): real credential validation still happens
 * lazily, every call, via `resolveJiraCredentials` above.
 */
export function hasJiraCredentialsConfigured(): boolean {
  return Boolean(
    jiraBaseUrl()
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
 * off, which is in fact the required default.
 *
 * Settable from the Settings page, and the four things that keep that safe:
 * the default is still OFF; `JIRA_POST_ENABLED=0` pins it off for the whole
 * instance, which is STRONGER than the old rule, where the only assurance was
 * that nobody edited `.env`; the rendered comment is written to the run's
 * `jira-comment.json` artifact either way, so this decides where a comment
 * goes and never whether one exists; and the change lands as a diffable line
 * in settings.json rather than in someone's shell.
 *
 * `=1` still pins it on. Anything else in the variable pins nothing.
 */
export function isJiraPostingEnabled(): boolean {
  const pinned = envFlag(JIRA_POST_ENABLED_VAR)
  const enabled = pinned ?? (agentManagerSettings().jira?.postEnabled === true)
  log.debug('jira posting enabled check', { enabled, source: pinned !== undefined ? 'env' : 'settings' })
  return enabled
}
