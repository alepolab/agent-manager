#!/usr/bin/env node
/**
 * Proves the one-screen summary actually says the things a reviewer needs
 * before they open the diff: what was wrong, what changed, what proves it,
 * the blast-radius label, the deployment truths considered, and the cost.
 *
 * The 40-line cap is asserted directly, not assumed — "one screen" is the
 * requirement (a summary a reviewer scrolls is a summary they skim), so a
 * layout regression that quietly grows past a screen is a test failure here,
 * not something discovered later in review.
 *
 * A null `trace` must say so explicitly. Silent omission of a row is
 * indistinguishable from a bug that dropped it — the whole bundle design
 * exists to stop evidence gaps hiding, and the summary is the first place a
 * gap would hide.
 *
 *   node scripts/test-bundle-summary.mjs
 */
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSummary } from './bundle-summary.mjs'
import { validateBundle } from './validate-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── One complete, valid bundle (same shape as test-validate-bundle.mjs) ────
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
    summary_md: '',
  }
}

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

// ── The fixture the summary is rendered from also validates on its own ─────
// (guards against the fixture drifting out of sync with the schema)
check('the fixture bundle itself validates', () => {
  const problems = validateBundle(validBundle())
  assert.deepEqual(problems, [], `fixture bundle is not schema-valid:\n${problems.join('\n')}`)
})

// ── What was wrong ──────────────────────────────────────────────────────────
check('summary states what was wrong: ticket, work type, class, pre-fix FAIL', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /SA-1203/)
  assert.match(md, /bug/)
  assert.match(md, /parsing/)
  assert.match(md, /FAIL/, 'expected the pre-fix FAIL verdict to appear — that is the proof something was actually reproduced')
})

// ── What changed ─────────────────────────────────────────────────────────────
check('summary states what changed: repo, commit, PR, files/lines', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /alepolab\/ocs_cpp14/)
  assert.match(md, /abcdef1/)
  assert.match(md, /pull\/42/)
  assert.match(md, /3/, 'expected files_changed to appear')
  assert.match(md, /42/, 'expected lines_changed to appear')
})

// ── What proves it ───────────────────────────────────────────────────────────
check('summary states what proves it: oracle after PASS, regression counts', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /PASS/)
  assert.match(md, /120/, 'expected the regression pass count to appear')
})

// ── Blast-radius label ───────────────────────────────────────────────────────
check('summary states the blast-radius label', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /ui_parsing/)
})

// ── Deployment truths considered ────────────────────────────────────────────
check('summary states the deployment truths considered: profile and topology', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /ffmhost1/)
  assert.match(md, /single-node/)
})

// ── Cost ──────────────────────────────────────────────────────────────────────
check('summary states the cost: tokens, attempts, wall clock', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /12,?000/, 'expected input_tokens to appear')
  assert.match(md, /3,?000/, 'expected output_tokens to appear')
  assert.match(md, /14\.5/, 'expected wall_clock_min to appear')
})

// ── The one-screen cap ──────────────────────────────────────────────────────
check('summary stays under 40 lines for a single-repo bundle', () => {
  const md = renderSummary(validBundle())
  const lines = md.split('\n')
  assert.ok(lines.length < 40, `expected under 40 lines, got ${lines.length}:\n${md}`)
})

check('summary stays under 40 lines even for a money/adversarial multi-repo bundle', () => {
  const bundle = broken(b => {
    b.blast_radius = 'money'
    b.adversarial = {
      report: 'reports/adversarial-SA-1203.md',
      two_node_rerun: true,
      pattern_search: 'grep -R "TODO|FIXME" across billing_cpp14',
      mutation_score: 0.92,
    }
    b.fix.repos.push({ repo: 'alepolab/pcrf_cpp14', commits: ['1234567', '89abcde'], pr: 'https://github.com/alepolab/pcrf_cpp14/pull/9' })
    b.fix.merge_order = ['alepolab/ocs_cpp14', 'alepolab/pcrf_cpp14']
    b.fix.test_dirs_unlocked = true
    b.fix.unlock_reason = 'Robot ATDD suite required a fixture only present under test/'
  })
  const md = renderSummary(bundle)
  const lines = md.split('\n')
  assert.ok(lines.length < 40, `expected under 40 lines, got ${lines.length}:\n${md}`)
  assert.match(md, /money/)
  assert.match(md, /pcrf_cpp14/)
})

// ── The null-trace assertion this task exists to make ───────────────────────
// A dropped row and a legitimate "no browser evidence" are indistinguishable
// unless the summary says which one happened.
check('a null trace is stated explicitly, not silently omitted', () => {
  const md = renderSummary(validBundle())
  assert.match(md, /trace/i, 'expected a trace row to be present at all')
  const traceRow = md.match(/.*trace.*/i)?.[0] ?? ''
  assert.match(traceRow, /no|none|not captured|n\/a/i,
    'expected the trace row to say explicitly that there is no trace')
})

check('a present trace path is rendered, not the "no trace" wording', () => {
  const bundle = broken(b => { b.trace = 'artifacts/trace-SA-1203.zip' })
  const md = renderSummary(bundle)
  assert.match(md, /artifacts\/trace-SA-1203\.zip/)
})

// ── The CLI itself ────────────────────────────────────────────────────────
check('the CLI prints the same Markdown renderSummary() produces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-summary-cli-test-'))
  try {
    const file = join(dir, 'bundle.json')
    writeFileSync(file, JSON.stringify(validBundle()))
    const out = execFileSync('node', [join(root, 'scripts/bundle-summary.mjs'), file], { encoding: 'utf8' })
    assert.equal(out.trim(), renderSummary(validBundle()).trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n✓ all ${passed} bundle-summary tests passed\n`)
