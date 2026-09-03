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

// 4. Fail-open: malformed stdin through the literal registered command must
//    still exit 0 for every registration. A broken hook must not wedge a
//    session — this is the property that makes it safe to register at all.
for (const r of registrations) {
  const dir = workspace()
  const result = runRegisteredCommand(r.command, dir, 'not json at all')
  assert.equal(result.code, 0, `registered command must fail open on malformed stdin: ${r.command}`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('hook registration (hooks/hooks.json, run as the literal registered command): all assertions passed')
