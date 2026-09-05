#!/usr/bin/env node
/**
 * Proves install-repo-settings.mjs actually writes a working registration,
 * is idempotent, merges rather than clobbers, and catches the exact
 * gitignore pitfall found while building this (agent-manager's own
 * repo-root .claude/ is gitignored on purpose — a target repo could shadow
 * that same mistake without noticing).
 *
 *   node scripts/test-install-repo-settings.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/install-repo-settings.mjs')

// spawnSync (not execFileSync) so stderr — where the gitignore warning is
// printed via console.warn — is captured on the success path too, not only
// when the process exits nonzero.
function run(args) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function scratchRepo() {
  return mkdtempSync(join(tmpdir(), 'install-repo-settings-test-'))
}

// ── 1. A repo with no .claude/settings.json gets one, with both hooks ────
{
  const repo = scratchRepo()
  const r = run(['--repo', repo])
  assert.equal(r.code, 0, r.out)
  const written = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'))
  const preToolUse = written.hooks.PreToolUse
  assert.ok(preToolUse.some(g => g.matcher === 'Edit|Write' && g.hooks.some(h => h.command.includes('plan-gate.mjs'))))
  const testLockGroup = preToolUse.find(g => g.hooks.some(h => h.command.includes('test-lock.mjs')))
  assert.match(testLockGroup.matcher, /\bBash\b/, 'the installed test-lock registration must keep the Bash matcher')
  assert.ok(written.hooks.PostToolUse.some(g => g.hooks.some(h => h.command.includes('test-lock-arm.mjs'))))
  rmSync(repo, { recursive: true, force: true })
}

// ── 2. Running it twice never duplicates a registration ──────────────────
{
  const repo = scratchRepo()
  run(['--repo', repo])
  const after1 = readFileSync(join(repo, '.claude/settings.json'), 'utf8')
  const r2 = run(['--repo', repo])
  assert.equal(r2.code, 0, r2.out)
  assert.match(r2.out, /Already up to date/, r2.out)
  const after2 = readFileSync(join(repo, '.claude/settings.json'), 'utf8')
  assert.equal(after1, after2, 'a second run must not change the file at all')
  const written = JSON.parse(after2)
  const planGateCount = written.hooks.PreToolUse
    .flatMap(g => g.hooks).filter(h => h.command.includes('plan-gate.mjs')).length
  assert.equal(planGateCount, 1, 'the plan-gate registration must not be duplicated by a second run')
  rmSync(repo, { recursive: true, force: true })
}

// ── 3. An existing, unrelated .claude/settings.json is preserved, not
//    clobbered — the installer must only ADD its two hooks.
{
  const repo = scratchRepo()
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify({
    theme: 'dark',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-existing' }] }] },
  }))
  const r = run(['--repo', repo])
  assert.equal(r.code, 0, r.out)
  const written = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'))
  assert.equal(written.theme, 'dark', 'an unrelated top-level key must survive the merge')
  assert.ok(written.hooks.PreToolUse.some(g => g.hooks.some(h => h.command === 'echo pre-existing')),
    'a pre-existing, unrelated hook registration must survive the merge')
  assert.ok(written.hooks.PreToolUse.some(g => g.hooks.some(h => h.command.includes('plan-gate.mjs'))),
    'the new plan-gate registration must still be added alongside it')
  rmSync(repo, { recursive: true, force: true })
}

// ── 4. --dry-run never writes anything ────────────────────────────────────
{
  const repo = scratchRepo()
  const r = run(['--repo', repo, '--dry-run'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would write/)
  assert.ok(!existsSync(join(repo, '.claude/settings.json')), '--dry-run must not create the file')
  rmSync(repo, { recursive: true, force: true })
}

// ── 5. THE GITIGNORE PITFALL: a target repo whose own .gitignore excludes
//    .claude/ must get a loud warning, not a silent "done" — this is
//    exactly what agent-manager's own repo-root .gitignore does, found
//    while building this task, and it means committing the written file
//    would silently do nothing for every other clone.
{
  const repo = scratchRepo()
  execFileSync('git', ['-C', repo, 'init', '--quiet'])
  writeFileSync(join(repo, '.gitignore'), '.claude\n')
  const r = run(['--repo', repo])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /WARNING.*gitignored/s, `expected a gitignore warning, got:\n${r.out}`)
  rmSync(repo, { recursive: true, force: true })
}

// ── 6. A repo whose .gitignore does NOT exclude .claude/ gets no such warning ─
{
  const repo = scratchRepo()
  execFileSync('git', ['-C', repo, 'init', '--quiet'])
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  const r = run(['--repo', repo])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /WARNING/, r.out)
  rmSync(repo, { recursive: true, force: true })
}

console.log('install-repo-settings: all assertions passed')
