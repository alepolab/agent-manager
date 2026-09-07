/**
 * Team mode must pass the agent SDK a credential it can use.
 *
 *   node scripts/test-team-compose-credentials.mjs
 *
 * The bug this pins: a deployed team instance failed every run at its first
 * step with "Claude Code process exited with code 1". The container had no
 * Anthropic credential of any kind — no ANTHROPIC_API_KEY, no
 * CLAUDE_CODE_OAUTH_TOKEN, no .credentials.json.
 *
 * Two correct decisions with nothing between them: stage-claude-config.sh
 * refuses to bake .credentials.json into a distributable image, and the compose
 * file passed GitHub, Jira, Slack and run budgets but no Anthropic credential.
 * Neither is wrong on its own. The gap only exists between them, which is
 * exactly the kind nothing tests.
 *
 * envForUser (server/utils/users.ts) supplies GH_TOKEN and JIRA_API_TOKEN per
 * developer but no Anthropic credential, so the compose file is the only place
 * one can come from today. If that changes, change this test deliberately.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const compose = readFileSync(join(import.meta.dirname, '..', 'docker-compose.team.yml'), 'utf8')

// Declared, not valued: a real token must never appear in a committed file.
const declared = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
  .filter(name => new RegExp(`^\\s*-\\s*${name}=\\$\\{${name}:-\\}`, 'm').test(compose))

assert.ok(
  declared.length > 0,
  'docker-compose.team.yml must pass an Anthropic credential through from the '
  + 'environment (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). Without one the '
  + 'agent SDK cannot authenticate and every pipeline step dies on "Claude Code '
  + 'process exited with code 1".',
)

// A committed compose file carries the variable, never its value.
for (const bad of [/sk-ant-api\d\d-\S+/, /sk-ant-oat\d\d-\S+/]) {
  assert.ok(!bad.test(compose), `docker-compose.team.yml contains a literal Anthropic credential (${bad})`)
}

console.log(`team compose: passes ${declared.join(' and ')}, no literal credential`)
