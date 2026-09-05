#!/usr/bin/env node
/**
 * Proves the environments check actually rejects broken entries.
 *
 * Same posture as test-validate-registry.mjs: a validator that only ever
 * passes is indistinguishable from no validator, so each case here breaks
 * environments.yaml one specific way and asserts the check fails naming that
 * problem.
 *
 *   node scripts/test-validate-environments.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runWith(environmentsYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'env-registry-test-'))
  try {
    cpSync(join(root, 'registry'), join(dir, 'registry'), { recursive: true })
    cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
    if (environmentsYaml) writeFileSync(join(dir, 'registry/environments.yaml'), environmentsYaml)
    try {
      const out = execFileSync('node', [join(dir, 'scripts/validate-environments.mjs')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const base = readFileSync(join(root, 'registry/environments.yaml'), 'utf8')

// ── 0. The committed registry passes ──────────────────────────────────────
{
  const r = runWith(null)
  assert.equal(r.code, 0, `the committed environments registry should pass, got:\n${r.out}`)
}

// ── 1. An unknown top-level key is a typo ─────────────────────────────────
{
  const r = runWith(base.replace('environments:', 'environmentz:\n  x:\n    kind: workstation\n    facts:\n      a: b\nenvironments:'))
  assert.equal(r.code, 1, 'an unrecognised top-level key must fail')
  assert.match(r.out, /not a recognised key/, r.out)
}

// ── 2. A lab host declaring `detect` must fail — it can't be auto-detected ─
{
  const r = runWith(base.replace(
    '    # No `detect` block: this is a remote lab host, not something a local',
    '    detect:\n      os_release_id: ubuntu\n      wsl: true\n    # No `detect` block: this is a remote lab host, not something a local'
  ))
  assert.equal(r.code, 1, 'a lab_docker_host declaring detect must fail')
  assert.match(r.out, /must not declare "detect"/, r.out)
}

// ── 3. Two environments with an identical detect fingerprint are ambiguous ─
{
  const r = runWith(base.replace(
    "      os_release_id: ol\n      wsl: true",
    "      os_release_id: ubuntu\n      wsl: true"
  ))
  assert.equal(r.code, 1, 'a duplicate detect fingerprint must fail')
  assert.match(r.out, /identical to environments\.wsl-ubuntu/, r.out)
}

// ── 4. `detect` missing `wsl` must fail (schema: both keys required together) ─
{
  const r = runWith(base.replace('      os_release_id: ubuntu\n      wsl: true', '      os_release_id: ubuntu'))
  assert.equal(r.code, 1, 'detect without wsl must fail schema validation')
  assert.match(r.out, /missing required key "wsl"/, r.out)
}

// ── 5. An empty facts map is a schema violation (minProperties: 1) ────────
{
  const r = runWith(base.replace(/facts:\n(\s+package_manager: apt\n[\s\S]*?is_production_shaped: false\n)/, 'facts:\n'))
  assert.equal(r.code, 1, 'an empty facts map must fail')
  assert.match(r.out, /needs at least 1 entr/, r.out)
}

// ── 6. An unknown `kind` value must fail ──────────────────────────────────
{
  const r = runWith(base.replace('kind: workstation', 'kind: laptop'))
  assert.equal(r.code, 1, 'an unrecognised kind must fail')
  assert.match(r.out, /is not one of/, r.out)
}

console.log('validate-environments: all assertions passed')
