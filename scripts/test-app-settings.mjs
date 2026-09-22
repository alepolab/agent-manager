/**
 * The precedence rule for everything that moved out of the environment and
 * into settings.json: a NON-EMPTY env var wins, then the saved setting, then
 * the built-in default.
 *
 * The assertion this suite exists for is the empty-string one. `.env.sample`
 * ships `JIRA_POST_ENABLED=`, `JIRA_BASE_URL=` and the rest as bare `NAME=`
 * lines, and dotenv turns those into `''`. If "set" meant "present", every
 * person who copied the sample would be permanently pinned to the default,
 * with a Settings page that accepts a value, says "saved", and changes
 * nothing - which is exactly the live bug this work set out to fix.
 *
 *   node scripts/test-app-settings.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Before the import: claudeDir.ts memoises the directory on first call.
const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'app-settings-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
for (const v of ['JIRA_POST_ENABLED', 'JIRA_BASE_URL', 'JIRA_SERVER', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[v]

const settings = await import('../server/utils/appSettings.ts')
const jira = await import('../server/utils/jiraCredentials.ts')

/** Rewrite settings.json between cases; agentManagerSettings is deliberately uncached. */
function saveSettings(agentManager) {
  writeFileSync(join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager }, null, 2), 'utf-8')
}

// ══ 1. envFlag: the empty-string rule ═══════════════════════════════════════
{
  delete process.env.FLAG_UNDER_TEST
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), undefined, 'THE REQUIREMENT: an unset variable pins nothing')

  process.env.FLAG_UNDER_TEST = ''
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), undefined,
    'THE REQUIREMENT: an empty line copied from .env.sample must not pin the setting')

  process.env.FLAG_UNDER_TEST = '   '
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), undefined, 'whitespace is empty')

  process.env.FLAG_UNDER_TEST = '1'
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), true, '1 pins on')

  process.env.FLAG_UNDER_TEST = '0'
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), false, '0 pins off')

  process.env.FLAG_UNDER_TEST = 'true'
  assert.equal(settings.envFlag('FLAG_UNDER_TEST'), undefined,
    'a value that is neither 1 nor 0 pins nothing, rather than pinning off by accident')
  delete process.env.FLAG_UNDER_TEST

  process.env.STR_UNDER_TEST = ''
  assert.equal(settings.envString('STR_UNDER_TEST'), undefined, 'envString follows the same empty rule')
  process.env.STR_UNDER_TEST = ' spaced '
  assert.equal(settings.envString('STR_UNDER_TEST'), 'spaced', 'and trims')
  delete process.env.STR_UNDER_TEST
}

// ══ 2. Posting to Jira: off by default, settable, pinnable both ways ════════
{
  saveSettings({})
  assert.equal(jira.isJiraPostingEnabled(), false,
    'THE REQUIREMENT: writing to Jira is off until somebody says otherwise')

  process.env.JIRA_POST_ENABLED = ''
  assert.equal(jira.isJiraPostingEnabled(), false, 'an empty variable leaves the default in place')
  delete process.env.JIRA_POST_ENABLED

  saveSettings({ jira: { postEnabled: true } })
  assert.equal(jira.isJiraPostingEnabled(), true, 'the Settings page can turn it on')

  process.env.JIRA_POST_ENABLED = '0'
  assert.equal(jira.isJiraPostingEnabled(), false,
    'THE REQUIREMENT: JIRA_POST_ENABLED=0 pins posting off for the whole instance, over any saved setting')
  delete process.env.JIRA_POST_ENABLED

  saveSettings({ jira: { postEnabled: false } })
  process.env.JIRA_POST_ENABLED = '1'
  assert.equal(jira.isJiraPostingEnabled(), true, 'and =1 pins it on over a saved false')
  delete process.env.JIRA_POST_ENABLED
}

// ══ 3. The Jira host ═══════════════════════════════════════════════════════
{
  saveSettings({})
  assert.equal(jira.jiraBaseUrl(), undefined, 'nothing configured is undefined, never a guess')

  saveSettings({ jira: { baseUrl: 'https://saved.atlassian.net/' } })
  assert.equal(jira.jiraBaseUrl(), 'https://saved.atlassian.net', 'the saved host is used, trailing slash stripped')

  process.env.JIRA_BASE_URL = 'https://pinned.atlassian.net/'
  assert.equal(jira.jiraBaseUrl(), 'https://pinned.atlassian.net',
    'THE REQUIREMENT: the env var wins over the saved host, so a container still pins it')
  process.env.JIRA_BASE_URL = ''
  assert.equal(jira.jiraBaseUrl(), 'https://saved.atlassian.net', 'and an empty one does not')
  delete process.env.JIRA_BASE_URL

  saveSettings({})
  process.env.JIRA_SERVER = 'https://legacy.atlassian.net'
  assert.equal(jira.jiraBaseUrl(), 'https://legacy.atlassian.net',
    'JIRA_SERVER stays the last fallback, so a deployment relying on it keeps working')
  delete process.env.JIRA_SERVER

  // The thrown message still names the env var, because that is still a
  // correct instruction for the credential that is genuinely env-only.
  saveSettings({})
  process.env.JIRA_EMAIL = 'someone@example.com'
  process.env.JIRA_API_TOKEN = 'token'
  assert.throws(() => jira.resolveJiraCredentials(), /JIRA_BASE_URL/,
    'a missing host is still named by its exact variable')
  delete process.env.JIRA_EMAIL
  delete process.env.JIRA_API_TOKEN
}

// ══ 4. The raw settings.json editor can write anything ═════════════════════
{
  saveSettings({ jira: { postEnabled: 'yes', baseUrl: 42, defaultProject: null } })
  assert.equal(jira.isJiraPostingEnabled(), false,
    'THE REQUIREMENT: a bad value written through the raw JSON editor must not turn posting on')
  assert.doesNotThrow(() => jira.jiraBaseUrl(), 'nor stop a run from starting')

  writeFileSync(join(CLAUDE_DIR, 'settings.json'), '{ not json', 'utf-8')
  assert.deepEqual(settings.agentManagerSettings(), {}, 'a malformed settings.json reads back as no settings')
  assert.equal(jira.isJiraPostingEnabled(), false, 'and leaves posting off')
}

rmSync(CLAUDE_DIR, { recursive: true, force: true })
console.log('app-settings: all assertions passed')
