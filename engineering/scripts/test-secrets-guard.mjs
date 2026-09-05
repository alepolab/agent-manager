/**
 * Self-check for hooks/secrets-guard.mjs: runs the hook as Claude Code would,
 * JSON on stdin, and asserts the exit code and reason.
 *
 *   node engineering/scripts/test-secrets-guard.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'secrets-guard.mjs')
const run = (call) => {
  const r = spawnSync('node', [hook], { input: JSON.stringify(call), encoding: 'utf8' })
  return { code: r.status, err: r.stderr }
}
const read = (file_path) => run({ tool_name: 'Read', tool_input: { file_path }, cwd: '/w' })
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command }, cwd: '/w' })

// Reads
assert.equal(read('/home/me/project/.env').code, 2, '.env is denied')
assert.equal(read('/home/me/project/apps/web/.env.local').code, 2, '.env.local is denied')
assert.equal(read('/home/me/project/.env.docker').code, 2, '.env.docker is denied')
assert.equal(read('/home/me/.claude/.credentials.json').code, 2, 'credentials are denied')
assert.equal(read('/home/me/project/.env.example').code, 0, 'example files stay readable')
assert.equal(read('/home/me/project/.env.docker.example').code, 0, 'dotted example files stay readable')
assert.equal(read('/home/me/project/src/env.ts').code, 0, 'a source file named env is fine')
assert.equal(read('/home/me/project/environment.md').code, 0, 'environment docs are fine')
assert.match(read('/w/.env').err, /Blocked by the secrets guard/, 'the denial names the guard')

// Bash
assert.equal(bash('cat ~/alepo-workspace/selfcarenow/.env').code, 2, 'cat .env is denied')
assert.equal(bash('cp .env /home/me/.agent-manager/workflow-runs/x/artifacts/env.txt').code, 2, 'copying .env into artifacts is denied')
assert.equal(bash("grep -i 'CRM' .env | head").code, 2, 'grepping .env is denied')
assert.equal(bash('base64 -w0 apps/web/.env.local').code, 2, 'encoding .env is denied')
assert.equal(bash('env').code, 2, 'a bare env dump is denied')
assert.equal(bash('printenv | sort').code, 2, 'printenv is denied')
assert.equal(bash('docker compose -f docker-compose.yml config').code, 2, 'compose config with interpolation is denied')
assert.equal(bash('docker compose -f docker-compose.yml config --no-interpolate').code, 0, 'compose config without interpolation is allowed')
assert.equal(bash('docker compose --project-directory /w -f docker-compose.yml up -d').code, 0, 'compose up is allowed: interpolation happens without the agent seeing values')
assert.equal(bash('cat .env.example').code, 0, 'cat of an example file is allowed')
assert.equal(bash('ls -la').code, 0, 'listing is allowed')
assert.equal(bash('export DATABASE_URL=mongodb://mongodb:27017/db && docker compose up -d').code, 0, 'setting shell env for compose is allowed')
assert.equal(bash('git status').code, 0)

// Fail-open on garbage
const garbage = spawnSync('node', [hook], { input: 'not json', encoding: 'utf8' })
assert.equal(garbage.status, 0, 'malformed input allows: a broken hook must not wedge the estate')

console.log('secrets guard: all assertions passed')
