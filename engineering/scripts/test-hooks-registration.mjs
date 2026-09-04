#!/usr/bin/env node
/**
 * Proves the *registration*, not just the hook scripts.
 *
 * test-hooks.mjs drives plan-gate.mjs and test-lock.mjs directly. That proves
 * the scripts are correct but not that hooks.json actually wires them up: a
 * typo'd path, a stale ${CLAUDE_PLUGIN_ROOT} substitution, or a matcher that
 * doesn't cover Bash would install cleanly and enforce nothing — silently,
 * because a missing PreToolUse hook just means the tool call goes through.
 *
 * This script parses hooks/hooks.json exactly as the Claude Code harness
 * would, substitutes ${CLAUDE_PLUGIN_ROOT} the same way the harness does when
 * it runs a plugin's hook command, and then executes the *literal command
 * string* from the config through a shell — not a hand-built `node <path>`
 * call — so a quoting mistake in the registration would show up here too.
 *
 *   node scripts/test-hooks-registration.mjs
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hooksConfigPath = join(root, 'hooks', 'hooks.json')

// ── Parse the registration exactly as shipped ──────────────────────────────
assert.ok(existsSync(hooksConfigPath), `hooks.json must exist at ${hooksConfigPath}`)
const config = JSON.parse(readFileSync(hooksConfigPath, 'utf8'))
const preToolUse = config.hooks?.PreToolUse
assert.ok(Array.isArray(preToolUse) && preToolUse.length > 0, 'hooks.json must register at least one PreToolUse hook')

// Flatten to { matcher, command } pairs, the same shape the harness reads.
const registrations = preToolUse.flatMap(entry =>
  (entry.hooks ?? []).map(h => ({ matcher: entry.matcher, command: h.command, type: h.type }))
)
assert.ok(registrations.length >= 2, 'expected both the plan-gate and test-lock registrations')
for (const r of registrations) {
  assert.equal(r.type, 'command', `registration for matcher "${r.matcher}" must be type "command"`)
  assert.ok(r.command.includes('${CLAUDE_PLUGIN_ROOT}'), `command must reference \${CLAUDE_PLUGIN_ROOT}: ${r.command}`)
}

/**
 * Resolve ${CLAUDE_PLUGIN_ROOT} exactly like the harness does — a plain
 * string substitution into the command template — then hand the *whole
 * string* to a shell, exactly as `type: command` hooks are invoked. This is
 * deliberately not `execFileSync('node', [path])`: that would silently paper
 * over a broken quoting or path expression in hooks.json.
 */
function runRegisteredCommand(command, cwd, stdinPayload) {
  const resolved = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
  try {
    execSync(resolved, {
      input: stdinPayload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], cwd,
    })
    return { code: 0, message: '' }
  } catch (e) {
    return { code: e.status ?? 1, message: `${e.stderr ?? ''}` }
  }
}

function workspace(setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-registration-test-'))
  mkdirSync(join(dir, '.agent'), { recursive: true })
  setup(dir)
  return dir
}

const PLAN = `# Plan
## Cause
The registration test needs a structurally valid plan to prove the allow path.
## Change
None — this is a read-only proof run against a scratch directory.
## Oracle
plan-gate.mjs exits 0 for an Edit/Write once this file is present and complete.
## Blast radius
test_infra — a throwaway temp directory, nothing shared or deployed.
## Deployment truths
No estate facts apply; this never leaves a temp directory.
`

console.log(`Resolved ${registrations.length} PreToolUse registration(s) from hooks/hooks.json:`)
for (const r of registrations) console.log(`  matcher="${r.matcher}" -> ${r.command}`)

// 1. The path each registration resolves to must exist on disk — a
//    registration pointing at nothing would fail here, not silently.
for (const r of registrations) {
  const m = r.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"]+)"/)
  assert.ok(m, `could not extract a hook path from command: ${r.command}`)
  const resolvedPath = join(root, m[1])
  assert.ok(existsSync(resolvedPath), `registered hook path does not resolve: ${resolvedPath}`)
}

// 2. The plan-gate registration, run as the literal string in hooks.json,
//    denies with no plan and allows with a complete one.
{
  const planGateReg = registrations.find(r => r.matcher === 'Edit|Write')
  assert.ok(planGateReg, 'expected a matcher="Edit|Write" registration for the plan gate')

  const dirNoPlan = workspace()
  const denyCall = JSON.stringify({ cwd: dirNoPlan, tool_name: 'Write', tool_input: { file_path: join(dirNoPlan, 'src/app.ts') } })
  const denied = runRegisteredCommand(planGateReg.command, dirNoPlan, denyCall)
  assert.equal(denied.code, 2, 'registered plan-gate command must deny Write with no plan')
  assert.match(denied.message, /does not exist yet/)
  rmSync(dirNoPlan, { recursive: true, force: true })

  const dirWithPlan = workspace(d => writeFileSync(join(d, '.agent/plan.md'), PLAN))
  const allowCall = JSON.stringify({ cwd: dirWithPlan, tool_name: 'Write', tool_input: { file_path: join(dirWithPlan, 'src/app.ts') } })
  const allowed = runRegisteredCommand(planGateReg.command, dirWithPlan, allowCall)
  assert.equal(allowed.code, 0, `registered plan-gate command must allow Write with a complete plan, got: ${allowed.message}`)
  rmSync(dirWithPlan, { recursive: true, force: true })
}

// 3. The test-lock registration covers Bash in its matcher (the whole point
//    of B3 — an Edit-only lock is theatre) and, run as the literal string in
//    hooks.json, denies a `sed -i` bypass against an armed oracle.
//
//    Hand-arms the marker directly here — legitimate ONLY because this case
//    tests what the registered PreToolUse command does ONCE armed (the DENY
//    side, isolated from how arming happened), not whether the registration
//    arms anything. That question — does the real, registered hook chain
//    arm the lock with no hand-arming — is case 4 below.
{
  const testLockReg = registrations.find(r => r.command.includes('test-lock.mjs'))
  assert.ok(testLockReg, 'expected a test-lock.mjs registration')
  assert.match(testLockReg.matcher, /\bBash\b/, 'test-lock matcher must include Bash or the shell bypass is unguarded')

  const dir = workspace(d => writeFileSync(join(d, '.agent/source-edited'), '1'))
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'tests/sample.test.js'), "test('x', () => { expect(1).toBe(1) })\n")

  const bashCall = JSON.stringify({
    cwd: dir, tool_name: 'Bash',
    tool_input: { command: `sed -i 's/toBe(1)/toBe(2)/' tests/sample.test.js` },
  })
  const denied = runRegisteredCommand(testLockReg.command, dir, bashCall)
  assert.equal(denied.code, 2, 'registered test-lock command must deny a sed -i bypass once armed')
  assert.match(denied.message, /would modify the oracle/)
  rmSync(dir, { recursive: true, force: true })
}

// 4. THE FIX: hooks.json must register a PostToolUse hook that arms the lock
// — the defect this whole file exists to catch was exactly that it didn't.
// Then drive the full real flow through the *literal registered commands*,
// with NO hand-arming anywhere in this block: a source edit through the
// registered PreToolUse test-lock.mjs (must allow, nothing armed yet), the
// same edit through the registered PostToolUse test-lock-arm.mjs (must be
// what creates .agent/source-edited), then a test edit through the
// registered PreToolUse test-lock.mjs again (must now be denied). Before the
// fix, `config.hooks.PostToolUse` did not exist at all and this whole case
// failed on the very first assertion below.
{
  const preToolUseTestLock = registrations.find(r => r.command.includes('test-lock.mjs'))
  assert.ok(preToolUseTestLock, 'expected the PreToolUse test-lock.mjs registration')

  const postToolUse = config.hooks?.PostToolUse
  assert.ok(Array.isArray(postToolUse) && postToolUse.length > 0,
    'hooks.json must register a PostToolUse hook — nothing else arms the test lock in a real session')

  const postToolUseRegs = postToolUse.flatMap(entry =>
    (entry.hooks ?? []).map(h => ({ matcher: entry.matcher, command: h.command, type: h.type })))
  const armReg = postToolUseRegs.find(r => r.command.includes('test-lock-arm.mjs'))
  assert.ok(armReg, 'expected a PostToolUse registration for test-lock-arm.mjs')
  assert.equal(armReg.type, 'command')
  assert.ok(armReg.command.includes('${CLAUDE_PLUGIN_ROOT}'), `command must reference \${CLAUDE_PLUGIN_ROOT}: ${armReg.command}`)
  assert.match(armReg.matcher, /\bEdit\b/, 'the arm registration must match Edit')
  assert.match(armReg.matcher, /\bWrite\b/, 'the arm registration must match Write')

  const dir = workspace(d => writeFileSync(join(d, '.agent/plan.md'), PLAN))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'src/parser.ts'), 'export const parse = () => {}\n')
  writeFileSync(join(dir, 'tests/parser.test.ts'), "test('x', () => {})\n")

  const editCall = JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })

  const preArm = runRegisteredCommand(preToolUseTestLock.command, dir, editCall)
  assert.equal(preArm.code, 0, 'the source edit must be allowed — the lock is not armed yet')
  assert.ok(!existsSync(join(dir, '.agent/source-edited')), 'the marker must not exist before the registered PostToolUse command runs')

  const armed = runRegisteredCommand(armReg.command, dir, editCall)
  assert.equal(armed.code, 0, `the registered arm command must never deny, got: ${armed.message}`)
  assert.ok(existsSync(join(dir, '.agent/source-edited')),
    'the registered PostToolUse command must arm the lock after a real source edit — this is the fix under test, with no hand-arming anywhere in this case')

  const testEditCall = JSON.stringify({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'tests/parser.test.ts') } })
  const deniedTestEdit = runRegisteredCommand(preToolUseTestLock.command, dir, testEditCall)
  assert.equal(deniedTestEdit.code, 2, 'once armed by the real, registered PostToolUse flow, editing the test must be denied')
  rmSync(dir, { recursive: true, force: true })
}

// 5. Fail-open: malformed stdin through the literal registered command must
//    still exit 0 for every registration — PreToolUse and PostToolUse alike.
//    A broken hook must not wedge a session — this is the property that
//    makes it safe to register at all.
{
  const postToolUseRegs = (config.hooks?.PostToolUse ?? []).flatMap(entry =>
    (entry.hooks ?? []).map(h => ({ matcher: entry.matcher, command: h.command, type: h.type })))
  for (const r of [...registrations, ...postToolUseRegs]) {
    const dir = workspace()
    const result = runRegisteredCommand(r.command, dir, 'not json at all')
    assert.equal(result.code, 0, `registered command must fail open on malformed stdin: ${r.command}`)
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('hook registration (hooks/hooks.json, run as the literal registered command): all assertions passed')
