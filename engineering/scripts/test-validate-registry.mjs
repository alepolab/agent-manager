#!/usr/bin/env node
/**
 * Proves the registry check actually rejects broken entries.
 *
 * A validator that only ever passes is indistinguishable from no validator, so
 * each case here breaks the registry in one specific way and asserts the check
 * fails with a message naming that problem.
 *
 *   node scripts/test-validate-registry.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Run the checker over a copy of the registry with one file replaced. */
function runWith({ watches, products }) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-test-'))
  try {
    cpSync(join(root, 'registry'), join(dir, 'registry'), { recursive: true })
    cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true })
    if (watches) writeFileSync(join(dir, 'registry/watches.yaml'), watches)
    if (products) writeFileSync(join(dir, 'registry/products.yaml'), products)
    try {
      const out = execFileSync('node', [join(dir, 'scripts/validate-registry.mjs')],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const baseWatches = readFileSync(join(root, 'registry/watches.yaml'), 'utf8')
const baseProducts = readFileSync(join(root, 'registry/products.yaml'), 'utf8')

// ── 0. The committed registry passes ──────────────────────────────────────
{
  const r = runWith({})
  assert.equal(r.code, 0, `the committed registry should pass, got:\n${r.out}`)
}

// ── 1. An unknown key is a typo, and typos must not pass silently ─────────
{
  const r = runWith({ watches: baseWatches.replace('reporter_group: gtac', 'reporter_groups: gtac') })
  assert.equal(r.code, 1, 'a misspelled key must fail')
  assert.match(r.out, /not a recognised key/, r.out)
}

// ── 2. A placeholder repo name must never reach a dispatch ────────────────
{
  const r = runWith({ products: baseProducts.replace('alepolab/aaa_rhel8', 'alepolab/<aaa-repo>') })
  assert.equal(r.code, 1, 'a placeholder repo must fail')
  assert.match(r.out, /still a placeholder/, r.out)
}

// ── 3. {version} with no version_source cannot resolve a branch ───────────
{
  const r = runWith({ products: baseProducts.replace(/^\s*version_source:.*$/m, '') })
  assert.equal(r.code, 1, '{version} without a source must fail')
  assert.match(r.out, /no version_source/, r.out)
}

// ── 4. An ATDD command that cannot produce a verdict ──────────────────────
{
  const r = runWith({ products: baseProducts.replace("robot --xunit out.xml tests/aaa", "robot tests/aaa") })
  assert.equal(r.code, 1, 'an atdd command without xunit must fail')
  assert.match(r.out, /does not emit xunit/, r.out)
}

// ── 5. multi_repo must be backed by the repo list, both ways ──────────────
{
  const r = runWith({ products: baseProducts.replace('    multi_repo: true\n', '') })
  assert.equal(r.code, 1, 'several repos without multi_repo must fail')
  assert.match(r.out, /not marked multi_repo/, r.out)
}

// ── 6. A duplicate watch id would corrupt bundle and metrics history ──────
{
  const r = runWith({ watches: baseWatches.replace('- id: devops-tasks', '- id: csup-bugs') })
  assert.equal(r.code, 1, 'a duplicate watch id must fail')
  assert.match(r.out, /duplicate watch id/, r.out)
}

// ── 7. An out-of-enum work type is caught, not passed through ─────────────
{
  const r = runWith({ watches: baseWatches.replace('work_types: [bug]', 'work_types: [buq]') })
  assert.equal(r.code, 1, 'an unknown work type must fail')
  assert.match(r.out, /is not one of/, r.out)
}

// ── 8. requires: [spec] on a queue with no spec-bearing work type ─────────
{
  const r = runWith({ watches: baseWatches.replace('    work_types: [feature, change_request]', '    work_types: [infra]') })
  assert.equal(r.code, 1, 'requires: [spec] with no spec-bearing work type must fail')
  assert.match(r.out, /requires a spec/, r.out)
}

console.log('validate-registry: all assertions passed')
