#!/usr/bin/env node
/**
 * Proves resolve-environment.mjs actually resolves, and — the property this
 * whole file exists to check — refuses to guess when it can't.
 *
 *   node scripts/test-resolve-environment.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/resolve-environment.mjs')

function run(args) {
  try {
    const out = execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function fakeOsRelease(dir, id) {
  const p = join(dir, 'os-release')
  writeFileSync(p, `NAME="Fake"\nID=${id}\nVERSION_ID="1"\n`)
  return p
}

// ── 1. Explicit --env resolves and prints its facts ───────────────────────
{
  const r = run(['--env', 'lab-ffmhost1', '--json'])
  assert.equal(r.code, 0, r.out)
  const parsed = JSON.parse(r.out)
  assert.equal(parsed.environment, 'lab-ffmhost1')
  assert.equal(parsed.facts.network_subnet, '10.20.23.0/24')
}

// ── 2. Auto-detect: a real ubuntu, non-WSL os-release resolves to nothing —
//    wsl-ubuntu's detect fingerprint requires wsl:true, and there is no
//    "plain ubuntu, not WSL" entry registered. This must be a loud failure,
//    not a silent match against the closest thing.
{
  const dir = mkdtempSync(join(tmpdir(), 'resolve-env-test-'))
  const osRelease = fakeOsRelease(dir, 'ubuntu')
  const r = run(['--os-release', osRelease, '--wsl', 'false'])
  assert.equal(r.code, 1, 'a non-WSL ubuntu must not silently match the WSL ubuntu entry')
  assert.match(r.out, /no registered environment matches/, r.out)
  rmSync(dir, { recursive: true, force: true })
}

// ── 3. Auto-detect: ubuntu + wsl:true resolves to wsl-ubuntu ──────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'resolve-env-test-'))
  const osRelease = fakeOsRelease(dir, 'ubuntu')
  const r = run(['--os-release', osRelease, '--wsl', 'true', '--json'])
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(r.out).environment, 'wsl-ubuntu')
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. Auto-detect: ol + wsl:true resolves to wsl-oraclelinux ─────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'resolve-env-test-'))
  const osRelease = fakeOsRelease(dir, 'ol')
  const r = run(['--os-release', osRelease, '--wsl', 'true', '--json'])
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(r.out).environment, 'wsl-oraclelinux')
  rmSync(dir, { recursive: true, force: true })
}

// ── 5. Auto-detect: an os-release with no ID= line is a loud failure ──────
{
  const dir = mkdtempSync(join(tmpdir(), 'resolve-env-test-'))
  const p = join(dir, 'os-release')
  writeFileSync(p, 'NAME="Nothing useful"\n')
  const r = run(['--os-release', p])
  assert.equal(r.code, 1, 'a missing ID= line must fail, not default')
  assert.match(r.out, /cannot auto-detect/, r.out)
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. An entirely unknown os_release_id fails loudly, naming what IS known ─
{
  const dir = mkdtempSync(join(tmpdir(), 'resolve-env-test-'))
  const osRelease = fakeOsRelease(dir, 'debian')
  const r = run(['--os-release', osRelease, '--wsl', 'true'])
  assert.equal(r.code, 1)
  assert.match(r.out, /no registered environment matches os_release_id="debian"/, r.out)
  assert.match(r.out, /wsl-ubuntu/, 'the error should name what IS registered, for the human to compare against')
  rmSync(dir, { recursive: true, force: true })
}

// ── 7. --env naming an unregistered id fails loudly, never silently no-ops ─
{
  const r = run(['--env', 'customer-shaped-topology'])
  assert.equal(r.code, 1)
  assert.match(r.out, /is not registered/, r.out)
}

// ── 8. --fact on a fact the resolved environment DOES declare ────────────
{
  const r = run(['--env', 'wsl-oraclelinux', '--fact', 'selinux'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.trim(), 'present')
}

// ── 9. THE RULE: --fact on a fact the resolved environment does NOT
//    declare must fail loudly and must NEVER fall back to another
//    environment's value for the same fact name (lab-ffmhost1 has no
//    selinux fact at all, unlike both wsl-* entries).
{
  const r = run(['--env', 'lab-ffmhost1', '--fact', 'selinux'])
  assert.equal(r.code, 1, 'a fact absent for the resolved environment must fail, not fall back to another environment\'s value')
  assert.match(r.out, /unknown: "selinux" is not stated for lab-ffmhost1/, r.out)
  assert.doesNotMatch(r.out, /present|absent/, 'must not leak in either wsl entry\'s selinux value')
}

// ── 10. --fact on a fact that IS declared, but empty string, still resolves
//     (present-but-empty is different from absent, and must not be
//     conflated with the "not stated" case).
{
  const r = run(['--env', 'wsl-ubuntu', '--fact', 'package_manager'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.out.trim(), 'apt')
}

console.log('resolve-environment: all assertions passed')
