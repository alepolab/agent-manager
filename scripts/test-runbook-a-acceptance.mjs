/**
 * Acceptance: a Runbook A run must produce a directory the REAL assembler
 * turns into a bundle the REAL validator accepts.
 *
 * The agents are stubbed; nothing else is. This is the test that fails when
 * the pipeline and the bundle contract drift apart — which is exactly the
 * failure that made this whole change necessary.
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

const writers = {
  'sdlc-ticket-intake': (dir) => {
    writeFileSync(join(dir, 'intent.md'), '# Intent\n\nParsing drops the second AVP.\n')
    writeFileSync(join(dir, 'context-packet.json'), JSON.stringify({ ticket: 'SA-1203' }))
    mergeMeta(dir, {
      ticket: 'SA-1203', watch: 'sa-bugs', work_type: 'bug', class: 'parsing',
      product: 'ocs_cpp14', blast_radius: 'ui_parsing', plugin_version: '0.1.0',
      adversarial: null,
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
    mergeMeta(dir, {
      fix: {
        repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['abcdef1'], pr: 'https://example.invalid/pr/1' }],
        files_changed: 2, lines_changed: 18, test_dirs_unlocked: false, unlock_reason: null,
      },
    })
  },
  'sdlc-verifier': (dir) => {
    writeFileSync(join(dir, 'oracle-after.xml'), xunit(0))
    writeFileSync(join(dir, 'regression.xml'), xunit(0))
    mergeMeta(dir, {
      oracle_after: { kind: 'parameterised_test', path: 'tests/test_avp.py', runs: 3, rows: 4 },
      regression: { suite: 'full' },
    })
  },
  'sdlc-trace-capture': dir => writeFileSync(join(dir, 'trace.zip'), 'PKstub'),
  'sdlc-evidence-and-pr': dir =>
    writeFileSync(join(dir, 'summary.md'), '# SA-1203\n\nWhat was wrong, what changed, what proves it.\n'),
}

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

runner.setAgentCaller(async (agentSlug, input) => {
  writers[agentSlug](dirFrom(input))
  return `${agentSlug} done. EVIDENCE-FROM-${agentSlug}`
})

const run = await runner.waitForSettled(
  (await runner.startRun({ workflow, initialPrompt: 'Fix SA-1203', autoRun: true })).id, 15000)
assert.equal(run.status, 'completed',
  `run finished: ${JSON.stringify(run.steps.map(s => [s.stepId, s.status, s.error]))}`)

// The keystone property, asserted directly: the evidence step saw the step
// three hops upstream that produced the pre-fix FAIL.
const evidenceInput = run.steps.find(s => s.stepId === 'e').input
assert.ok(evidenceInput.includes('EVIDENCE-FROM-sdlc-test-author'),
  'the evidence step receives the test author output, three hops upstream')

const dir = join(process.env.CLAUDE_DIR, 'workflow-runs', run.id, 'artifacts')
const { bundle, problems } = await assembleBundle(dir)
assert.deepEqual(problems, [],
  `the assembled bundle must validate. Problems: ${JSON.stringify(problems, null, 2)}`)
assert.equal(bundle.oracle.verdict, 'FAIL', 'the pre-fix oracle failed — something was reproduced')
assert.equal(bundle.oracle_after.verdict, 'PASS', 'the post-fix oracle passed')
assert.equal(bundle.ticket, 'SA-1203')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('runbook A acceptance: all checks passed')
