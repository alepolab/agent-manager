#!/usr/bin/env node
/**
 * Proves the assembler builds a bundle strictly from what's actually on
 * disk in a run directory — nothing more.
 *
 * The point case is the one in the brief: a run directory missing the
 * pre-fix oracle (oracle-before.xml) must produce a bundle Task 1's
 * validator REJECTS, because nothing else in the run directory can stand
 * in for "the bug was reproduced." An assembler that fills that gap with a
 * plausible verdict would be worse than no bundle at all.
 *
 *   node scripts/test-assemble-bundle.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleBundle } from './assemble-bundle.mjs'
import { validateBundle } from './validate-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── A complete, valid run directory, matching the contract documented in
// the header of assemble-bundle.mjs ─────────────────────────────────────────
const META = {
  ticket: 'SA-1204',
  watch: 'sa-bugs',
  work_type: 'bug',
  class: 'parsing',
  product: 'ocs_cpp14',
  blast_radius: 'ui_parsing',
  identity: 'agent-sdlc-02',
  model: 'claude-sonnet-4-5',
  plugin_version: '0.1.0',
  stack: { profile: 'ffmhost1', topology: 'single-node', liquibase_tag: null },
  oracle: { kind: 'parameterised_test', path: 'tests/oracle_test.py', runs: 3, rows: 4 },
  oracle_after: { kind: 'parameterised_test', path: 'tests/oracle_test.py', runs: 3, rows: 4 },
  regression: { suite: 'full' },
  fix: {
    repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://github.com/alepolab/ocs_cpp14/pull/42' }],
    files_changed: 3,
    lines_changed: 42,
    test_dirs_unlocked: false,
    unlock_reason: null,
  },
  adversarial: null,
  cost: { input_tokens: 12000, output_tokens: 3000, attempts: 1, wall_clock_min: 14.5 },
}

const XUNIT_ALL_FAIL = '<testsuite name="oracle" tests="4" failures="4" errors="0" skipped="0"></testsuite>'
const XUNIT_ALL_PASS = '<testsuite name="oracle" tests="4" failures="0" errors="0" skipped="0"></testsuite>'
const XUNIT_REGRESSION = '<testsuites><testsuite name="full" tests="120" failures="0" errors="0" skipped="0"></testsuite></testsuites>'

/**
 * Write a complete run directory into a fresh temp dir, then let `mutate`
 * remove or alter files before the test reads it. Returns the dir path.
 */
function runDir(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'assemble-bundle-test-'))
  const files = {
    'meta.json': JSON.stringify(META, null, 2),
    'context-packet.json': JSON.stringify({ ticket: 'SA-1204', files: ['tests/oracle_test.py'] }),
    'intent.md': '# Intent\n\nParser truncates identifiers containing a hyphen.\n',
    'plan.md': '# Plan\n\nSplit on the last hyphen, not the first.\n',
    'summary.md': '# SA-1204: parsing fix\n\nWhat broke, what changed, what proves it.\n',
    'oracle-before.xml': XUNIT_ALL_FAIL,
    'oracle-after.xml': XUNIT_ALL_PASS,
    'regression.xml': XUNIT_REGRESSION,
  }
  const written = new Set()
  const write = (name, content) => { writeFileSync(join(dir, name), content); written.add(name) }
  const skip = new Set()
  mutate({ skip: (name) => skip.add(name), files })
  for (const [name, content] of Object.entries(files)) {
    if (!skip.has(name)) write(name, content)
  }
  return dir
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ── 0. A complete run directory assembles into a bundle the validator accepts
await check('a complete run directory produces a valid bundle', async () => {
    const dir = runDir()
    try {
      const { bundle, problems } = await assembleBundle(dir)
      assert.deepEqual(problems, [], `expected no problems, got:\n${problems.join('\n')}`)
      // Cross-check against Task 1's validator directly too — assembleBundle's
      // own `problems` must not diverge from what validateBundle() says.
      assert.deepEqual(validateBundle(bundle), [])
      assert.equal(bundle.ticket, 'SA-1204')
      assert.equal(bundle.oracle.verdict, 'FAIL', 'pre-fix oracle must read FAIL from the xunit file')
      assert.equal(bundle.oracle_after.verdict, 'PASS', 'post-fix oracle must read PASS from the xunit file')
      assert.equal(bundle.regression.passed, 120)
      assert.equal(bundle.regression.failed, 0)
      assert.match(bundle.context_packet_hash, /^sha256:[a-f0-9]{64}$/)
      assert.ok(bundle.intent_sha.length >= 7)
      assert.ok(bundle.plan_sha.length >= 7)
      assert.equal(bundle.spec_sha, null, 'no spec.md in the fixture, so spec_sha must be null, not fabricated')
      assert.equal(bundle.trace, null, 'no trace.zip in the fixture, so trace must be null, not fabricated')
      assert.equal(bundle.summary_md, '# SA-1204: parsing fix\n\nWhat broke, what changed, what proves it.\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 1. THE point case: missing pre-fix oracle ────────────────────────────
// If oracle-before.xml is absent, the assembler must not invent a verdict
// (FAIL or otherwise) — the bundle it produces must fail Task 1's validator,
// naming the pre-fix oracle as the reason.
await check('a run directory missing the pre-fix oracle produces a bundle the validator rejects', async () => {
    const dir = runDir(({ skip }) => skip('oracle-before.xml'))
    try {
      const { bundle, problems } = await assembleBundle(dir)
      assert.ok(problems.length, 'expected the assembler to report problems')
      assert.ok(
        problems.some(p => /bundle\.oracle\b/.test(p) && /verdict/.test(p)),
        `expected a problem naming bundle.oracle.verdict, got:\n${problems.join('\n')}`
      )
      // The oracle object must still carry what WAS declared (kind/path/runs),
      // proving the omission is specific to the missing verdict, not a
      // wholesale "give up" that would hide which artifact was missing.
      assert.equal(bundle.oracle.kind, 'parameterised_test')
      assert.equal('verdict' in bundle.oracle, false, 'verdict must be absent, not defaulted to FAIL or PASS')
      assert.equal('xunit' in bundle.oracle, false)
      // And it must actually be REJECTED end to end by Task 1's own validator.
      assert.ok(validateBundle(bundle).length > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 2. Missing post-fix oracle is caught the same way ────────────────────
await check('a run directory missing the post-fix oracle produces a bundle the validator rejects', async () => {
    const dir = runDir(({ skip }) => skip('oracle-after.xml'))
    try {
      const { bundle, problems } = await assembleBundle(dir)
      assert.ok(problems.some(p => /bundle\.oracle_after\b/.test(p) && /verdict/.test(p)),
        `expected a problem naming bundle.oracle_after.verdict, got:\n${problems.join('\n')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 3. Missing context packet is caught, not hashed as empty string ──────
await check('a run directory missing the context packet produces a bundle the validator rejects', async () => {
    const dir = runDir(({ skip }) => skip('context-packet.json'))
    try {
      const { bundle, problems } = await assembleBundle(dir)
      assert.equal('context_packet_hash' in bundle, false, 'must be absent, not a hash of nothing')
      assert.ok(problems.some(p => /context_packet_hash/.test(p)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 4. Missing meta.json entirely does not crash, and rejects cleanly ────
await check('a run directory with no meta.json at all does not crash and is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assemble-bundle-test-'))
    try {
      const { bundle, problems } = await assembleBundle(dir)
      assert.ok(problems.length > 0)
      assert.equal('ticket' in bundle, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 5. A present trace.zip is recorded; a present spec.md is hashed ──────
await check('trace.zip and spec.md are picked up when present, not just defaulted to null', async () => {
    const dir = runDir()
    try {
      writeFileSync(join(dir, 'trace.zip'), Buffer.from([0, 1, 2, 3]))
      writeFileSync(join(dir, 'spec.md'), '# Spec\n\nThe watch requires one.\n')
      const { bundle } = await assembleBundle(dir)
      assert.equal(bundle.trace, 'trace.zip')
      assert.ok(typeof bundle.spec_sha === 'string' && bundle.spec_sha.length >= 7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 6. A regression run with real failures is read as failed, not passed ──
await check('regression failures parsed from xunit are not silently treated as passes', async () => {
    const dir = runDir(({ files }) => {
      files['regression.xml'] = '<testsuite name="full" tests="120" failures="2" errors="1" skipped="0"></testsuite>'
    })
    try {
      const { bundle } = await assembleBundle(dir)
      assert.equal(bundle.regression.failed, 3)
      assert.equal(bundle.regression.passed, 117)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

// ── 7. The CLI: writes --out either way, exits 0 valid / 1 invalid ───────
await check('the CLI writes the bundle and exits 0 for a complete run dir, 1 for an incomplete one', async () => {
    const goodDir = runDir()
    const badDir = runDir(({ skip }) => skip('oracle-before.xml'))
    const outDir = mkdtempSync(join(tmpdir(), 'assemble-bundle-cli-'))
    try {
      const goodOut = join(outDir, 'good.json')
      const ok = execFileSync('node', [join(root, 'scripts/assemble-bundle.mjs'), '--run-dir', goodDir, '--out', goodOut], { encoding: 'utf8' })
      assert.match(ok, /valid/i)
      assert.ok(existsSync(goodOut))
      const goodBundle = JSON.parse(readFileSync(goodOut, 'utf8'))
      assert.equal(goodBundle.ticket, 'SA-1204')

      const badOut = join(outDir, 'bad.json')
      let err
      try {
        execFileSync('node', [join(root, 'scripts/assemble-bundle.mjs'), '--run-dir', badDir, '--out', badOut],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        assert.fail('the CLI should have exited non-zero for a run dir missing the pre-fix oracle')
      } catch (e) {
        err = e
      }
      assert.equal(err.status, 1)
      assert.ok(existsSync(badOut), 'the bundle must still be written for inspection, even when invalid')
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /oracle/)
    } finally {
      rmSync(goodDir, { recursive: true, force: true })
      rmSync(badDir, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
    }
  })

console.log(`\n✓ all ${passed} assemble-bundle tests passed\n`)
