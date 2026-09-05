#!/usr/bin/env node
/**
 * Proves verify-enforcement.mjs actually distinguishes "armed" from
 * "configured but not armed" from "nothing here at all" — by driving the
 * real script against real (scratch) filesystems, the same posture
 * test-hooks-registration.mjs takes toward hooks/hooks.json itself.
 *
 *   node scripts/test-verify-enforcement.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/verify-enforcement.mjs')
const installScript = join(root, 'scripts/install-repo-settings.mjs')

function run(args) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function scratch(prefix = 'verify-enforcement-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function installInto(repo) {
  const r = spawnSync('node', [installScript, '--repo', repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, `fixture setup: install-repo-settings.mjs failed: ${r.stdout}${r.stderr}`)
}

// ── 1. Nothing configured anywhere → NOT ARMED, naming each missing piece ─
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  const r = run(['--repo', repo, '--home', home])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /plan gate: NOT ARMED/, r.out)
  assert.match(r.out, /test lock: NOT ARMED/, r.out)
  assert.match(r.out, /Overall: NOT ARMED/, r.out)
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 2. THE FIX: a repo whose .claude/settings.json was written by
//    install-repo-settings.mjs is proven ARMED, for real — not just
//    "referenced". This is the exact rollout path this task shipped.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  installInto(repo)
  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 0, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.planGate.armed, true)
  assert.equal(parsed.testLock.armed, true)
  assert.equal(parsed.testLockArm.armed, true)
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 3. THE REGRESSION THIS PROJECT KEEPS FINDING: a registration present
//    but with a weakened matcher (Edit|Write only, the Bash bypass reopened)
//    must be reported NOT ARMED for test lock specifically — a plausible,
//    subtle drift, not a fabricated one.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  installInto(repo)
  const settingsPath = join(repo, '.claude/settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  const group = settings.hooks.PreToolUse.find(g => g.hooks.some(h => h.command.includes('test-lock.mjs')))
  group.matcher = 'Edit|Write' // the exact bypass B3 exists to close
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 1, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.testLock.armed, false)
  assert.match(parsed.testLock.reason, /matcher.*Bash/, parsed.testLock.reason)
  assert.equal(parsed.planGate.armed, true, 'the plan gate is unaffected by the test-lock regression')
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 4. A registration pointing at a path that no longer exists must be
//    NOT ARMED with that specific reason — a stale path, not a crash.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  installInto(repo)
  const settingsPath = join(repo, '.claude/settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  for (const group of settings.hooks.PreToolUse) {
    for (const h of group.hooks) {
      if (h.command.includes('plan-gate.mjs')) h.command = 'node "/no/such/path/plan-gate.mjs"'
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 1, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.planGate.armed, false)
  assert.match(parsed.planGate.reason, /does not exist on disk/, parsed.planGate.reason)
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 5. THE SILENT KILL SWITCH: disableAllHooks: true anywhere (even the
//    lowest-precedence file, user settings) must defeat a fully-wired repo,
//    and the report must name where it came from.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  installInto(repo)
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ disableAllHooks: true }))

  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 1, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.planGate.armed, false)
  assert.match(r.out, /disableAllHooks/)
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 6. THE PLUGIN ROUTE: an installed, enabled plugin (no repo settings.json
//    at all) is also proven ARMED — the tool must not assume the settings.json
//    route is the only one.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  mkdirSync(join(home, '.claude/plugins'), { recursive: true })
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'alepo-engineering@alepo-engineering': [{ scope: 'user', installPath: root, version: '0.1.0' }] },
  }))
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({
    enabledPlugins: { 'alepo-engineering@alepo-engineering': true },
  }))

  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 0, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.ok, true)
  assert.match(parsed.planGate.source, /plugin alepo-engineering/)
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

// ── 7. THE EXACT REAL-WORLD FINDING: a plugin present in
//    installed_plugins.json but with NO enabledPlugins entry anywhere
//    (orphaned, per this machine's own ~/.claude state) must be treated as
//    NOT active via the plugin route — never assumed enabled just because
//    it's installed.
{
  const repo = scratch()
  const home = scratch('verify-enforcement-home-')
  mkdirSync(join(home, '.claude/plugins'), { recursive: true })
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'alepo-engineering@alepo-engineering': [{ scope: 'user', installPath: root, version: '0.1.0' }] },
  }))
  // No enabledPlugins entry anywhere — this is the orphaned state.

  const r = run(['--repo', repo, '--home', home, '--json'])
  assert.equal(r.code, 1, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.ok, false, 'installed-but-unconfirmed-enabled must not be treated as armed')
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log('verify-enforcement: all assertions passed')
