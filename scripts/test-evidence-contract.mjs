/**
 * Self-check for server/utils/evidenceContract.ts.
 *
 * The defect this closes: a review of 13 completed runs found the bundle
 * contract honoured by under half of them, three different meta.json
 * schemas in the wild, no provenance linking a run to the code/workflow that
 * produced it, no link between a ticket's own runs, and no measured size —
 * see evidenceContract.ts's file header for the full finding. This is the
 * unit-level proof that each of the five fixes reports exactly what it
 * claims to, and never fabricates what it cannot know.
 *
 *   node scripts/test-evidence-contract.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'evidence-contract-claudedir-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'evidence-contract-runs-'))

const E = await import('../server/utils/evidenceContract.ts')
const { updateRunIndex } = await import('../server/utils/runIndex.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

// ── 1. bundle contract: exactly what is missing, empty (not absent) when
//    nothing is ─────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'evidence-contract-bundle-'))
  writeFileSync(join(dir, 'intent.md'), '# intent\n')
  writeFileSync(join(dir, 'summary.md'), '# summary\n')
  const missing = await E.missingContractFiles(dir)
  assert.deepEqual([...missing].sort(),
    ['context-packet.json', 'oracle-after.xml', 'oracle-before.xml', 'plan.md', 'regression.xml'].sort(),
    'reports exactly the files this run never wrote')

  for (const f of E.BUNDLE_CONTRACT_FILES) writeFileSync(join(dir, f), f.endsWith('.json') ? '{}' : 'x')
  assert.deepEqual(await E.missingContractFiles(dir), [],
    'a complete run gets an empty list, not no list at all')
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. required core: exactly what is missing, empty (not absent) when
//    nothing is ─────────────────────────────────────────────────────────
{
  const bare = { id: 'r1', workflowSlug: 'w', startedAt: Date.now(), steps: [] }
  assert.deepEqual([...E.missingCore(bare, {})].sort(),
    ['cost', 'ended', 'model', 'product', 'repos', 'ticket'].sort(),
    'a run with no ticket, product, fix, model, end time or cost reports all six as missing')

  const complete = {
    id: 'r2', workflowSlug: 'w', ticketKey: 'CSUP-1', product: { name: 'p' },
    startedAt: Date.now(), endedAt: Date.now() + 1, steps: [],
  }
  const completeMeta = { model: 'claude-sonnet-4-6', fix: { repos: [{ repo: 'org/x' }] }, cost: { input_tokens: 0, output_tokens: 0 } }
  assert.deepEqual(E.missingCore(complete, completeMeta), [],
    'a run that states every core fact reports nothing missing')

  // ticket/product accepted from EITHER the run record or an agent's own
  // classification in meta — a directly-invoked run has no ticket until
  // intake classifies one.
  const classifiedOnly = { id: 'r3', workflowSlug: 'w', startedAt: Date.now(), endedAt: Date.now(), steps: [] }
  const classifiedMeta = { ticket: 'CSUP-2', product: 'ocs_cpp14', model: 'm', fix: { repos: [{ repo: 'x' }] }, cost: {} }
  assert.deepEqual(E.missingCore(classifiedOnly, classifiedMeta), [],
    'ticket/product read from meta when the run record itself has neither')
}

// ── 3. provenance: present when knowable, absent (never null, never a
//    guess) when not ────────────────────────────────────────────────────
{
  process.env.BUILD_SHA = 'deadbeefcafe'
  assert.equal(E.appBuildSha('/definitely/does/not/exist'), 'deadbeefcafe',
    'BUILD_SHA wins when set, regardless of whether a .git is even reachable')
  delete process.env.BUILD_SHA
  assert.equal(E.appBuildSha('/definitely/does/not/exist'), undefined,
    'absent — never a placeholder — when neither BUILD_SHA nor a .git/HEAD resolves')

  const runA = { steps: [{ stepId: 's1', label: 'A', agentSlug: 'agent-a' }] }
  const runB = { steps: [{ stepId: 's1', label: 'A', agentSlug: 'agent-b' }] }
  const hashA = E.stepGraphHash(runA)
  assert.match(hashA, /^[0-9a-f]{64}$/, 'a real sha256 hex digest')
  assert.equal(hashA, E.stepGraphHash(runA), 'the same step shape hashes identically')
  assert.notEqual(hashA, E.stepGraphHash(runB), 'a different agentSlug changes the hash')

  assert.equal(E.perStepModels({ steps: [{ stepId: 's1' }] }), undefined,
    'absent, never {}, when not one step reported a model')
  assert.deepEqual(
    E.perStepModels({ steps: [{ stepId: 's1', model: 'claude-sonnet-4-6' }, { stepId: 's2' }] }),
    { s1: 'claude-sonnet-4-6' },
    'per-step models, keyed by stepId, only for steps that reported one',
  )
}

// ── 4. prior_runs: links two runs of one ticket, absent for the first ───
{
  const t = 'CSUP-EVIDENCE-1'
  const runA = {
    id: 'run-a', workflowSlug: 'w', workflowName: 'W', ticketKey: t, status: 'completed',
    watch: 'direct-invocation', startedAt: Date.now() - 10000, endedAt: Date.now() - 5000, steps: [],
  }
  assert.equal(await E.priorRunsFor(runA.ticketKey, runA.id), undefined,
    'the first run of a ticket has no prior runs to link')
  await updateRunIndex(runA, {})

  const runB = {
    id: 'run-b', workflowSlug: 'w', workflowName: 'W', ticketKey: t, status: 'completed',
    watch: 'direct-invocation', startedAt: Date.now(), endedAt: Date.now() + 1, steps: [],
  }
  const prior = await E.priorRunsFor(runB.ticketKey, runB.id)
  assert.equal(prior?.length, 1, 'the second run sees exactly the first as prior')
  assert.equal(prior[0].runId, 'run-a')
  assert.equal(prior[0].status, 'completed')

  assert.equal(await E.priorRunsFor(undefined, 'run-c'), undefined,
    'no ticket at all means nothing to link')
}

// ── 5. artifact size: measured, matching real files on disk ─────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'evidence-contract-size-'))
  writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))
  writeFileSync(join(dir, 'b.txt'), 'y'.repeat(50))
  mkdirSync(join(dir, 'steps'))
  writeFileSync(join(dir, 'steps', 'c.txt'), 'z'.repeat(10))
  const measured = await E.measureArtifacts(dir)
  assert.equal(measured.file_count, 3)
  assert.equal(measured.bytes, 160, 'total bytes is the real sum on disk, not an estimate')
  assert.equal(measured.largest[0].name, 'a.txt')
  assert.equal(measured.largest[0].bytes, 100)
  assert.equal(measured.largest[2].name, 'steps/c.txt', 'a nested file is measured too, path-qualified')
  rmSync(dir, { recursive: true, force: true })
}

// ── 6. pruner: reports before it writes, removes only .bak/*.tmp/*superseded* ─
{
  const runId = 'prune-run-1'
  const dir = runArtifactsDir(runId)
  mkdirSync(join(dir, 'steps'), { recursive: true })
  writeFileSync(join(dir, 'meta.json'), '{}')
  writeFileSync(join(dir, 'meta.json.bak'), 'stale')
  writeFileSync(join(dir, 'scratch.tmp'), 'partial')
  writeFileSync(join(dir, 'steps', 'step-01-x-superseded-retry-1.json'), '{}')
  writeFileSync(join(dir, 'plan.md'), '# keep me\n')

  const dryRun = execFileSync('node', ['scripts/prune-run-artifacts.mjs'], {
    encoding: 'utf8', env: process.env,
  })
  assert.match(dryRun, /would remove/, 'without --write, the pruner only reports')
  assert.match(dryRun, /meta\.json\.bak/)
  assert.match(dryRun, /scratch\.tmp/)
  assert.match(dryRun, /superseded/)
  assert.ok(existsSync(join(dir, 'meta.json.bak')) && existsSync(join(dir, 'scratch.tmp')),
    'a dry run deletes nothing')

  const written = execFileSync('node', ['scripts/prune-run-artifacts.mjs', '--write'], {
    encoding: 'utf8', env: process.env,
  })
  assert.match(written, /removed/, 'a report is still printed before/with the write')
  assert.ok(!existsSync(join(dir, 'meta.json.bak')), 'the .bak is gone')
  assert.ok(!existsSync(join(dir, 'scratch.tmp')), 'the .tmp is gone')
  assert.ok(!existsSync(join(dir, 'steps', 'step-01-x-superseded-retry-1.json')), 'the superseded marker is gone')
  assert.ok(existsSync(join(dir, 'meta.json')), 'meta.json itself is never a pruning target')
  assert.ok(existsSync(join(dir, 'plan.md')), 'a real evidence file is never touched')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('evidence contract: all checks passed')
