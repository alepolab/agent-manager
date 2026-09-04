#!/usr/bin/env node
/**
 * Proves the hooks actually deny what they claim to deny.
 *
 * A hook is a security control, and an unverified security control is a
 * decoration. Each case drives the real hook with a real tool call and asserts
 * on its exit code: 0 allows, 2 denies.
 *
 *   node scripts/test-hooks.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run a hook against a tool call. Returns { code, message }.
 * A string `call` is sent verbatim, so a test can feed genuinely malformed
 * input — passing it through JSON.stringify would produce valid JSON and
 * quietly test nothing.
 */
function runHook(hook, call) {
  const input = typeof call === 'string' ? call : JSON.stringify(call)
  try {
    execFileSync('node', [join(root, 'hooks', hook)], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, message: '' }
  } catch (e) {
    return { code: e.status ?? 1, message: `${e.stderr ?? ''}` }
  }
}

function workspace(setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'))
  mkdirSync(join(dir, '.agent'), { recursive: true })
  setup(dir)
  return dir
}

const PLAN = `# Plan
## Cause
The parser splits on the first hyphen, so any identifier containing one truncates.
## Change
Split on the last hyphen instead, in parser.ts.
## Oracle
A parameterised test with six identifier shapes, failing on the current code.
## Blast radius
ui_parsing — no money or protocol path is touched.
## Deployment truths
Single-node safe; this path holds no per-process state.
`

// ═══ Plan gate ═══════════════════════════════════════════════════════════

// 1. No plan at all → denied.
{
  const dir = workspace()
  const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })
  assert.equal(r.code, 2, 'editing source with no plan must be denied')
  assert.match(r.message, /does not exist yet/)
  rmSync(dir, { recursive: true, force: true })
}

// 2. Writing the plan itself is always allowed, or the gate forbids satisfying it.
{
  const dir = workspace()
  const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, '.agent/plan.md') } })
  assert.equal(r.code, 0, 'writing the plan must never be blocked by the plan gate')
  rmSync(dir, { recursive: true, force: true })
}

// 2b. Run-artifact writes are always allowed. The evidence bundle's artifacts
// live outside any project (under CLAUDE_DIR/workflow-runs/<id>/artifacts), so
// no .agent/plan.md can ever exempt them - without this the plan gate (B2)
// denies exactly the evidence the bundle standard (R1) requires, and the two
// controls deadlock. Found by the first real pipeline run, which halted at step
// one because ticket-intake could not write intent.md.
{
  const dir = workspace()
  for (const target of [
    '/home/alepo/.claude/workflow-runs/abc-123/artifacts/intent.md',
    '/home/alepo/.claude/workflow-runs/abc-123/artifacts/meta.json',
    '/home/alepo/.claude/workflow-runs/abc-123/artifacts/steps/step-01-intake.json',
  ]) {
    const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Write', tool_input: { file_path: target } })
    assert.equal(r.code, 0, `run artifacts must be writable with no plan present: ${target} -> ${r.message}`)
  }
  // The exemption must stay narrow: a path merely mentioning the word must not slip through.
  const sneaky = runHook('plan-gate.mjs', { cwd: dir, tool_input: { file_path: join(dir, 'src/workflow-runs-notes.ts') }, tool_name: 'Write' })
  assert.equal(sneaky.code, 2, 'a source file whose name merely resembles the artifacts path must still be gated')
}

// 3. A complete plan → allowed.
{
  const dir = workspace(d => writeFileSync(join(d, '.agent/plan.md'), PLAN))
  const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })
  assert.equal(r.code, 0, `a complete plan must allow the edit, got: ${r.message}`)
  rmSync(dir, { recursive: true, force: true })
}

// 4. A plan missing the oracle section → denied. This is the section that
//    distinguishes a plan from a paragraph.
{
  const dir = workspace(d => writeFileSync(join(d, '.agent/plan.md'), PLAN.replace(/## Oracle[\s\S]*?(?=## Blast)/, '')))
  const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })
  assert.equal(r.code, 2, 'a plan with no oracle section must be denied')
  assert.match(r.message, /Oracle/)
  rmSync(dir, { recursive: true, force: true })
}

// 5. Headings present but empty → denied. "Wrote the word plan" is not a plan.
{
  const dir = workspace(d => writeFileSync(join(d, '.agent/plan.md'),
    '# Plan\n## Cause\n## Change\n## Oracle\n## Blast radius\n## Deployment truths\n'))
  const r = runHook('plan-gate.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })
  assert.equal(r.code, 2, 'empty sections must be denied')
  assert.match(r.message, /is empty/)
  rmSync(dir, { recursive: true, force: true })
}

// ═══ Test lock ═══════════════════════════════════════════════════════════

const armed = d => writeFileSync(join(d, '.agent/source-edited'), '1')

// 6. Before source is edited the oracle must be writable — the failing test
//    has to be written first.
{
  const dir = workspace()
  const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, 'tests/parser.test.ts') } })
  assert.equal(r.code, 0, 'writing the failing test before any source edit must be allowed')
  rmSync(dir, { recursive: true, force: true })
}

// 7. Armed: editing a test → denied.
{
  const dir = workspace(armed)
  const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'tests/parser.test.ts') } })
  assert.equal(r.code, 2, 'editing a test after a source edit must be denied')
  rmSync(dir, { recursive: true, force: true })
}

// 8. Armed: source is still editable.
{
  const dir = workspace(armed)
  const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/parser.ts') } })
  assert.equal(r.code, 0, 'source must stay editable while the lock is armed')
  rmSync(dir, { recursive: true, force: true })
}

// 9. THE BASH HOLE. An agent with a shell does not need Edit to rewrite a test.
{
  const dir = workspace(armed)
  for (const command of [
    `sed -i 's/assert/skip/' ${dir}/tests/parser.test.ts`,
    `echo "" > ${dir}/tests/parser.test.ts`,
    `rm ${dir}/tests/parser.test.ts`,
    `cp /tmp/blank.ts ${dir}/tests/parser.test.ts`,
    `git checkout -- ${dir}/tests/parser.test.ts`,
  ]) {
    const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Bash', tool_input: { command } })
    assert.equal(r.code, 2, `Bash must not be an exemption from the test lock: ${command}`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// 10. Ordinary Bash is untouched — the lock must not make the session useless.
{
  const dir = workspace(armed)
  for (const command of ['npm test', 'git status', 'docker compose up -d', 'grep -r assert tests/']) {
    const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Bash', tool_input: { command } })
    assert.equal(r.code, 0, `ordinary command must be allowed: ${command}`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// 11. THE CONFIG HOLE. These change what the tests assert without living
//     under tests/ — the property is "the oracle is unchanged".
{
  const dir = workspace(armed)
  for (const p of ['conftest.py', 'jest.setup.js', 'playwright.config.ts', 'src/__mocks__/api.ts', 'test/fixtures/user.json']) {
    const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Write', tool_input: { file_path: join(dir, p) } })
    assert.equal(r.code, 2, `${p} decides what the oracle asserts and must be locked`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// 12. A human unlock lifts it — that is the only way through.
{
  const dir = workspace(d => {
    armed(d)
    writeFileSync(join(d, '.agent/test-unlock.json'), JSON.stringify({ ticket: 'CSUP-7435', reason: 'test asserted the wrong invariant', by: 'a.singh' }))
  })
  const r = runHook('test-lock.mjs', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, 'tests/parser.test.ts') } })
  assert.equal(r.code, 0, 'a human unlock must lift the lock')
  rmSync(dir, { recursive: true, force: true })
}

// 13. A malformed call must never wedge a session.
{
  for (const hook of ['plan-gate.mjs', 'test-lock.mjs']) {
    const r = runHook(hook, 'not json at all')
    assert.equal(r.code, 0, `${hook} must fail open on malformed input`)
  }
}

console.log('hooks: all assertions passed')
