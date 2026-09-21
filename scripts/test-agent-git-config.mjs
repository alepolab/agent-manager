/**
 * An agent keeps the git config the deployment passed in.
 *
 *   node scripts/test-agent-git-config.mjs
 *
 * agentEnvFor pinned commit.gpgsign into GIT_CONFIG slot 0 and set
 * GIT_CONFIG_COUNT=1, which overwrote whatever the container had already put
 * there. The local compose file puts `credential.helper=store --file=...` in
 * slot 0, so every agent ran without a credential helper and private clones
 * inside runs died with
 *
 *   fatal: could not read Username for 'https://github.com'
 *
 * while the same clone from the server's own shell worked. Both settings have
 * to survive: the deployment's, and the unsigned-commit one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'gitcfg-'))

const { agentEnvFor } = await import('../server/utils/agentCaller.ts')

const read = (env) => Object.fromEntries(
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) || 0 },
    (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
)

// Nothing preset: gpgsign still lands, in slot 0.
delete process.env.GIT_CONFIG_COUNT
delete process.env.GIT_CONFIG_KEY_0
delete process.env.GIT_CONFIG_VALUE_0
assert.deepEqual(read(await agentEnvFor()), { 'commit.gpgsign': 'false' })

// The deployment's own entry survives, and gpgsign is appended after it.
process.env.GIT_CONFIG_COUNT = '1'
process.env.GIT_CONFIG_KEY_0 = 'credential.helper'
process.env.GIT_CONFIG_VALUE_0 = 'store --file=/home/bun/.git-credentials'
const both = read(await agentEnvFor())
assert.equal(both['credential.helper'], 'store --file=/home/bun/.git-credentials',
  'the helper the container configured must reach the agent, or private clones fail')
assert.equal(both['commit.gpgsign'], 'false',
  'agents hold no signing key and the image has no gpg: the commit would fail')

console.log('ok - agent git config keeps both the deployment entry and commit.gpgsign')
