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
//
// The fixture INJECTS the {version} policy rather than relying on the committed
// registry to happen to contain one. It used to strip `version_source:` from
// whatever the real file had — so the day no product used a {version} branch,
// this stopped testing anything and passed by having nothing to break. The
// subject here is the validator, not the registry's current contents.
{
  const withVersionBranch = baseProducts.replace(
    /^(  ffm:\n(?:.*\n)*?    branches:\n      bug: )\S+$/m,
    "$1'release/{version}'",
  )
  assert.notEqual(withVersionBranch, baseProducts, 'the fixture must actually inject a {version} branch')
  const r = runWith({ products: withVersionBranch })
  assert.equal(r.code, 1, '{version} without a source must fail')
  assert.match(r.out, /no version_source/, r.out)
}

// ── 4. An ATDD command that cannot produce a verdict ──────────────────────
{
  // Injected, not stripped: no product declares an atdd command today, so
  // mutating one that happens to exist tests nothing the day it stops existing.
  const withAtdd = baseProducts.replace(
    /^(  aaa:\n(?:.*\n)*?    tests:\n      unit: .*\n)/m,
    "$1      atdd: 'robot tests/aaa'\n",
  )
  assert.notEqual(withAtdd, baseProducts, 'the fixture must actually inject an atdd command')
  const r = runWith({ products: withAtdd })
  assert.equal(r.code, 1, 'an atdd command without xunit must fail')
  assert.match(r.out, /does not emit xunit/, r.out)
}

// ── 5. multi_repo must be backed by the repo list, both ways ──────────────
{
  // Both directions matter, and only one of them is testable by stripping: a
  // product with several repos must be marked, and a marked product must have
  // several. Inject rather than strip so this keeps testing the validator when
  // the registry's own use of multi_repo changes.
  const marked = baseProducts.replace(
    /^(  ffm:\n(?:.*\n)*?    repos: .*\n)/m,
    "$1    multi_repo: true\n",
  )
  assert.notEqual(marked, baseProducts, 'the fixture must mark a single-repo product')
  const r = runWith({ products: marked })
  assert.equal(r.code, 1, 'multi_repo on a single-repo product must fail')
  assert.match(r.out, /fewer than two repos/, r.out)

  // And the other direction, which the registry can no longer supply either:
  // several repos with no multi_repo produces no merge order.
  const unmarked = baseProducts.replace(
    /^(  ffm:\n(?:.*\n)*?    repos: \[)([^\]]+)(\]\n)/m,
    "$1$2, alepolab/ffm-second$3",
  )
  assert.notEqual(unmarked, baseProducts, 'the fixture must give a product a second repo')
  const r2 = runWith({ products: unmarked })
  assert.equal(r2.code, 1, 'several repos without multi_repo must fail')
  assert.match(r2.out, /not marked multi_repo/, r2.out)
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
