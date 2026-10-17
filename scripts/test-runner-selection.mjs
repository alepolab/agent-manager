/**
 * Which runner a run gets, and why - without Docker.
 *
 * The properties this pins down:
 *   1. The default is the host, and `host` means host whatever the policy says.
 *   2. `sandbox` means sandbox when the image is there, and falls back to the
 *      host - saying so - when it is not.
 *   3. `policy` sandboxes only a tier the risk policy marks `required`;
 *      `preferred` and `optional` stay on the host, as does a build with no
 *      policy module at all.
 *   4. The mode comes from AGENT_RUNNER_MODE over settings.json over 'host',
 *      and an unknown value is 'host', never a throw.
 *   5. decideRunner never throws and records the host when docker is absent.
 *
 *   node scripts/test-runner-selection.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runner-selection-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
delete process.env.AGENT_RUNNER_MODE
delete process.env.AGENT_SANDBOX_IMAGE
// A docker that is not on PATH at all: the image probe must answer null.
process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-path-'))

const { selectRunner, runnerMode, decideRunner, policySandboxRequirement, RUNNER_MODES } = await import('../server/utils/runner/index.ts')

const save = agentManager => writeFileSync(join(CLAUDE_DIR, 'settings.json'), JSON.stringify({ agentManager }))

// ── 1. host is host ─────────────────────────────────────────────────────────
assert.equal(selectRunner({ mode: 'host', requirement: 'required', imageAvailable: true }).kind, 'host', 'host mode ignores the policy')
assert.equal(selectRunner({ mode: 'host', imageAvailable: true }).kind, 'host')

// ── 2. sandbox mode, with and without the image ──────────────────────────────
assert.equal(selectRunner({ mode: 'sandbox', imageAvailable: true }).kind, 'sandbox')
{
  const c = selectRunner({ mode: 'sandbox', imageAvailable: false })
  assert.equal(c.kind, 'host', 'no image: the host, not a failed run')
  assert.match(c.reason, /falling back to the host/, 'and the record says it fell back')
}

// ── 3. policy mode maps the sandbox column ───────────────────────────────────
assert.equal(selectRunner({ mode: 'policy', requirement: 'required', imageAvailable: true }).kind, 'sandbox')
assert.equal(selectRunner({ mode: 'policy', requirement: 'preferred', imageAvailable: true }).kind, 'host', 'preferred is not required')
assert.equal(selectRunner({ mode: 'policy', requirement: 'optional', imageAvailable: true }).kind, 'host')
{
  const c = selectRunner({ mode: 'policy', requirement: 'required', imageAvailable: false })
  assert.equal(c.kind, 'host')
  assert.match(c.reason, /requires a sandbox.*falling back/, 'a required sandbox without an image falls back, loudly')
}
{
  const c = selectRunner({ mode: 'policy', imageAvailable: true })
  assert.equal(c.kind, 'host', 'no policy on this build: policy mode is host')
  assert.match(c.reason, /no risk policy/)
}

// ── 4. the mode's precedence ─────────────────────────────────────────────────
assert.equal(runnerMode(), 'host', 'nothing saved, nothing set: host')
save({ runnerMode: 'policy' })
assert.equal(runnerMode(), 'policy', 'the saved setting')
process.env.AGENT_RUNNER_MODE = 'sandbox'
assert.equal(runnerMode(), 'sandbox', 'a non-empty env var wins')
process.env.AGENT_RUNNER_MODE = ''
assert.equal(runnerMode(), 'policy', 'an empty env var (a bare line in .env) pins nothing')
process.env.AGENT_RUNNER_MODE = 'container'
assert.equal(runnerMode(), 'host', 'an unknown value is host, never a throw and never a sandbox')
delete process.env.AGENT_RUNNER_MODE
save({ runnerMode: 42 })
assert.equal(runnerMode(), 'host', 'a saved non-string is host')
assert.deepEqual(RUNNER_MODES, ['host', 'sandbox', 'policy'])

// ── 5. the policy column, when the module exists ─────────────────────────────
// This build may or may not carry shared/utils/riskPolicy.ts (it is on another
// branch). Either answer is acceptable; what is not is a throw.
const req = await policySandboxRequirement('money')
assert.ok(req === undefined || ['required', 'preferred', 'optional'].includes(req), `a requirement or undefined, got ${req}`)

// ── 6. decideRunner with no docker: the host, recorded, no throw ────────────
save({ runnerMode: 'sandbox' })
{
  const { choice, sandbox } = await decideRunner({ id: '11111111-2222-4333-8444-555555555555', blastRadius: 'money', ticketKey: 'T-1' })
  assert.equal(choice.kind, 'host', 'sandbox mode without docker falls back to the host')
  assert.equal(sandbox, undefined, 'and records no sandbox')
  assert.match(choice.reason, /falling back/)
}
save({ runnerMode: 'host' })
{
  const { choice, sandbox } = await decideRunner({ id: 'x', blastRadius: 'money' })
  assert.equal(choice.kind, 'host')
  assert.equal(sandbox, undefined)
}

console.log('runner selection: ok')
