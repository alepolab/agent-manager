/**
 * Self-checks for the boot-time AGENT_MANAGER_SECRET: generated once when
 * unset, reused from its file afterwards, never overriding an explicit one.
 *
 *   node scripts/test-server-secret.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'secret-'))
const file = join(dir, 'nested', 'secret')
process.env.AGENT_MANAGER_SECRET_FILE = file
const { ensureServerSecret } = await import('../server/utils/serverSecret.ts')

try {
  delete process.env.AGENT_MANAGER_SECRET
  assert.deepEqual(ensureServerSecret(), { source: 'generated', file }, 'unset: generated')
  const first = process.env.AGENT_MANAGER_SECRET
  assert.ok(first.length >= 32, 'long enough to seal a session')
  assert.equal(readFileSync(file, 'utf8').trim(), first, 'saved to the file')
  assert.equal(statSync(file).mode & 0o777, 0o600, 'readable by the owner only')

  delete process.env.AGENT_MANAGER_SECRET
  assert.deepEqual(ensureServerSecret(), { source: 'file', file }, 'next boot: from the file')
  assert.equal(process.env.AGENT_MANAGER_SECRET, first, 'the same secret, so stored tokens still open')

  process.env.AGENT_MANAGER_SECRET = 'explicit-secret-that-is-long-enough-000000'
  assert.deepEqual(ensureServerSecret(), { source: 'env' }, 'an explicit secret wins')
  assert.equal(process.env.AGENT_MANAGER_SECRET, 'explicit-secret-that-is-long-enough-000000')
  assert.equal(readFileSync(file, 'utf8').trim(), first, 'and the file is left alone')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('server secret: ok')
