/**
 * The runner opens the pull request, because nobody else does.
 *
 * A run committed real work and reported success from a step labelled
 * "Evidence, Docs & Pull Request", and there was no pull request: the step's
 * agent curates documentation, and no agent in the estate opens a PR at all
 * (`grep -rl 'gh pr create' .agents/agents/` is empty). The branch sat
 * unpushed while the ticket got a comment saying the work was done.
 *
 * So this is the runner's job, like the Jira calls beside it: a REST/CLI action
 * whose result is a runner-owned fact rather than something an agent might
 * volunteer. Every case below fixes one way that can lie.
 *
 * Run 3ebe1e6e is the shape to hold: it committed to TWO repositories — the
 * gate itself in a nested module repo, the documentation in the parent — and
 * `computeFixFacts` recorded only the parent, because it measures
 * `run.projectDir` alone. A PR step that inherited that blind spot would open
 * a PR for the docs and silently drop the code.
 *
 *   node scripts/test-pr-step.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'pr-step-runs-'))

const { runPrStep } = await import('../server/utils/prStep.ts')
const { PLACEHOLDER_PR } = await import('../server/utils/runArtifacts.ts')

const RUN_BRANCH = 'fix/CSUP-7514-3ebe1e6e'

const run = {
  id: '3ebe1e6e-8ab2-4abf-b447-82a90a30d34d',
  ticketKey: 'CSUP-7514',
  workflowSlug: 'oma-csup-to-pr',
  workflowName: 'CSUP: support ticket to pull request',
  status: 'running',
  watch: 'direct-invocation',
  branch: RUN_BRANCH,
  baseBranch: 'develop',
  projectDir: '/work/ase_lbss@fix-CSUP-7514',
  steps: [],
  startedAt: Date.now(),
  budget: { maxMinutes: 60, maxTokens: 1 },
}

/**
 * A fake exec. Every repo is described by what git would answer for it, so a
 * case is written by describing a checkout rather than by building one.
 */
function fakeExec(repos, log = []) {
  return async (cmd, args, opts) => {
    const cwd = opts?.cwd ?? ''
    log.push(`${cwd}: ${cmd} ${args.join(' ')}`)
    const repo = repos[cwd]
    if (!repo) throw new Error(`not a git repository: ${cwd}`)
    const a = args.join(' ')
    if (a.startsWith('rev-parse --abbrev-ref HEAD')) return repo.branch
    if (a.startsWith('remote get-url origin')) return `https://github.com/${repo.name}.git`
    if (a.startsWith('rev-list --count')) return String(repo.commitsAhead ?? 0)
    if (a.startsWith('push')) {
      if (repo.pushFails) throw new Error('remote rejected: protected branch')
      return ''
    }
    if (cmd === 'gh' && a.startsWith('pr create')) {
      if (repo.prFails) throw new Error('gh: pull request already exists for this branch')
      return `https://github.com/${repo.name}/pull/${repo.prNumber ?? 1}`
    }
    if (cmd === 'gh' && a.startsWith('pr view')) return repo.existingPr ?? ''
    return ''
  }
}

// ── 1. every repo on the run's branch gets a pull request ───────────────────
// The multi-repo case from run 3ebe1e6e, which the fix-facts path misses.
{
  const repos = {
    '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1, prNumber: 158 },
    '/work/ase_lbss@fix-CSUP-7514/modules/sasktel-customizations': { name: 'alepolab/sasktel-customizations', branch: RUN_BRANCH, commitsAhead: 1, prNumber: 205 },
  }
  const result = await runPrStep(run, { exec: fakeExec(repos), repoDirs: Object.keys(repos) })
  assert.equal(result.prs.length, 2, `both repositories get a PR; got ${JSON.stringify(result.prs)}`)
  const byRepo = Object.fromEntries(result.prs.map(p => [p.repo, p.url]))
  assert.equal(byRepo['alepolab/ase_lbss'], 'https://github.com/alepolab/ase_lbss/pull/158')
  assert.equal(byRepo['alepolab/sasktel-customizations'], 'https://github.com/alepolab/sasktel-customizations/pull/205')
  // The nested module is the one a projectDir-only implementation would drop.
  assert.ok(
    result.lines.join('\n').includes('sasktel-customizations'),
    'the nested module repository must be named in the output, not silently dropped',
  )
}

// ── 2. a repo that is not on the run's branch is left alone ─────────────────
// A super-repo's other modules sit on their own branches; opening a PR from
// whatever they happen to have checked out would ship someone else's work.
{
  const repos = {
    '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1 },
    '/work/ase_lbss@fix-CSUP-7514/modules/administrator': { name: 'alepolab/administrator', branch: 'develop', commitsAhead: 40 },
  }
  const log = []
  const result = await runPrStep(run, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  assert.equal(result.prs.length, 1, 'only the repo on the run branch gets a PR')
  assert.equal(result.prs[0].repo, 'alepolab/ase_lbss')
  assert.ok(
    !log.some(l => l.includes('administrator') && l.includes('push')),
    'a repo on another branch must never be pushed',
  )
}

// ── 3. no commits means no pull request, and it says so ────────────────────
// An empty PR is worse than none: it reads as work that happened.
{
  const repos = {
    '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 0 },
  }
  const log = []
  const result = await runPrStep(run, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  assert.deepEqual(result.prs, [], 'a repo with no commits gets no PR')
  assert.match(result.lines.join('\n'), /no commits/i, 'and the step says why')
  assert.ok(!log.some(l => l.includes('pr create')), 'gh must not be called for an empty branch')
}

// ── 4. a failed push or a failed gh reports the failure, not a URL ─────────
// The placeholder is how a budget-halted run once told a customer's ticket a
// pull request was ready at https://example.invalid/pending.
{
  const repos = {
    '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1, pushFails: true },
    '/work/ase_lbss@fix-CSUP-7514/modules/sasktel-customizations': { name: 'alepolab/sasktel-customizations', branch: RUN_BRANCH, commitsAhead: 1, prFails: true },
  }
  const result = await runPrStep(run, { exec: fakeExec(repos), repoDirs: Object.keys(repos) })
  assert.deepEqual(result.prs, [], 'a failure records no URL at all')
  const out = result.lines.join('\n')
  assert.match(out, /protected branch/, 'the push failure is quoted, not swallowed')
  assert.match(out, /already exists/, 'the gh failure is quoted too')
  assert.ok(!out.includes(PLACEHOLDER_PR), 'never the placeholder URL')
  // One repo failing must not stop the other being attempted.
  assert.match(out, /ase_lbss/)
  assert.match(out, /sasktel-customizations/)
}

// ---- the PR body names the regression area -----------------------------------
// A reviewer opening the PR should not have to diff it to learn what else the
// change could have broken. Runner-owned facts only: the repositories the
// product declares, the blast radius, the commit count.
{
  const repos = { '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 2 } }
  const log = []
  const withProduct = {
    ...run,
    blastRadius: 'schema',
    product: {
      name: 'crm', repos: ['alepolab/ase_lbss', 'alepolab/administrator_lbss'],
      modules: { 'modules/administrator': 'alepolab/administrator_lbss' },
      branches: {}, stack: { compose: 'x', topology_default: 'y' }, tests: {},
    },
  }
  await runPrStep(withProduct, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  const create = log.find(l => l.includes('pr create'))
  assert.match(create, /Regression area/i, 'the body names a regression area')
  assert.match(create, /administrator_lbss/, 'including a repo of the product the run matched')
  assert.match(create, /schema/, 'and the blast radius it was classified as')
}

// ---- an unclassified run says so in the body too -----------------------------
{
  const repos = { '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1 } }
  const log = []
  await runPrStep(run, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  const create = log.find(l => l.includes('pr create'))
  assert.match(create, /not classified|unclassified/i,
    'an absent blast radius is stated, never left to read as a small one')
}

// ── 5. the PR targets the run's base branch, never a guessed default ───────
{
  const repos = { '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1 } }
  const log = []
  await runPrStep(run, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  const create = log.find(l => l.includes('pr create'))
  assert.ok(create, 'gh pr create ran')
  assert.match(create, /--base develop/, 'the base is the run\'s recorded baseBranch')
  assert.match(create, new RegExp(`--head ${RUN_BRANCH}`), 'and the head is the run branch')
  assert.ok(!/--base main/.test(create), 'never origin/HEAD as a fallback')
}

// ── 6. a run with no branch or no base cannot open anything ────────────────
// Rather than inventing one, which is how a run opens a PR against the wrong
// base and someone merges it.
{
  const repos = { '/work/ase_lbss@fix-CSUP-7514': { name: 'alepolab/ase_lbss', branch: RUN_BRANCH, commitsAhead: 1 } }
  for (const missing of [{ branch: undefined }, { baseBranch: undefined }]) {
    const result = await runPrStep({ ...run, ...missing }, { exec: fakeExec(repos), repoDirs: Object.keys(repos) })
    assert.deepEqual(result.prs, [], `no PR without ${Object.keys(missing)[0]}`)
    assert.match(result.lines.join('\n'), /branch/i, 'and it says what was missing')
  }
}

// ---- the URL reaches meta.json, which is the only place the UI looks -------
// it through `readReportedPrUrls`. Opening a pull request and not recording it
// leaves both saying there is none, which is the state run 3ebe1e6e was in.
{
  const { recordPrUrls, runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
  const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join: j } = await import('node:path')

  const runId = 'meta-record-run'
  const dir = runArtifactsDir(runId)
  mkdirSync(dir, { recursive: true })
  // A run whose fix facts saw only the parent repository - the multi-repo case.
  writeFileSync(j(dir, 'meta.json'), JSON.stringify({
    identity: 'test', workflow: 'CSUP',
    fix: { repos: [{ repo: 'alepolab/ase_lbss', commits: ['1df2cdf'] }], files_changed: 1 },
  }, null, 2))

  await recordPrUrls(runId, [
    { repo: 'alepolab/ase_lbss', url: 'https://github.com/alepolab/ase_lbss/pull/158' },
    { repo: 'alepolab/sasktel-customizations', url: 'https://github.com/alepolab/sasktel-customizations/pull/205' },
    { repo: 'alepolab/never', url: PLACEHOLDER_PR },
  ])

  const meta = JSON.parse(readFileSync(j(dir, 'meta.json'), 'utf8'))
  const repos = meta.fix.repos
  const row = (name) => repos.find(r => r.repo === name)
  assert.equal(row('alepolab/ase_lbss').pr, 'https://github.com/alepolab/ase_lbss/pull/158', 'the known repo gets its pr')
  assert.deepEqual(row('alepolab/ase_lbss').commits, ['1df2cdf'], 'and keeps the facts already recorded')
  // Asserted in two steps so removing the append fails by NAME rather than by
  // a TypeError on an absent row.
  assert.ok(row('alepolab/sasktel-customizations'),
    'a repo the fix facts never saw must be APPENDED, or the multi-repo pull request is invisible')
  assert.equal(row('alepolab/sasktel-customizations').pr, 'https://github.com/alepolab/sasktel-customizations/pull/205')
  assert.equal(row('alepolab/never'), undefined, 'the placeholder is never recorded as a pull request')
  assert.equal(meta.identity, 'test', 'the rest of meta.json survives')
  assert.equal(meta.fix.files_changed, 1, 'and so do the other fix facts')

  // Idempotent: a restart re-running the ship step must not duplicate rows.
  await recordPrUrls(runId, [{ repo: 'alepolab/ase_lbss', url: 'https://github.com/alepolab/ase_lbss/pull/158' }])
  const again = JSON.parse(readFileSync(j(dir, 'meta.json'), 'utf8'))
  assert.equal(again.fix.repos.filter(r => r.repo === 'alepolab/ase_lbss').length, 1, 'recording twice does not duplicate a repo')
}

rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
// ── a run that worked outside its product's repos is stopped ────────────
// Run a3cb9d37 (CSUP-7526) resolved product `infra` from one word of ticket
// boilerplate, so the run's worktree was cut from the devops repo while the
// lanes did the real work in lum-selfcare-v1. The PR step would have opened a
// pull request against a repository where nothing changed, omitting the fix
// entirely - a PR that reads as the fix while containing none of it. The
// monitor caught it, but only after $35.54 and 72 minutes.
//
// Whoever is about to open a PR has both facts to hand and must compare them.
{
  const { repoMismatch } = await import('../server/utils/prStep.ts')

  const wrong = repoMismatch(['alepolab/alepo-dev-team-infra'], ['alepolab/lum-selfcare-v1'])
  assert.ok(wrong, 'committing outside the product\'s repos is a mismatch')
  assert.match(wrong, /alepo-dev-team-infra/, 'the message names the repo the run was routed to')
  assert.match(wrong, /lum-selfcare-v1/, 'and the repo the work actually landed in')

  // The ordinary case is silent.
  assert.equal(repoMismatch(['alepolab/lum-selfcare-v1'], ['alepolab/lum-selfcare-v1']), null)
  // A multi-repo product: any subset of its own repos is fine.
  assert.equal(repoMismatch(['alepolab/selfcarenow', 'alepolab/lum-selfcare-v1'], ['alepolab/lum-selfcare-v1']), null)
  // Nothing committed anywhere is not a mismatch - it is a run with no work,
  // which the PR step already reports in its own words.
  assert.equal(repoMismatch(['alepolab/lum-selfcare-v1'], []), null)
  // An unregistered product cannot contradict anything.
  assert.equal(repoMismatch([], ['alepolab/lum-selfcare-v1']), null)
}

// ── and runPrStep refuses to open it ────────────────────────────────────
// Not just a function that can tell: the step itself must not push or open a
// PR when the checkout belongs to a repo the product does not own.
{
  const dir = '/work/lum-selfcare-v1@fix-CSUP-7526'
  const repos = { [dir]: { name: 'alepolab/lum-selfcare-v1', branch: 'fix/CSUP-7526-a3cb9d37', commitsAhead: 3, prNumber: 9 } }
  const log = []
  const misrouted = {
    ...run,
    id: 'a3cb9d37-cd6b-4ac4-a39d-b4e8825a1d0a',
    ticketKey: 'CSUP-7526',
    branch: 'fix/CSUP-7526-a3cb9d37',
    projectDir: dir,
    // What the boilerplate routing produced.
    product: { name: 'infra', repos: ['alepolab/alepo-dev-team-infra'], branches: {}, tests: {} },
  }

  const out = await runPrStep(misrouted, { exec: fakeExec(repos, log), repoDirs: Object.keys(repos) })
  const said = out.lines.join('\n')
  assert.match(said, /alepo-dev-team-infra/, `the refusal names the repo the run was routed to: ${said}`)
  assert.match(said, /lum-selfcare-v1/, 'and the repo the work is actually in')
  assert.deepEqual(out.prs, [], 'no pull request is reported')
  assert.ok(!log.some(l => /gh pr create/.test(l)), `and none is opened; git/gh calls were ${JSON.stringify(log)}`)
  assert.ok(!log.some(l => / push/.test(l)), 'nothing is pushed either: the branch belongs to a repo this run should not be touching')
}

console.log('pr step: the runner opens the pull request, names every repo, records it in meta, and never reports one it did not open')
