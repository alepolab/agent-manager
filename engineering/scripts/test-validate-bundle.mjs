#!/usr/bin/env node
/**
 * Proves the bundle validator actually rejects bundles that are missing
 * evidence.
 *
 * Each case here starts from one complete, valid bundle and breaks it in
 * exactly the way a rule exists to catch, then asserts validateBundle()
 * rejects it with a message naming the problem. A validator that only ever
 * accepts is indistinguishable from no gate at all — evidence-bundle is the
 * mechanism that is supposed to make "missing evidence fails the PR"
 * literally true, so every case below is the reasoning for one rule, not
 * just a rejection.
 *
 *   node scripts/test-validate-bundle.mjs
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBundle } from './validate-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── One complete, valid bundle ──────────────────────────────────────────────
// blast_radius is a label that does NOT require adversarial verification
// (ui_parsing), so this fixture stays minimal; the money/adversarial path is
// exercised on its own below.
function validBundle() {
  return {
    ticket: 'SA-1203',
    watch: 'sa-bugs',
    work_type: 'bug',
    class: 'parsing',
    product: 'ocs_cpp14',
    blast_radius: 'ui_parsing',
    identity: 'agent-sdlc-01',
    context_packet_hash: `sha256:${'a'.repeat(64)}`,
    intent_sha: 'abc1234',
    spec_sha: null,
    plan_sha: 'def5678',
    model: 'claude-sonnet-4-5',
    plugin_version: '0.1.0',
    stack: { profile: 'ffmhost1', topology: 'single-node', liquibase_tag: null },
    oracle: {
      kind: 'parameterised_test', path: 'tests/oracle_test.py',
      rows: 4, runs: 3, verdict: 'FAIL', xunit: null,
    },
    fix: {
      repos: [
        { repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://github.com/alepolab/ocs_cpp14/pull/42' },
      ],
      files_changed: 3,
      lines_changed: 42,
      test_dirs_unlocked: false,
      unlock_reason: null,
    },
    oracle_after: {
      kind: 'parameterised_test', path: 'tests/oracle_test.py',
      rows: 4, runs: 3, verdict: 'PASS', xunit: null,
    },
    regression: { suite: 'full', passed: 120, failed: 0, xunit: null },
    trace: null,
    adversarial: null,
    cost: { input_tokens: 12000, output_tokens: 3000, attempts: 1, wall_clock_min: 14.5 },
    summary_md: '# SA-1203: parsing fix\n\nWhat broke, what changed, what proves it.',
  }
}

// Deep-clone-and-mutate so every case starts from the known-good bundle.
function broken(mutate) {
  const b = structuredClone(validBundle())
  mutate(b)
  return b
}

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ── 0. The complete fixture is accepted ─────────────────────────────────────
check('a complete bundle validates', () => {
  const problems = validateBundle(validBundle())
  assert.deepEqual(problems, [], `expected no problems, got:\n${problems.join('\n')}`)
})

// ── 1. A bug with no class ───────────────────────────────────────────────────
// The schema's conditional requires a class for bugs — without one, the
// "only automatable classes reach the build loop" gate has nothing to check.
check('work_type: bug with class: null is rejected', () => {
  const problems = validateBundle(broken(b => { b.class = null }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /class/.test(p)), `expected a message naming "class", got:\n${problems.join('\n')}`)
})

// ── 2. A money change with no adversarial verification ─────────────────────
// Money paths are exactly the ones a plausible-looking but wrong fix costs
// real currency, so they get a mandatory adversarial pass.
// A deployment-config defect has a blast radius, and before this value existed
// it had nowhere honest to go: the enum was built around code changes, so the
// first real ticket through the pipeline (DEVOPS-23, missing compose bind
// mounts) had to be mislabelled `schema` to validate at all. A label nobody
// can apply truthfully is worse than a missing one, because it still gets
// filled in.
check('blast_radius: deployment validates, and does not demand adversarial', () => {
  const problems = validateBundle(broken((b) => { b.blast_radius = 'deployment'; b.adversarial = null }))
  assert.deepEqual(problems, [], `a deployment-labelled bundle must validate: ${JSON.stringify(problems)}`)
})

check('blast_radius: money with adversarial: null is rejected', () => {
  const problems = validateBundle(broken(b => { b.blast_radius = 'money'; b.adversarial = null }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /adversarial/.test(p)), `expected a message naming "adversarial", got:\n${problems.join('\n')}`)
})

// ── 3. Pre-fix oracle that PASSED ────────────────────────────────────────────
// If the oracle passed before the fix, the bug was never reproduced — the
// schema cannot express this (verdict is a plain enum), so it is semantic.
check('oracle.verdict: PASS on the pre-fix oracle is rejected', () => {
  const problems = validateBundle(broken(b => { b.oracle.verdict = 'PASS' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /oracle\.verdict/.test(p) && /FAIL/.test(p)),
    `expected a message naming the pre-fix FAIL requirement, got:\n${problems.join('\n')}`)
})

// ── 4. Post-fix oracle that FAILED ──────────────────────────────────────────
// A fix whose own oracle still fails afterward is not a fix; also semantic.
check('oracle_after.verdict: FAIL is rejected', () => {
  const problems = validateBundle(broken(b => { b.oracle_after.verdict = 'FAIL' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /oracle_after\.verdict/.test(p) && /PASS/.test(p)),
    `expected a message naming the post-fix PASS requirement, got:\n${problems.join('\n')}`)
})

// ── 5. A single-run verdict is not evidence ─────────────────────────────────
// Three-run determinism is the schema's own minimum; a flaky-but-lucky
// single run must not pass as reproduced-and-fixed.
check('oracle.runs: 1 is rejected', () => {
  const problems = validateBundle(broken(b => { b.oracle.runs = 1 }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /oracle\.runs/.test(p) && /minimum/.test(p)),
    `expected a message naming oracle.runs below the minimum, got:\n${problems.join('\n')}`)
})

// ── 6. Unlocked test dirs with no stated reason ─────────────────────────────
// An unlocked test directory bypassed a deliberate safeguard; the bundle
// must carry why, so a reviewer sees it instead of discovering it later.
check('fix.test_dirs_unlocked: true with no unlock_reason is rejected', () => {
  const problems = validateBundle(broken(b => { b.fix.test_dirs_unlocked = true }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /unlock_reason/.test(p)), `expected a message naming "unlock_reason", got:\n${problems.join('\n')}`)
})

// ── 7. No context_packet_hash ────────────────────────────────────────────────
// Without this hash there is no provenance link from the bundle back to the
// context the agent actually worked from.
check('a missing context_packet_hash is rejected', () => {
  const problems = validateBundle(broken(b => { delete b.context_packet_hash }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /context_packet_hash/.test(p)), `expected a message naming "context_packet_hash", got:\n${problems.join('\n')}`)
})

// ── 8a. plugin_version is a placeholder, not a real semver ─────────────────
// On a live run, sdlc-ticket-intake could not locate the installed plugin's
// plugin.json and wrote plugin_version: "unknown". A bare `{"type": "string"}`
// let that validate — an unverifiable value wearing the shape of a verified
// one. The pattern must accept what the plugin actually declares
// (~/.claude/plugins/cache/alepo-engineering/alepo-engineering/*/.claude-plugin/plugin.json
// has "version": "0.1.0", a plain MAJOR.MINOR.PATCH) and reject every
// placeholder a stuck lookup might fall back to.
check('plugin_version: "unknown" is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = 'unknown' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "n/a" is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = 'n/a' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "TBD" is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = 'TBD' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "" (empty string) is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = '' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "N/A" (case variant placeholder) is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = 'N/A' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "1.0" (not full major.minor.patch) is rejected', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = '1.0' }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /plugin_version/.test(p)), `expected a message naming "plugin_version", got:\n${problems.join('\n')}`)
})

check('plugin_version: "0.1.0" (the real installed plugin version) validates', () => {
  const problems = validateBundle(broken(b => { b.plugin_version = '0.1.0' }))
  assert.deepEqual(problems, [], `expected no problems, got:\n${problems.join('\n')}`)
})

// ── 8b. watch: a directly-invoked run has no watch, but must not write null ─
// The live run that exposed this was started directly rather than by the
// watcher, so intake wrote watch: null, which fails assembly outright
// (`watch` is required and typed as a non-nullable string). Loosening the
// type to allow null would make "nothing triggered this" indistinguishable
// from "the field was simply omitted" — so the standard instead reserves the
// literal "direct-invocation" for a manually-started run. The field keeps
// answering "what triggered this?" truthfully in both cases.
check('watch: null is rejected — a directly-invoked run must use the reserved literal, not null', () => {
  const problems = validateBundle(broken(b => { b.watch = null }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /watch/.test(p)), `expected a message naming "watch", got:\n${problems.join('\n')}`)
})

check('watch: "direct-invocation" (the reserved literal for a manually-started run) validates', () => {
  const problems = validateBundle(broken(b => { b.watch = 'direct-invocation' }))
  assert.deepEqual(problems, [], `expected no problems, got:\n${problems.join('\n')}`)
})

// ── 8. Two repos, no merge_order ─────────────────────────────────────────────
// With more than one repo the apply order across them is otherwise
// undefined — the schema only documents this in prose, so it must be
// enforced here.
check('fix.repos with two entries and no merge_order is rejected', () => {
  const problems = validateBundle(broken(b => {
    b.fix.repos.push({ repo: 'alepolab/pcrf_cpp14', commits: ['1234567'], pr: 'https://github.com/alepolab/pcrf_cpp14/pull/9' })
  }))
  assert.ok(problems.length, 'expected at least one problem')
  assert.ok(problems.some(p => /merge_order/.test(p)), `expected a message naming "merge_order", got:\n${problems.join('\n')}`)
})

// ── 9. The CLI itself: exit 0 on valid, exit 1 with reasons on invalid ─────
check('the CLI exits 0 for a valid bundle and 1 with reasons for an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-cli-test-'))
  try {
    const okFile = join(dir, 'ok.json')
    const badFile = join(dir, 'bad.json')
    writeFileSync(okFile, JSON.stringify(validBundle()))
    writeFileSync(badFile, JSON.stringify(broken(b => { delete b.context_packet_hash })))

    const ok = execFileSync('node', [join(root, 'scripts/validate-bundle.mjs'), okFile], { encoding: 'utf8' })
    assert.match(ok, /valid/i)

    let bad
    try {
      execFileSync('node', [join(root, 'scripts/validate-bundle.mjs'), badFile],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      assert.fail('the CLI should have exited non-zero on an invalid bundle')
    } catch (e) {
      bad = e
    }
    assert.equal(bad.status, 1, 'an invalid bundle must exit 1')
    assert.match(`${bad.stdout ?? ''}${bad.stderr ?? ''}`, /context_packet_hash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n✓ all ${passed} validate-bundle tests passed\n`)
