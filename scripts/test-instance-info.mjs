/**
 * The Instance section of the Settings page is served to a browser, so the one
 * thing it must never carry is a secret's value.
 *
 * Every secret is set to a recognisable sentinel here and the whole serialised
 * payload is searched for it. A presence flag is the feature; the value leaking
 * into a page, a devtools log or a screenshot is the bug, and "we only meant to
 * show whether it is set" is not something a reader of the JSON can verify.
 *
 *   node scripts/test-instance-info.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SENTINEL = 'SENTINEL-DO-NOT-LEAK'
const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'instance-info-'))
process.env.CLAUDE_DIR = CLAUDE_DIR

const SECRETS = [
  'AGENT_MANAGER_SECRET', 'GITHUB_CLIENT_SECRET', 'ANTHROPIC_API_KEY',
  'AGENT_MANAGER_API_TOKEN', 'JIRA_API_TOKEN', 'SLACK_WEBHOOK_URL', 'AGENT_GH_TOKEN',
]
for (const name of SECRETS) process.env[name] = `${SENTINEL}-${name}`
for (const v of ['WATCHER_DISABLED', 'SCHEDULER_DISABLED', 'RUN_QUEUE_DISABLED', 'CI_POLLER_DISABLED',
  'RESUME_ON_BOOT', 'TEAM_SEED_ON_BOOT', 'CI_POLL_SECONDS', 'JIRA_BASE_URL', 'JIRA_POST_ENABLED',
  'AGENT_RUN_MAX_TOKENS', 'AGENT_RUN_MAX_MINUTES', 'JIRA_DEFAULT_PROJECT', 'JIRA_COMMENT_FOR_VIS_NAME']) {
  delete process.env[v]
}

const { instanceInfo } = await import('../server/utils/instanceInfo.ts')

// ══ 1. THE REQUIREMENT: no secret VALUE leaves the server ══════════════════
{
  const payload = JSON.stringify(instanceInfo())
  assert.ok(!payload.includes(SENTINEL),
    'THE REQUIREMENT: the instance payload carries secret names and presence, never a value')

  const { secrets } = instanceInfo()
  for (const name of SECRETS) {
    const row = secrets.find(s => s.name === name)
    assert.ok(row, `${name} is reported at all — an unlisted secret reads as "not configured"`)
    assert.equal(row.set, true, `${name} is reported as set`)
  }

  delete process.env.SLACK_WEBHOOK_URL
  assert.equal(instanceInfo().secrets.find(s => s.name === 'SLACK_WEBHOOK_URL').set, false,
    'unsetting one flips its flag rather than dropping the row')
  process.env.SLACK_WEBHOOK_URL = `${SENTINEL}-SLACK_WEBHOOK_URL`

  process.env.SLACK_WEBHOOK_URL = ''
  assert.equal(instanceInfo().secrets.find(s => s.name === 'SLACK_WEBHOOK_URL').set, false,
    'an empty variable is not configured, the same rule the rest of the settings follow')
}

// ══ 2. `pinned` names exactly the env vars that override a saved setting ═══
{
  assert.deepEqual(instanceInfo().pinned, {},
    'nothing is pinned when no overriding variable is set — the Settings page is then telling the truth')

  process.env.AGENT_RUN_MAX_TOKENS = '4000000'
  process.env.JIRA_BASE_URL = 'https://pinned.atlassian.net'
  assert.deepEqual(instanceInfo().pinned, {
    AGENT_RUN_MAX_TOKENS: '4000000',
    JIRA_BASE_URL: 'https://pinned.atlassian.net',
  }, 'THE REQUIREMENT: every variable overriding an editable field is named, with the value that is actually winning')

  process.env.AGENT_RUN_MAX_TOKENS = ''
  assert.deepEqual(Object.keys(instanceInfo().pinned), ['JIRA_BASE_URL'],
    'an empty variable pins nothing, so a copied .env.sample does not grey out the whole form')
  delete process.env.AGENT_RUN_MAX_TOKENS
  delete process.env.JIRA_BASE_URL
}

// ══ 3. Automations are reported AS BOOTED, per their own switch's polarity ══
{
  const byVar = () => Object.fromEntries(instanceInfo().automations.map(a => [a.envVar, a.enabled]))

  assert.deepEqual(byVar(), {
    WATCHER_DISABLED: true, SCHEDULER_DISABLED: true, RUN_QUEUE_DISABLED: true,
    CI_POLLER_DISABLED: true, RESUME_ON_BOOT: true, TEAM_SEED_ON_BOOT: true,
  }, 'everything is on when nothing is switched off')

  process.env.SCHEDULER_DISABLED = '1'
  assert.equal(byVar().SCHEDULER_DISABLED, false, 'a *_DISABLED=1 switch reads as off')
  delete process.env.SCHEDULER_DISABLED

  // The two boot switches whose polarity is the other way round. Reading these
  // as "=1 means off" would report team seeding as disabled on every instance.
  process.env.RESUME_ON_BOOT = '0'
  assert.equal(byVar().RESUME_ON_BOOT, false, 'RESUME_ON_BOOT=0 is the off value for this one, not =1')
  delete process.env.RESUME_ON_BOOT

  process.env.TEAM_SEED_ON_BOOT = '1'
  assert.equal(byVar().TEAM_SEED_ON_BOOT, true, 'and TEAM_SEED_ON_BOOT=1 is on')
  delete process.env.TEAM_SEED_ON_BOOT

  process.env.CI_POLL_SECONDS = '300'
  const poller = instanceInfo().automations.find(a => a.envVar === 'CI_POLLER_DISABLED')
  assert.match(poller.detail, /every 300s/, 'the poll interval is shown, since it cannot be changed without a restart')
  delete process.env.CI_POLL_SECONDS
}

// ══ 4. Paths and identity ══════════════════════════════════════════════════
{
  const info = instanceInfo()
  assert.equal(info.paths.claudeDir, CLAUDE_DIR, 'the config directory this instance actually reads')
  for (const key of ['agentRunsDir', 'workspaceRoot', 'usersDir']) {
    assert.ok(info.paths[key], `${key} is reported — "no runs" and "wrong directory" look identical otherwise`)
  }
  assert.equal(info.identity.clientIdSet, false, 'the OAuth client id is reported by presence')
  assert.ok(!('clientSecret' in info.identity), 'and the client secret is not in identity at all')
}

rmSync(CLAUDE_DIR, { recursive: true, force: true })
console.log('instance-info: all assertions passed')
