/**
 * Team mode must not hand agents an instance-wide Anthropic credential.
 *
 *   node scripts/test-team-compose-credentials.mjs
 *
 * Each developer's agents run on the Claude credential stored on their own
 * profile (envForUser in server/utils/users.ts), and a developer with none is
 * refused. The compose file used to pass ANTHROPIC_API_KEY and
 * CLAUDE_CODE_OAUTH_TOKEN for the whole instance: every developer's runs then
 * drew on one person's subscription, and the value sat in the server's
 * environment, readable by any agent. Putting it back would bring both back.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const compose = readFileSync(join(import.meta.dirname, '..', 'docker-compose.team.yml'), 'utf8')

for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) {
  assert.ok(
    !new RegExp(`^\\s*-\\s*${name}=`, 'm').test(compose),
    `docker-compose.team.yml passes ${name}. A shared instance runs each developer on their own Claude credential, from their Profile page; an instance one is never used and must not sit in the environment.`,
  )
}

// And never a literal one, in any form.
for (const bad of [/sk-ant-api\d\d-\S+/, /sk-ant-oat\d\d-\S+/]) {
  assert.ok(!bad.test(compose), `docker-compose.team.yml contains a literal Anthropic credential (${bad})`)
}

console.log('team compose: no instance Anthropic credential, none literal')
