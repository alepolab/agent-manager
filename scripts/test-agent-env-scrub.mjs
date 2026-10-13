/**
 * Agents are not handed the server's secrets.
 *
 *   node scripts/test-agent-env-scrub.mjs
 *
 * Every agent used to start from all of process.env, so on a shared instance
 * any agent held AGENT_MANAGER_SECRET - the key every developer's stored
 * GitHub, Jira and Claude tokens are sealed under - and could print it into a
 * step log the way one printed GITHUB_CLIENT_SECRET into a stack report.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'env-scrub-'))
process.env.AGENT_USERS_DIR = dir
process.env.CLAUDE_DIR = join(dir, 'claude')
delete process.env.AUTH_DISABLED
delete process.env.AGENT_ENV_PASSTHROUGH

const { agentBaseEnv, agentEnvFor, launchEnv } = await import('../server/utils/agentCaller.ts')
const { saveProfile, envForUser } = await import('../server/utils/users.ts')

const secrets = {
  AGENT_MANAGER_SECRET: 'k'.repeat(40),
  AGENT_MANAGER_API_TOKEN: 'api-token',
  AGENT_MANAGER_LOGIN_PASSWORD_HASH: 'scrypt$x',
  GITHUB_CLIENT_SECRET: 'oauth-secret',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
  JIRA_API_TOKEN: 'instance-jira',
  AGENT_GH_TOKEN: 'bot-token',
  GH_TOKEN: 'host-gh',
  NPM_TOKEN: 'npm',
  CLAUDE_CODE_MESSAGING_TOKEN: 'parent-session',
  ANTHROPIC_API_KEY: 'sk-ant-api03-INSTANCE',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-INSTANCE',
  DB_PASSWORD: 'pw',
}
const toolchain = {
  PATH: '/usr/bin', HOME: '/home/dev', JAVA_11_HOME: '/opt/j11', SDKMAN_DIR: '/s', CATALINA_HOME: '/c',
  ANTHROPIC_BASE_URL: 'https://proxy.test', GITHUB_ORG: 'alepolab', JIRA_BASE_URL: 'https://jira.test',
  JIRA_EMAIL: 'bot@x', GITHUB_CLIENT_ID: 'id', AGENT_RUN_MAX_MINUTES: '180', STARSHIP_SESSION_KEY: 'abc',
}

// ── the base: secrets out by name and by pattern, the toolchain in ──
{
  const base = agentBaseEnv({ ...secrets, ...toolchain })
  for (const name of Object.keys(secrets)) assert.ok(!(name in base), `${name} is withheld`)
  for (const [name, value] of Object.entries(toolchain)) assert.equal(base[name], value, `${name} passes`)
}

// ── an operator can let a named one through ──
{
  const base = agentBaseEnv({ ...secrets, AGENT_ENV_PASSTHROUGH: ' NPM_TOKEN, JIRA_API_TOKEN ' })
  assert.equal(base.NPM_TOKEN, 'npm')
  assert.equal(base.JIRA_API_TOKEN, 'instance-jira')
  assert.ok(!('AGENT_MANAGER_SECRET' in base), 'and only those')
}

// ── local mode keeps the host's Claude credential, its only one, and nothing else ──
{
  const base = agentBaseEnv({ ...secrets, AUTH_DISABLED: '1' })
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-ant-api03-INSTANCE')
  assert.equal(base.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-INSTANCE')
  assert.ok(!('AGENT_MANAGER_SECRET' in base))
}

// ── end to end: the env an agent is launched with ──
Object.assign(process.env, secrets)
try {
  await saveProfile('alice', { anthropicTokenPlain: 'sk-ant-oat01-ALICE' })
  const env = launchEnv(await agentEnvFor(), await envForUser('alice'))
  for (const name of ['AGENT_MANAGER_SECRET', 'AGENT_MANAGER_API_TOKEN', 'GITHUB_CLIENT_SECRET', 'SLACK_WEBHOOK_URL', 'JIRA_API_TOKEN', 'AGENT_GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
    assert.ok(!(name in env), `${name} does not reach an agent`)
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-ALICE', "the starter's own credential does")
  assert.equal(env.GH_TOKEN, 'bot-token', 'the bot token still arrives, deliberately, as GH_TOKEN')
  assert.ok(env.SDLC_SCRIPTS_DIR && env.PATH, 'and so does everything an agent needs')
} finally {
  for (const name of Object.keys(secrets)) delete process.env[name]
  rmSync(dir, { recursive: true, force: true })
}

console.log('agent env: secrets withheld, toolchain passed, passthrough honoured')
