#!/usr/bin/env node
/**
 * Evidence bundle v0.2: the schema is a superset of v0.1, and manifest_sha256
 * detects a bundle changed after assembly.
 *
 * The rule worth protecting is the last one: a modified bundle must FAIL
 * verification. A digest that still matched after an edit would be a field
 * that looks like integrity and is not.
 *
 *   node scripts/test-evidence-hash.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, manifestSha256, stampManifest, verifyManifest, MANIFEST_FIELD } from './evidence-hash.mjs'
import { validateBundle, loadSchema } from './validate-bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

// The same complete bundle test-validate-bundle.mjs uses (ui_parsing: no adversarial needed).
const v01 = () => ({
  ticket: 'SA-1203', watch: 'sa-bugs', work_type: 'bug', class: 'parsing', product: 'ocs_cpp14', blast_radius: 'ui_parsing',
  identity: 'agent-sdlc-01', context_packet_hash: `sha256:${'a'.repeat(64)}`, intent_sha: 'abc1234', spec_sha: null, plan_sha: 'def5678',
  model: 'claude-sonnet-4-5', plugin_version: '0.1.0', stack: { profile: 'ffmhost1', topology: 'single-node', liquibase_tag: null },
  oracle: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3, verdict: 'FAIL', xunit: null },
  fix: { repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://github.com/alepolab/ocs_cpp14/pull/42' }], files_changed: 3, lines_changed: 42, test_dirs_unlocked: false, unlock_reason: null },
  oracle_after: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3, verdict: 'PASS', xunit: null },
  regression: { suite: 'pytest', passed: 120, failed: 0, xunit: null },
  trace: null, adversarial: null,
  cost: { input_tokens: 10000, output_tokens: 2000, attempts: 1, wall_clock_min: 12.5 },
  summary_md: '# Fix\n\nParsing fix.',
})
const v02schema = loadSchema('0.2')
const v01schema = loadSchema('0.1')

check('canonical JSON sorts keys at every depth and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 0, y: 1 }] } }), '{"a":{"c":[2,{"y":1,"z":0}]},"b":1}')
})

check('a v0.1 bundle validates unchanged against v0.2', () => {
  assert.deepEqual(validateBundle(v01(), { schema: v02schema }), [])
})

check('v0.2 keeps every v0.1 requirement', () => {
  assert.deepEqual([...v02schema.required].sort(), [...v01schema.required].sort())
  const b = v01(); delete b.context_packet_hash
  assert.ok(validateBundle(b, { schema: v02schema }).some(p => /context_packet_hash/.test(p)))
  const m = { ...v01(), blast_radius: 'money' }
  assert.ok(validateBundle(m, { schema: v02schema }).some(p => /adversarial/.test(p)), 'money still needs an adversarial report')
})

const v02 = () => ({
  ...v01(),
  risk_policy_version: 1, reviewers_required: 1, adversarial_required: false,
  verdict_panel: { members: [{ agent: 'sdlc-verifier', criterion: 'oracle', result: 'PASS', evidence_path: 'verifier-report.md' }], loops: 0 },
  approvals: [{ gate: 'Push + PR', approver: 'arisht', at: '2026-10-17T09:00:00.000Z', minutes: 14.2 }],
  plugin_lock: { 'alepo-engineering': '0.1.0' },
})

check('the v0.2 fields validate against v0.2 and are refused by v0.1', () => {
  assert.deepEqual(validateBundle(stampManifest(v02()), { schema: v02schema }), [])
  const under01 = validateBundle(stampManifest(v02()), { schema: v01schema })
  assert.ok(under01.some(p => /risk_policy_version.*not a recognised key/.test(p)), 'v0.1 is additionalProperties: false and must stay so')
  assert.ok(under01.some(p => /manifest_sha256/.test(p)))
})

check('a malformed v0.2 field is rejected', () => {
  const b = v02(); b.verdict_panel.members[0].result = 'MAYBE'
  assert.ok(validateBundle(b, { schema: v02schema }).some(p => /verdict_panel\.members\[0\]\.result/.test(p)))
  const c = v02(); delete c.approvals[0].approver
  assert.ok(validateBundle(c, { schema: v02schema }).some(p => /approvals\[0\].*approver/.test(p)))
  const d = v02(); d.manifest_sha256 = 'nope'
  assert.ok(validateBundle(d, { schema: v02schema }).some(p => /manifest_sha256/.test(p)))
})

check('the digest is over everything but itself, independent of key order', () => {
  const stamped = stampManifest(v02())
  assert.match(stamped[MANIFEST_FIELD], /^[a-f0-9]{64}$/)
  assert.equal(manifestSha256(stamped), stamped[MANIFEST_FIELD], 'stamping does not change the digest')
  const reordered = Object.fromEntries(Object.entries(stamped).reverse())
  assert.equal(manifestSha256(reordered), stamped[MANIFEST_FIELD])
  assert.deepEqual(verifyManifest(stamped), { ok: true, expected: stamped[MANIFEST_FIELD], actual: stamped[MANIFEST_FIELD] })
})

check('a modified bundle fails verification', () => {
  const stamped = stampManifest(v02())
  const edited = { ...stamped, summary_md: `${stamped.summary_md} ` } // one trailing space
  const v = verifyManifest(edited)
  assert.equal(v.ok, false)
  assert.notEqual(v.expected, v.actual)
  const deeper = structuredClone(stamped); deeper.oracle.verdict = 'PASS'
  assert.equal(verifyManifest(deeper).ok, false, 'a change three levels down is caught too')
  assert.equal(verifyManifest(v02()).ok, false, 'an unstamped bundle does not verify')
})

check('the CLI stamps and verifies, and exits 1 on a tampered file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-hash-'))
  const file = join(dir, 'bundle.json')
  writeFileSync(file, JSON.stringify(v02()))
  execFileSync('node', [join(here, 'evidence-hash.mjs'), '--stamp', file])
  execFileSync('node', [join(here, 'evidence-hash.mjs'), '--verify', file])
  const printed = execFileSync('node', [join(here, 'evidence-hash.mjs'), file], { encoding: 'utf8' }).trim()
  assert.equal(printed, manifestSha256(v02()))
  const tampered = JSON.parse(execFileSync('cat', [file], { encoding: 'utf8' }))
  tampered.cost.attempts = 3
  writeFileSync(file, JSON.stringify(tampered))
  const r = spawnSync('node', [join(here, 'evidence-hash.mjs'), '--verify', file], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /content hashes to/)
})

check('the assembler stamps the digest only under EVIDENCE_BUNDLE_VERSION=0.2', () => {
  const run = mkdtempSync(join(tmpdir(), 'evidence-run-'))
  const b = v01()
  const meta = {
    ticket: b.ticket, watch: b.watch, work_type: b.work_type, class: b.class, product: b.product, blast_radius: b.blast_radius,
    identity: b.identity, model: b.model, plugin_version: b.plugin_version, stack: b.stack,
    oracle: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3 },
    oracle_after: { kind: 'parameterised_test', path: 'tests/oracle_test.py', rows: 4, runs: 3 },
    regression: { suite: 'pytest' }, fix: b.fix, cost: b.cost,
    risk_policy_version: 1, reviewers_required: 1, adversarial_required: false,
  }
  writeFileSync(join(run, 'meta.json'), JSON.stringify(meta))
  writeFileSync(join(run, 'context-packet.json'), '{}')
  writeFileSync(join(run, 'intent.md'), 'intent')
  writeFileSync(join(run, 'plan.md'), 'plan')
  writeFileSync(join(run, 'summary.md'), 'summary')
  writeFileSync(join(run, 'oracle-before.xml'), '<testsuite tests="3" failures="3" errors="0" skipped="0"></testsuite>')
  writeFileSync(join(run, 'oracle-after.xml'), '<testsuite tests="3" failures="0" errors="0" skipped="0"></testsuite>')
  writeFileSync(join(run, 'regression.xml'), '<testsuite tests="120" failures="0" errors="0" skipped="0"></testsuite>')
  const assembler = join(here, 'assemble-bundle.mjs')

  const out01 = join(run, 'b01.json')
  execFileSync('node', [assembler, '--run-dir', run, '--out', out01], { env: { ...process.env, EVIDENCE_BUNDLE_VERSION: '' } })
  const b01 = JSON.parse(execFileSync('cat', [out01], { encoding: 'utf8' }))
  assert.equal(MANIFEST_FIELD in b01, false, 'v0.1 output carries no digest')
  assert.equal('risk_policy_version' in b01, false, 'and no v0.2 field, even when meta.json has one')

  const out02 = join(run, 'b02.json')
  execFileSync('node', [assembler, '--run-dir', run, '--out', out02], { env: { ...process.env, EVIDENCE_BUNDLE_VERSION: '0.2' } })
  const b02 = JSON.parse(execFileSync('cat', [out02], { encoding: 'utf8' }))
  assert.equal(b02.risk_policy_version, 1)
  assert.equal(verifyManifest(b02).ok, true, 'v0.2 output is stamped and verifies')
  execFileSync('node', [join(here, 'evidence-hash.mjs'), '--verify', out02])
})

if (failures) {
  console.error(`\n✗ ${failures} evidence-hash test(s) failed\n`)
  process.exit(1)
}
console.log('\n✓ all evidence-hash tests passed: v0.2 is a superset of v0.1, and a modified bundle fails verification\n')
