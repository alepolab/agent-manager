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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'acceptance-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'acceptance-artifacts-'))
const runner = await import('../server/utils/workflowRunner.ts')
const { assembleBundle } = await import('../engineering/scripts/assemble-bundle.mjs')

// fix.repos/files_changed/lines_changed are now COMPUTED from git at finalize
// time (server/utils/gitFacts.ts), not trusted from the agent's self-report —
// see runArtifacts.ts's reconcileFix. Every scenario below needs a run with a
// real projectDir so `fix` is even present in the assembled bundle.
//
// gitFacts.ts now measures each run against ITS OWN baseline
// (WorkflowRun.baseCommit, captured by startRun the instant the run began —
// see shared/types/run.ts), never against `main`. So the "fix" commit can no
// longer be made before startRun is called (that was the exact fabrication
// bug this whole change exists to close: a commit that predates the run
// would misreport as this run's own work). Instead, the sdlc-fix-implementer
// writer below makes the commit for real, DURING the run, and each scenario
// computes its own ground truth from the run's own `baseCommit` afterward —
// independently of gitFacts.ts / reconcileFix, so a broken reconciliation (a
// swallowed finalizeRunArtifacts failure, a stale self-report surviving)
// fails this test instead of passing silently.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
const projectDir = mkdtempSync(join(tmpdir(), 'acceptance-project-'))
git(projectDir, ['init', '-q', '-b', 'main'])
git(projectDir, ['config', 'user.email', 'test@example.invalid'])
git(projectDir, ['config', 'user.name', 'Test'])
writeFileSync(join(projectDir, 'avp_parser.c'), 'int parse(void) { return 0; }\n')
git(projectDir, ['add', '.'])
git(projectDir, ['commit', '-q', '-m', 'initial'])
git(projectDir, ['remote', 'add', 'origin', 'git@github.com:alepolab/ocs_cpp14.git'])
git(projectDir, ['checkout', '-q', '-b', 'fix/SA-1203'])

/** The one commit each scenario's sdlc-fix-implementer writer makes for
 *  real, against the run's OWN baseline — never before startRun captures it.
 *  Content differs per call (the counter) so each scenario's commit is a
 *  genuine, non-empty diff even though the three scenarios share one repo. */
let fixCommitCounter = 0
function makeFixCommit() {
  fixCommitCounter += 1
  writeFileSync(join(projectDir, 'avp_parser.c'),
    `int parse(void) { return 1; /* fixed, attempt ${fixCommitCounter} */ }\n`)
  git(projectDir, ['add', '.'])
  git(projectDir, ['commit', '-q', '-m', `fix the AVP loop bound (attempt ${fixCommitCounter})`])
}

/** Ground truth for one scenario's run, computed from git independently of
 *  gitFacts.ts — against that RUN's OWN recorded baseline, not `main`. */
function expectedFactsSince(baseCommit) {
  const commits = git(
    projectDir, ['rev-list', '--reverse', '--abbrev-commit', '--abbrev=12', `${baseCommit}..HEAD`],
  ).split('\n').map(s => s.trim()).filter(Boolean)
  const numstat = git(projectDir, ['diff', '--numstat', `${baseCommit}..HEAD`])
    .split('\n').map(s => s.trim()).filter(Boolean)
  const filesChanged = numstat.length
  const linesChanged = numstat.reduce((sum, line) => {
    const [added, removed] = line.split('\t')
    return sum + (Number(added) || 0) + (Number(removed) || 0)
  }, 0)
  return { commits, filesChanged, linesChanged }
}

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
    // The real commit this scenario's run makes, against its OWN baseline —
    // captured by startRun before this step (or any step) ran. `repos` below
    // is still the agent's SELF-REPORTED (and deliberately wrong) commit
    // list/counts — reconciliation must overwrite them with what this commit
    // actually did, for the one repo (ocs_cpp14) git can verify from this
    // run's projectDir.
    makeFixCommit()
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
  // Reports the { output, model, usage } shape callAgent() actually returns
  // (agentCaller.ts), not a bare string. A bare-string stub never exercises
  // meta.json's `model` field at all — normalizeAgentResult (workflowRunner.ts)
  // treats a string as { output: r }, model always undefined, so every
  // scenario would silently depend on runArtifacts.ts's removed
  // DEFAULT_MODEL_ALIAS fallback to produce a valid bundle. Reporting a real
  // model id here is what makes this the acceptance test for the real path.
  runner.setAgentCaller(async (agentSlug, input) => {
    writers[agentSlug](dirFrom(input))
    return {
      output: `${agentSlug} done. EVIDENCE-FROM-${agentSlug}`,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 40 },
    }
  })

  const run = await runner.waitForSettled(
    (await runner.startRun({
      workflow, initialPrompt: 'Fix SA-1203', watch: 'direct-invocation', autoRun: true, projectDir,
    })).id, 15000)
  assert.equal(run.status, 'completed',
    `run finished: ${JSON.stringify(run.steps.map(s => [s.stepId, s.status, s.error]))}`)

  const dir = join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts')
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

  // model is the value every step actually reported (the stub caller's
  // object shape), never DEFAULT_MODEL_ALIAS — proves the fallback removal
  // in runArtifacts.ts didn't just move the fabrication into this test.
  assert.equal(bundle.model, 'claude-sonnet-4-6',
    'model is the real value every step reported, not a fallback default')
  // watch is the runner's own fact for a run this test started directly
  // (not via a watch), asserted over whatever an agent might have written.
  assert.equal(bundle.watch, 'direct-invocation',
    'watch is the runner-owned fact for a directly-invoked run, never left to the agent')

  // The end-to-end assertion: compare the assembled bundle's fix.* against
  // what git actually reports SINCE THIS RUN'S OWN BASELINE, computed
  // independently above — never against `main`. A finalizeRunArtifacts that
  // silently failed (see workflowRunner.ts's publish()) would leave the
  // agent's uncomputed self-report in meta.json instead — this catches that
  // even if the bundle still "validates".
  assert.ok(run.baseCommit, 'startRun captured a baseline for this run')
  const expected1 = expectedFactsSince(run.baseCommit)
  assert.equal(expected1.commits.length, 1, 'sanity: this scenario made exactly one real commit')
  assert.equal(bundle.fix.repos.length, 1)
  assert.deepEqual(bundle.fix.repos[0].commits, expected1.commits,
    'fix.repos[0].commits is exactly what git reports since the run\'s baseline, not the agent\'s self-report of ["abcdef1"]')
  assert.equal(bundle.fix.files_changed, expected1.filesChanged,
    'fix.files_changed matches git, independently computed')
  assert.equal(bundle.fix.lines_changed, expected1.linesChanged,
    'fix.lines_changed matches git, independently computed')
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
  const { run, bundle, problems } = await runScenario(writers)

  assert.deepEqual(problems, [],
    `the money-path bundle with a real adversarial report must validate. Problems: ${JSON.stringify(problems, null, 2)}`)
  assert.ok(bundle.adversarial && typeof bundle.adversarial === 'object',
    'the money-path bundle carries an adversarial object')
  assert.deepEqual(bundle.fix.merge_order, ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
    'a two-repo fix carries its declared merge order')

  // The multi-repo path, genuinely exercised: reconcileFix can only compute
  // git facts for ONE repo (run.projectDir, which resolves to ocs_cpp14
  // here) — billing_cpp14 is a repo it has no way to check. It must survive
  // reconciliation as the agent's self-report (same trust boundary already
  // applied to `pr`, which no git command can produce either), while the ONE
  // repo the runner CAN verify is overwritten with git's own facts, never
  // the agent's claim of ['2222222']. Without this, `repos` collapses to the
  // one computed entry, `merge_order` above would name a repo not present in
  // `fix.repos`, and this scenario stops testing the multi-repo path its own
  // comment claims.
  assert.equal(bundle.fix.repos.length, 2,
    'both repos survive: the one git computed, and the one only the agent could report')
  assert.deepEqual(bundle.fix.repos.map(r => r.repo).sort(),
    ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'])
  const billingEntry = bundle.fix.repos.find(r => r.repo === 'alepolab/billing_cpp14')
  const ocsEntry = bundle.fix.repos.find(r => r.repo === 'alepolab/ocs_cpp14')
  assert.deepEqual(billingEntry.commits, ['1111111'],
    'a repo git cannot verify from this run\'s projectDir survives as the agent\'s self-report')
  const expected2 = expectedFactsSince(run.baseCommit)
  assert.equal(expected2.commits.length, 1, 'sanity: this scenario made exactly one real commit')
  assert.deepEqual(ocsEntry.commits, expected2.commits,
    'the repo git CAN verify is git\'s own commit list since THIS run\'s baseline, never the agent\'s claim of ["2222222"]')
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
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
rmSync(projectDir, { recursive: true, force: true })
console.log('runbook A acceptance: all checks passed')
