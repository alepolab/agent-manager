/**
 * Acceptance: a Runbook A run must produce a directory the REAL assembler
 * turns into a bundle the REAL validator accepts.
 *
 * The agents are stubbed; nothing else is. This is the test that fails when
 * the pipeline and the bundle contract drift apart — which is exactly the
 * failure that made this whole change necessary.
 *
 * Three scenarios, sharing one stub-writer factory:
 *   1. Happy path — ui_parsing blast radius, single repo, adversarial: null.
 *      Must validate.
 *   2. Money path, positive — money blast radius, two repos + merge_order,
 *      a real adversarial object. Must validate.
 *   3. Money path, negative — same as (2) but adversarial: null. Must be
 *      REJECTED, naming the adversarial field. Without this case, (2) only
 *      proves the assembler can carry the field, not that its absence is
 *      caught.
 *
 *   node scripts/test-runbook-a-acceptance.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'acceptance-'))
const runner = await import('../server/utils/workflowRunner.ts')
const { assembleBundle } = await import('../engineering/scripts/assemble-bundle.mjs')

const xunit = failures => `<testsuite tests="4" failures="${failures}" errors="0" skipped="0"/>`

const mergeMeta = (dir, patch) => {
  const path = join(dir, 'meta.json')
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  writeFileSync(path, JSON.stringify({ ...cur, ...patch }, null, 2))
}

// The directory is discovered from the input header — the same way a real
// agent must discover it. A change that breaks the header breaks this test.
const dirFrom = (input) => {
  const m = input.match(/Write every artifact you produce into: (\S+)/)
  assert.ok(m, 'every step input carries the artifacts directory')
  return m[1]
}

// One writer factory shared by all three scenarios, parameterised on the
// three things that vary: blast_radius (drives the adversarial conditional),
// fix.repos/merge_order (drives the multi-repo conditional), and the
// adversarial object sdlc-verifier merges (or null).
const makeWriters = ({ blastRadius, repos, mergeOrder, adversarial }) => ({
  'sdlc-ticket-intake': (dir) => {
    writeFileSync(join(dir, 'intent.md'), '# Intent\n\nParsing drops the second AVP.\n')
    writeFileSync(join(dir, 'context-packet.json'), JSON.stringify({ ticket: 'SA-1203' }))
    mergeMeta(dir, {
      ticket: 'SA-1203', watch: 'sa-bugs', work_type: 'bug', class: 'parsing',
      product: 'ocs_cpp14', blast_radius: blastRadius, plugin_version: '0.1.0',
    })
  },
  'sdlc-stack-provisioner': dir =>
    mergeMeta(dir, { stack: { profile: 'ocs', topology: 'single', liquibase_tag: null } }),
  'sdlc-test-author': (dir) => {
    writeFileSync(join(dir, 'oracle-before.xml'), xunit(4))
    mergeMeta(dir, { oracle: { kind: 'parameterised_test', path: 'tests/test_avp.py', runs: 3, rows: 4 } })
  },
  'sdlc-fix-implementer': (dir) => {
    writeFileSync(join(dir, 'plan.md'), '# Plan\n\nFix the loop bound.\n')
    const fix = {
      repos, files_changed: 2, lines_changed: 18, test_dirs_unlocked: false, unlock_reason: null,
    }
    if (mergeOrder) fix.merge_order = mergeOrder
    mergeMeta(dir, { fix })
  },
  // Owner of the adversarial field, per the fixed sdlc-verifier prompt: it
  // already owns post-fix verification, and adversarial verification is a
  // verification activity, not something ticket-intake should guess at
  // before any code has changed.
  'sdlc-verifier': (dir) => {
    writeFileSync(join(dir, 'oracle-after.xml'), xunit(0))
    writeFileSync(join(dir, 'regression.xml'), xunit(0))
    mergeMeta(dir, {
      oracle_after: { kind: 'parameterised_test', path: 'tests/test_avp.py', runs: 3, rows: 4 },
      regression: { suite: 'full' },
      adversarial,
    })
  },
  'sdlc-trace-capture': dir => writeFileSync(join(dir, 'trace.zip'), 'PKstub'),
  'sdlc-evidence-and-pr': dir =>
    writeFileSync(join(dir, 'summary.md'), '# SA-1203\n\nWhat was wrong, what changed, what proves it.\n'),
})

const workflow = {
  slug: 'runbook-a', name: 'Runbook A',
  steps: [
    { id: 'i', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['s'] },
    { id: 's', agentSlug: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['t'] },
    { id: 't', agentSlug: 'sdlc-test-author', label: 'Failing Test', next: ['f'] },
    { id: 'f', agentSlug: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['v', 'c'] },
    { id: 'v', agentSlug: 'sdlc-verifier', label: 'Verify + Regression', next: ['e'] },
    { id: 'c', agentSlug: 'sdlc-trace-capture', label: 'Browser Trace', next: ['e'] },
    { id: 'e', agentSlug: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR',
      next: [], contextMode: 'ancestors' },
  ],
}

/** Runs the whole workflow against one writer set and assembles the result. */
async function runScenario(writers) {
  runner.setAgentCaller(async (agentSlug, input) => {
    writers[agentSlug](dirFrom(input))
    return `${agentSlug} done. EVIDENCE-FROM-${agentSlug}`
  })

  const run = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'Fix SA-1203', autoRun: true })).id, 15000)
  assert.equal(run.status, 'completed',
    `run finished: ${JSON.stringify(run.steps.map(s => [s.stepId, s.status, s.error]))}`)

  const dir = join(process.env.CLAUDE_DIR, 'workflow-runs', run.id, 'artifacts')
  const { bundle, problems } = await assembleBundle(dir)
  return { run, bundle, problems }
}

// ── Scenario 1: happy path — ui_parsing, single repo, no adversarial ───────
{
  const writers = makeWriters({
    blastRadius: 'ui_parsing',
    repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://example.invalid/pr/1' }],
    adversarial: null,
  })
  const { run, bundle, problems } = await runScenario(writers)

  // The keystone property, asserted directly: the evidence step saw the step
  // three hops upstream that produced the pre-fix FAIL.
  const evidenceInput = run.steps.find(s => s.stepId === 'e').input
  assert.ok(evidenceInput.includes('EVIDENCE-FROM-sdlc-test-author'),
    'the evidence step receives the test author output, three hops upstream')

  assert.deepEqual(problems, [],
    `the happy-path bundle must validate. Problems: ${JSON.stringify(problems, null, 2)}`)
  assert.equal(bundle.oracle.verdict, 'FAIL', 'the pre-fix oracle failed — something was reproduced')
  assert.equal(bundle.oracle_after.verdict, 'PASS', 'the post-fix oracle passed')
  assert.equal(bundle.ticket, 'SA-1203')
  assert.equal(bundle.adversarial, null, 'ui_parsing blast radius carries no adversarial report')
  console.log('  ok  scenario 1: ui_parsing happy path validates')
}

// ── Scenario 2: money path, positive — two repos + merge_order, a real
//    adversarial object. Must validate. ──────────────────────────────────
{
  const writers = makeWriters({
    blastRadius: 'money',
    repos: [
      { repo: 'alepolab/billing_cpp14', commits: ['1111111'], pr: 'https://example.invalid/pr/2' },
      { repo: 'alepolab/ocs_cpp14', commits: ['2222222'], pr: 'https://example.invalid/pr/3' },
    ],
    mergeOrder: ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
    adversarial: {
      report: 'Two-node rerun performed against a two-instance rating stack; pattern search for the same off-by-one across both repos found no other occurrences.',
      two_node_rerun: true,
      pattern_search: 'grep for the same AVP-index loop shape across billing_cpp14 and ocs_cpp14',
      mutation_score: 0.82,
    },
  })
  const { bundle, problems } = await runScenario(writers)

  assert.deepEqual(problems, [],
    `the money-path bundle with a real adversarial report must validate. Problems: ${JSON.stringify(problems, null, 2)}`)
  assert.ok(bundle.adversarial && typeof bundle.adversarial === 'object',
    'the money-path bundle carries an adversarial object')
  assert.deepEqual(bundle.fix.merge_order, ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
    'a two-repo fix carries its declared merge order')
  console.log('  ok  scenario 2: money path with a real adversarial report validates')
}

// ── Scenario 3: money path, negative — same shape as (2) but adversarial:
//    null. Must be REJECTED, naming the field. Without this case, (2) only
//    proves the assembler can carry the field, not that its absence is
//    caught. ─────────────────────────────────────────────────────────────
{
  const writers = makeWriters({
    blastRadius: 'money',
    repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://example.invalid/pr/1' }],
    adversarial: null,
  })
  const { problems } = await runScenario(writers)

  assert.ok(problems.length > 0,
    'a money-path bundle with no adversarial report must be rejected, not silently accepted')
  assert.ok(problems.some(p => p.includes('adversarial')),
    `rejection must name the missing adversarial report. Problems: ${JSON.stringify(problems, null, 2)}`)
  console.log(`  ok  scenario 3: money path with adversarial: null is rejected — ${JSON.stringify(problems)}`)
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('runbook A acceptance: all checks passed')
