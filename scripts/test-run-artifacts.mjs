/**
 * Self-check for the run artifacts directory. Everything here is filesystem
 * behaviour under a temp AGENT_RUNS_DIR — no agent calls.
 *
 *   node scripts/test-run-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'artifacts-'))
// A CLAUDE_DIR of our own, isolated from whatever plugins are actually
// installed on this machine — plugin_version tests below need to control
// exactly what's "installed" (nothing, one version, several versions), and
// must not depend on, or perturb, the real ~/.claude/plugins.
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'artifacts-claudedir-'))
const A = await import('../server/utils/runArtifacts.ts')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real git repo, on a feature branch with real commits, so tests can
 *  prove the finalize step's computed fix facts against a real projectDir
 *  rather than a stub. Returns the repo dir AND the baseline sha a run
 *  starting right before the fix commit would have captured — the caller
 *  attaches that to `run.baseCommit`, exactly as workflowRunner.ts's
 *  startRun does via gitFacts.ts's captureBaseline. */
function makeProjectRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-project-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'Test'])
  // A developer's global commit.gpgsign must not make the fixture depend on a gpg agent.
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  git(dir, ['remote', 'add', 'origin', 'git@github.com:alepolab/ocs_cpp14.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/SA-1203'])
  const baseCommit = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2-changed\nline3\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'fix it'])
  return { dir, baseCommit }
}

const run = {
  id: 'run-1', workflowSlug: 'runbook-a', status: 'running', watch: 'direct-invocation',
  initialPrompt: 'fix SA-1', startedAt: Date.now(), currentStepIds: [], nextStepIds: [],
  steps: [{ stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake', status: 'pending' }],
}

// 1. init creates the directory and a meta.json holding only runner-owned keys
await A.initRunArtifacts(run, 'Runbook A')
const dir = A.runArtifactsDir(run.id)
assert.ok(existsSync(dir), 'artifacts directory is created')
assert.ok(dir.startsWith(process.env.AGENT_RUNS_DIR),
  'the artifacts directory lives under AGENT_RUNS_DIR, not CLAUDE_DIR')
const seeded = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(seeded.identity, 'runbook-a')
assert.equal(seeded.watch, 'direct-invocation', 'watch is seeded from the run\'s own record')
// No step has run yet, so no step has reported a model — the key must be
// genuinely ABSENT, never a fallback default (the old DEFAULT_MODEL_ALIAS
// behaviour this whole fix removes). A run whose every step later throws
// would otherwise write a fabricated model as if it were fact.
assert.ok(!('model' in seeded), 'model is absent until a step reports one — never a fallback default')
assert.ok(!('plugin_version' in seeded),
  'plugin_version is absent when no plugin is installed under this CLAUDE_DIR — never a placeholder')
assert.equal(seeded.cost.input_tokens, 0,
  'token counts start at 0 — no step has reported real usage yet')
assert.ok(!('ticket' in seeded), 'the runner does not claim agent-owned fields')

// 2. a step artifact records the runner's own account of the step, usage included
const rec = {
  stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Ticket Intake',
  status: 'completed', input: 'IN', output: 'OUT', startedAt: 1000, completedAt: 4000,
  usage: { input_tokens: 120, output_tokens: 45 },
}
await A.writeStepArtifact(run, rec, 0)
const stepFile = join(dir, 'steps', 'step-01-ticket-intake.json')
assert.ok(existsSync(stepFile), `step artifact written at ${stepFile}`)
const step = JSON.parse(readFileSync(stepFile, 'utf8'))
assert.equal(step.output, 'OUT')
assert.equal(step.agentSlug, 'sdlc-ticket-intake')
assert.equal(step.status, 'completed')
assert.deepEqual(step.usage, { input_tokens: 120, output_tokens: 45 }, 'real usage is recorded on the step artifact')

// 2b. a step with no usage records it as null, never a guessed 0-that-looks-real
const recNoUsage = { ...rec, stepId: 's1b', agentSlug: 'sdlc-no-usage', usage: undefined }
await A.writeStepArtifact(run, recNoUsage, 5)
const stepFileNoUsage = JSON.parse(readFileSync(join(dir, 'steps', 'step-06-no-usage.json'), 'utf8'))
assert.equal(stepFileNoUsage.usage, null, 'a step record with no usage attached serialises usage as null')

// 3. an agent's merged keys survive finalize; the runner's keys win over them
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
  ticket: 'SA-1203', product: 'ocs_cpp14',
  identity: 'i-promoted-myself',
  watch: 'sa-bugs', // an agent claiming a watch dispatched this run at all
  model: 'agent-picked-a-fancy-model',
  plugin_version: 'agent-invented-9.9.9',
  cost: { input_tokens: 999999, output_tokens: 999999, attempts: 1, wall_clock_min: 0 },
}))
run.endedAt = run.startedAt + 120000
await A.finalizeRunArtifacts(run)
const final = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(final.ticket, 'SA-1203', 'agent-owned keys survive')
assert.equal(final.identity, 'runbook-a', 'runner-owned keys are re-asserted over the agent')
assert.equal(final.watch, 'direct-invocation',
  'watch is re-asserted from the run\'s own record — the agent cannot promote itself to watcher-dispatched')
assert.ok(!('model' in final),
  'model is asserted absent over the agent\'s claim — still no step has actually reported one')
assert.ok(!('plugin_version' in final),
  'plugin_version is asserted absent over the agent\'s invented value — still nothing installed under this CLAUDE_DIR')
assert.equal(final.cost.wall_clock_min, 2, 'wall clock comes from the runner clock')

// 3a-model. once a step DOES report a model, it wins — over both the
// absence above and any poisoned agent self-report.
run.steps[0].model = 'claude-sonnet-4-6'
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
  model: 'agent-still-lying',
}))
await A.finalizeRunArtifacts(run)
const withModel = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(withModel.model, 'claude-sonnet-4-6',
  'model is the real value a step reported, overriding the agent\'s self-report')

// 3b. cost.input_tokens/output_tokens now come from a REAL sum across steps
// with reported usage, not a hardcoded 0. run.steps holds only ONE step
// object (`rec` above, still referenced by `run.steps[0]`) — mutate it in
// place, matching how executeNode records usage onto the same RunStep
// object it already tracks, then finalize again and prove the poisoned
// self-report (999999) loses to the real, computed sum (120), not to a
// re-asserted 0.
run.steps[0].usage = { input_tokens: 120, output_tokens: 45 }
await A.finalizeRunArtifacts(run)
const withUsage = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(withUsage.cost.input_tokens, 120,
  'cost.input_tokens is the real sum of step usage, overriding the agent self-report of 999999')
assert.equal(withUsage.cost.output_tokens, 45, 'cost.output_tokens sums the same way')

// 3c. with usage removed again, the sum honestly reports 0 — and still wins
// over a poisoned self-report, proving 0 is asserted, not merely inherited
// from an untouched seed.
delete run.steps[0].usage
writeFileSync(join(dir, 'meta.json'), JSON.stringify({
  ...JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')),
  cost: { input_tokens: 424242, output_tokens: 424242, attempts: 1, wall_clock_min: 0 },
}))
await A.finalizeRunArtifacts(run)
const zeroAgain = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(zeroAgain.cost.input_tokens, 0,
  'with no step reporting usage, the honest sum is 0 — still overriding a poisoned self-report, not merely absent')

// 4. malformed meta.json from an agent must not lose the runner's facts
writeFileSync(join(dir, 'meta.json'), '{ this is not json')
await A.finalizeRunArtifacts(run)
const recovered = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(recovered.identity, 'runbook-a', 'unparseable meta.json is rebuilt from runner facts')

// 5. the header names the directory
const header = A.artifactHeader(dir)
assert.ok(header.includes(dir), 'the header carries the real path')
assert.ok(/^Claude config directory: \/.+$/m.test(header), 'the header names the absolute Claude config directory, so agents without Bash can Read installed_plugins.json')

// 6. a slug with path separators cannot escape the directory
await A.writeStepArtifact(run, { ...rec, agentSlug: '../../etc/passwd' }, 1)
const names = readdirSync(join(dir, 'steps'))
assert.ok(names.every(n => !n.includes('/') && !n.includes('..')),
  'agent slugs are sanitised into the filename, never traversed')

// 7. fix.{repos,files_changed,lines_changed} are computed from git, and win
// over an agent's self-report, in a REAL project directory with real commits.
{
  const { dir: projectDir, baseCommit } = makeProjectRepo()
  const gitRun = {
    id: 'run-git', workflowSlug: 'runbook-a', status: 'running', projectDir, baseCommit,
    initialPrompt: 'fix SA-1', startedAt: Date.now(), endedAt: Date.now() + 1000,
    currentStepIds: [], nextStepIds: [],
    steps: [{ stepId: 's1', agentSlug: 'sdlc-fix-implementer', label: 'Fix', status: 'completed' }],
  }
  const gitDir = A.runArtifactsDir(gitRun.id)
  await A.initRunArtifacts(gitRun, 'Runbook A')
  // The agent self-reports a WRONG commit list and WRONG file/line counts
  // for the SAME repo git will independently name, plus a pr link that only
  // it can know. The pr link (tied to the repo git also names) must survive;
  // the commits/files_changed/lines_changed it claimed must not.
  writeFileSync(join(gitDir, 'meta.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(gitDir, 'meta.json'), 'utf8')),
    fix: {
      repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['0000000'], pr: 'https://example.invalid/pr/9' }],
      files_changed: 1, lines_changed: 1, test_dirs_unlocked: false, unlock_reason: null,
    },
  }))
  await A.finalizeRunArtifacts(gitRun)
  const gitMeta = JSON.parse(readFileSync(join(gitDir, 'meta.json'), 'utf8'))
  assert.equal(gitMeta.fix.repos.length, 1, 'exactly one computed repo entry')
  assert.equal(gitMeta.fix.repos[0].repo, 'alepolab/ocs_cpp14',
    'fix.repos comes from git\'s own remote')
  assert.notDeepEqual(gitMeta.fix.repos[0].commits, ['0000000'],
    'the agent-claimed commit list is replaced by the real one git computed')
  assert.equal(gitMeta.fix.repos[0].pr, 'https://example.invalid/pr/9',
    'a pr link the agent reported for the SAME repo survives — git cannot prove a PR URL')
  assert.equal(gitMeta.fix.test_dirs_unlocked, false, 'other agent-owned fix.* keys are untouched')
  const numstat = execFileSync('git', ['diff', '--numstat', `${baseCommit}..HEAD`], { cwd: projectDir, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  let expectedLines = 0
  for (const line of numstat) {
    const [added, removed] = line.split('\t')
    expectedLines += (Number(added) || 0) + (Number(removed) || 0)
  }
  assert.equal(gitMeta.fix.files_changed, numstat.length,
    'files_changed is recomputed from git, not the agent-claimed 1')
  assert.equal(gitMeta.fix.lines_changed, expectedLines,
    'lines_changed is recomputed from git, not the agent-claimed 1')

  // And when git cannot compute anything at all (no projectDir), the three
  // computed keys are ABSENT — not the agent's self-report papering over it.
  const noProjectRun = {
    id: 'run-no-project', workflowSlug: 'runbook-a', status: 'running',
    initialPrompt: 'fix SA-1', startedAt: Date.now(), endedAt: Date.now() + 1000,
    currentStepIds: [], nextStepIds: [], steps: [],
  }
  const npDir = A.runArtifactsDir(noProjectRun.id)
  await A.initRunArtifacts(noProjectRun, 'Runbook A')
  writeFileSync(join(npDir, 'meta.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(npDir, 'meta.json'), 'utf8')),
    fix: { repos: [{ repo: 'agent-lied/again', commits: ['1111111'], pr: 'https://example.invalid/pr/1' }],
      files_changed: 5, lines_changed: 50, test_dirs_unlocked: false, unlock_reason: null },
  }))
  await A.finalizeRunArtifacts(noProjectRun)
  const npMeta = JSON.parse(readFileSync(join(npDir, 'meta.json'), 'utf8'))
  // The repo name and PR link are kept: git could never prove a PR URL even
  // with a project directory, and dropping it left the CI poller blind. The
  // commit list and counts, which git would have replaced, are dropped.
  assert.deepEqual(npMeta.fix.repos, [{ repo: 'agent-lied/again', pr: 'https://example.invalid/pr/1' }],
    'fix.repos keeps repo and pr only when git facts cannot be computed')
  assert.ok(!('files_changed' in npMeta.fix), 'fix.files_changed is absent, not the agent claim')
  assert.ok(!('lines_changed' in npMeta.fix), 'fix.lines_changed is absent, not the agent claim')
  assert.equal(npMeta.fix.test_dirs_unlocked, false, 'unrelated agent-owned fix.* keys still survive')

  rmSync(projectDir, { recursive: true, force: true })
}

// 8. a multi-repo fix: computeFixFacts can only prove the ONE repo at
// run.projectDir. The OTHER repo the agent reported must survive as its
// self-report (git never looked at it), the computable one must still be
// git-verified, and merge_order must stay coherent with the result —
// dropped once it no longer names every repo actually present.
{
  const { dir: projectDir, baseCommit } = makeProjectRepo()
  const multiRun = {
    id: 'run-multi', workflowSlug: 'runbook-a', status: 'running', projectDir, baseCommit,
    initialPrompt: 'fix SA-1', startedAt: Date.now(), endedAt: Date.now() + 1000,
    currentStepIds: [], nextStepIds: [],
    steps: [{ stepId: 's1', agentSlug: 'sdlc-fix-implementer', label: 'Fix', status: 'completed' }],
  }
  const multiDir = A.runArtifactsDir(multiRun.id)
  await A.initRunArtifacts(multiRun, 'Runbook A')
  writeFileSync(join(multiDir, 'meta.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(multiDir, 'meta.json'), 'utf8')),
    fix: {
      repos: [
        { repo: 'alepolab/billing_cpp14', commits: ['1111111'], pr: 'https://example.invalid/pr/2' },
        { repo: 'alepolab/ocs_cpp14', commits: ['0000000'], pr: 'https://example.invalid/pr/9' },
      ],
      merge_order: ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
      files_changed: 1, lines_changed: 1, test_dirs_unlocked: false, unlock_reason: null,
    },
  }))
  await A.finalizeRunArtifacts(multiRun)
  const multiMeta = JSON.parse(readFileSync(join(multiDir, 'meta.json'), 'utf8'))
  assert.equal(multiMeta.fix.repos.length, 2, 'both repos survive — none silently dropped')
  const billing = multiMeta.fix.repos.find(r => r.repo === 'alepolab/billing_cpp14')
  const ocs = multiMeta.fix.repos.find(r => r.repo === 'alepolab/ocs_cpp14')
  assert.deepEqual(billing.commits, ['1111111'],
    'a repo git cannot verify from this projectDir survives as the agent\'s self-report')
  assert.notDeepEqual(ocs.commits, ['0000000'],
    'the repo git CAN verify is git-computed, never the agent\'s claim')
  assert.deepEqual(multiMeta.fix.merge_order, ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
    'merge_order survives because both names it lists are still present in fix.repos')

  // Now the agent's merge_order names a repo that isn't (and never was) in
  // its own reported repos — an incoherent claim from the start, not
  // something reconciliation introduced. It must not survive either.
  writeFileSync(join(multiDir, 'meta.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(multiDir, 'meta.json'), 'utf8')),
    fix: {
      repos: [{ repo: 'alepolab/ocs_cpp14', commits: ['0000000'], pr: 'https://example.invalid/pr/9' }],
      merge_order: ['alepolab/billing_cpp14', 'alepolab/ocs_cpp14'],
      files_changed: 1, lines_changed: 1, test_dirs_unlocked: false, unlock_reason: null,
    },
  }))
  await A.finalizeRunArtifacts(multiRun)
  const collapsed = JSON.parse(readFileSync(join(multiDir, 'meta.json'), 'utf8'))
  assert.equal(collapsed.fix.repos.length, 1, 'only the one computable repo is present')
  assert.ok(!('merge_order' in collapsed.fix),
    'merge_order naming a repo absent from fix.repos does not survive — it would make the bundle incoherent')

  rmSync(projectDir, { recursive: true, force: true })
}

// 9. THE regression this whole change exists for (DEVOPS-15): a run against
// a real repo, on a long-lived branch that ALREADY has real commits ahead of
// main before the run even starts — and the run itself creates no commits
// and leaves the tree clean. finalizeRunArtifacts must not attribute the
// branch's pre-existing history to this run.
{
  const projectDir = mkdtempSync(join(tmpdir(), 'artifacts-project-develop-'))
  git(projectDir, ['init', '-q', '-b', 'main'])
  git(projectDir, ['config', 'user.email', 'test@example.invalid'])
  git(projectDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(projectDir, 'a.txt'), 'line1\n')
  git(projectDir, ['add', '.'])
  git(projectDir, ['commit', '-q', '-m', 'initial'])
  git(projectDir, ['remote', 'add', 'origin', 'git@github.com:alepolab/alepo-dev-team-infra.git'])
  git(projectDir, ['checkout', '-q', '-b', 'develop'])
  // Real pre-existing history on develop, well ahead of main — the exact
  // shape gitFacts.ts used to misreport wholesale as "this run's work"
  // when it diffed against main instead of the run's own starting point.
  for (let i = 0; i < 33; i += 1) {
    appendFileSync(join(projectDir, 'a.txt'), `pre-existing line ${i}\n`)
    git(projectDir, ['add', '.'])
    git(projectDir, ['commit', '-q', '-m', `pre-existing develop commit ${i}`])
  }
  const aheadOfMain = execFileSync('git', ['rev-list', 'main..HEAD'], { cwd: projectDir, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
  assert.equal(aheadOfMain.length, 33, 'sanity: develop really is 33 commits ahead of main before the run starts')

  // The run starts NOW — its baseline is the branch tip at this instant,
  // exactly what workflowRunner.ts's startRun captures via
  // gitFacts.ts's captureBaseline before any step runs.
  const baseCommit = git(projectDir, ['rev-parse', 'HEAD'])

  // 9a. The run halts at step 1: no commits made, tree clean. An agent
  // nonetheless self-reports a fabricated fix — the exact shape observed on
  // the real DEVOPS-15 run (33 commits, 17 files, 1083 lines).
  {
    const haltedRun = {
      id: 'run-devops-15-halt', workflowSlug: 'runbook-a', status: 'failed', projectDir, baseCommit,
      initialPrompt: 'fix DEVOPS-15', startedAt: Date.now(), endedAt: Date.now() + 1000,
      currentStepIds: [], nextStepIds: [],
      steps: [{ stepId: 's1', agentSlug: 'sdlc-ticket-intake', label: 'Intake', status: 'failed' }],
    }
    const haltedDir = A.runArtifactsDir(haltedRun.id)
    await A.initRunArtifacts(haltedRun, 'Runbook A')
    writeFileSync(join(haltedDir, 'meta.json'), JSON.stringify({
      ...JSON.parse(readFileSync(join(haltedDir, 'meta.json'), 'utf8')),
      fix: {
        repos: [{ repo: 'alepolab/alepo-dev-team-infra', commits: aheadOfMain, pr: null }],
        files_changed: 17, lines_changed: 1083, test_dirs_unlocked: false, unlock_reason: null,
      },
    }))
    await A.finalizeRunArtifacts(haltedRun)
    const haltedMeta = JSON.parse(readFileSync(join(haltedDir, 'meta.json'), 'utf8'))
    assert.ok(!('repos' in haltedMeta.fix),
      'fix.repos is absent for a run that made no commits, even though the branch is 33 commits ahead of main')
    assert.ok(!('files_changed' in haltedMeta.fix), 'files_changed is absent, not the agent-fabricated 17')
    assert.ok(!('lines_changed' in haltedMeta.fix), 'lines_changed is absent, not the agent-fabricated 1083')
  }

  // 9b. Same repo, same branch, but this run genuinely makes ONE commit.
  // Only that commit is attributable — never the 33 pre-existing ones.
  {
    writeFileSync(join(projectDir, 'b.txt'), 'the one real change this run made\n')
    git(projectDir, ['add', '.'])
    git(projectDir, ['commit', '-q', '-m', 'the only commit this run actually made'])

    const realRun = {
      id: 'run-devops-15-real', workflowSlug: 'runbook-a', status: 'completed', projectDir, baseCommit,
      initialPrompt: 'fix DEVOPS-15', startedAt: Date.now(), endedAt: Date.now() + 1000,
      currentStepIds: [], nextStepIds: [],
      steps: [{ stepId: 's1', agentSlug: 'sdlc-fix-implementer', label: 'Fix', status: 'completed' }],
    }
    const realDir = A.runArtifactsDir(realRun.id)
    await A.initRunArtifacts(realRun, 'Runbook A')
    await A.finalizeRunArtifacts(realRun)
    const realMeta = JSON.parse(readFileSync(join(realDir, 'meta.json'), 'utf8'))
    assert.equal(realMeta.fix.repos.length, 1)
    assert.equal(realMeta.fix.repos[0].commits.length, 1,
      'exactly the one commit this run made is attributed — not the 33 pre-existing ones')
    assert.equal(realMeta.fix.files_changed, 1, 'only the file this run touched is counted')
  }

  rmSync(projectDir, { recursive: true, force: true })
}

// 9c. An OLDER run — no baseCommit recorded at all (the field didn't exist
// yet, or projectDir wasn't a git repo when the run started) — must emit
// nothing either, never fall back to main. Reusing the exact develop-style
// repo shape (many commits ahead of main) so a fallback-to-main regression
// would be caught here too.
{
  const projectDir = mkdtempSync(join(tmpdir(), 'artifacts-project-nobaseline-'))
  git(projectDir, ['init', '-q', '-b', 'main'])
  git(projectDir, ['config', 'user.email', 'test@example.invalid'])
  git(projectDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(projectDir, 'a.txt'), 'line1\n')
  git(projectDir, ['add', '.'])
  git(projectDir, ['commit', '-q', '-m', 'initial'])
  git(projectDir, ['remote', 'add', 'origin', 'git@github.com:alepolab/alepo-dev-team-infra.git'])
  git(projectDir, ['checkout', '-q', '-b', 'develop'])
  appendFileSync(join(projectDir, 'a.txt'), 'a commit ahead of main, but no baseline was ever recorded\n')
  git(projectDir, ['add', '.'])
  git(projectDir, ['commit', '-q', '-m', 'ahead of main, no baseline'])

  const noBaselineRun = {
    id: 'run-no-baseline', workflowSlug: 'runbook-a', status: 'completed', projectDir,
    // baseCommit deliberately omitted
    initialPrompt: 'fix DEVOPS-15', startedAt: Date.now(), endedAt: Date.now() + 1000,
    currentStepIds: [], nextStepIds: [],
    steps: [{ stepId: 's1', agentSlug: 'sdlc-fix-implementer', label: 'Fix', status: 'completed' }],
  }
  const noBaselineDir = A.runArtifactsDir(noBaselineRun.id)
  await A.initRunArtifacts(noBaselineRun, 'Runbook A')
  writeFileSync(join(noBaselineDir, 'meta.json'), JSON.stringify({
    ...JSON.parse(readFileSync(join(noBaselineDir, 'meta.json'), 'utf8')),
    fix: {
      repos: [{ repo: 'alepolab/alepo-dev-team-infra', commits: ['1111111'], pr: null }],
      files_changed: 3, lines_changed: 9, test_dirs_unlocked: false, unlock_reason: null,
    },
  }))
  await A.finalizeRunArtifacts(noBaselineRun)
  const noBaselineMeta = JSON.parse(readFileSync(join(noBaselineDir, 'meta.json'), 'utf8'))
  assert.ok(!('repos' in noBaselineMeta.fix),
    'with no baseCommit recorded at all, fix.repos is absent — never a fallback to main')
  assert.ok(!('files_changed' in noBaselineMeta.fix), 'files_changed is absent with no baseline recorded')
  assert.ok(!('lines_changed' in noBaselineMeta.fix), 'lines_changed is absent with no baseline recorded')

  rmSync(projectDir, { recursive: true, force: true })
}

// 10. when finalize itself cannot be trusted (a bug, a filesystem error), the
// caller (workflowRunner.ts) marks the artifacts unusable rather than
// leaving an agent's unreconciled self-report sitting in meta.json looking
// like ordinary evidence. markArtifactsUnusable is the mechanism: it must
// remove meta.json so the assembler sees an absent run, not a good one.
{
  const unusableRun = {
    id: 'run-unusable', workflowSlug: 'runbook-a', status: 'running', watch: 'direct-invocation',
    initialPrompt: 'fix SA-1', startedAt: Date.now(), currentStepIds: [], nextStepIds: [], steps: [],
  }
  const unusableDir = A.runArtifactsDir(unusableRun.id)
  await A.initRunArtifacts(unusableRun, 'Runbook A')
  assert.ok(existsSync(join(unusableDir, 'meta.json')), 'meta.json exists before marking unusable')
  await A.markArtifactsUnusable(unusableRun.id)
  assert.ok(!existsSync(join(unusableDir, 'meta.json')),
    'meta.json is removed — the assembler must see an absent run, not fabricated evidence')
}

// 11. plugin_version: a runner-owned fact read from the installed plugin's
// own plugin.json (server/utils/runArtifacts.ts's resolveInstalledPluginVersion),
// never the sdlc-ticket-intake agent's self-report. That agent's own Glob-based
// search can never find this file (its cwd is the target repo, not
// ~/.claude, and `**` doesn't descend into a dot-directory like
// `.claude-plugin` regardless) — see DEVOPS-15's real halt this closes.
{
  // 11a. Nothing installed at all (the state every earlier assertion in this
  // file already ran under): resolveInstalledPluginVersion reports absence,
  // never a placeholder.
  assert.equal(A.resolveInstalledPluginVersion(), undefined,
    'no plugin installed under this CLAUDE_DIR: undefined, not a placeholder')

  // 11b. The exact real installed layout the coordinator measured:
  // plugins/cache/alepo-engineering/alepo-engineering/0.1.0/.claude-plugin/plugin.json —
  // note the dot-directory segment a `**` glob cannot descend into.
  const pluginDir = join(
    process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '0.1.0', '.claude-plugin',
  )
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'alepo-engineering', version: '0.1.0' }))
  assert.equal(A.resolveInstalledPluginVersion(), '0.1.0',
    'the real installed layout, dot-directory included, is found by walking rather than globbing')

  // 11c. Two cached versions: the higher one wins, not whichever the walk
  // happens to visit first.
  const olderDir = join(
    process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '0.0.9', '.claude-plugin',
  )
  mkdirSync(olderDir, { recursive: true })
  writeFileSync(join(olderDir, 'plugin.json'), JSON.stringify({ name: 'alepo-engineering', version: '0.0.9' }))
  assert.equal(A.resolveInstalledPluginVersion(), '0.1.0',
    'with two cached versions present, the higher version wins')

  // 11d. finalizeRunArtifacts asserts plugin_version over an agent's
  // self-report, exactly like identity/watch/model/cost already do.
  const pluginRun = {
    id: 'run-plugin-version', workflowSlug: 'runbook-a', status: 'running', watch: 'direct-invocation',
    initialPrompt: 'fix SA-1', startedAt: Date.now(), endedAt: Date.now() + 1000,
    currentStepIds: [], nextStepIds: [], steps: [],
  }
  const pluginRunDir = A.runArtifactsDir(pluginRun.id)
  await A.initRunArtifacts(pluginRun, 'Runbook A')
  const seededPlugin = JSON.parse(readFileSync(join(pluginRunDir, 'meta.json'), 'utf8'))
  assert.equal(seededPlugin.plugin_version, '0.1.0', 'init seeds plugin_version from the real installed plugin')
  writeFileSync(join(pluginRunDir, 'meta.json'), JSON.stringify({
    ...seededPlugin, plugin_version: 'unknown',
  }))
  await A.finalizeRunArtifacts(pluginRun)
  const finalPlugin = JSON.parse(readFileSync(join(pluginRunDir, 'meta.json'), 'utf8'))
  assert.equal(finalPlugin.plugin_version, '0.1.0',
    'finalize re-asserts the real installed version over the agent\'s placeholder self-report')
}

// ── publishEvidenceToProject: the run directory travels with the PR ───────
//
// This is what makes .github/workflows/evidence-bundle.yml able to pass at
// all. A GitHub Actions artifact can only be created inside a workflow run,
// and this pipeline runs on an engineer's machine, so nothing could ever
// upload `evidence-run-<sha>` and the check could only fail with "no artifact
// found". Committing the directory is the path that works.
// Evidence must NOT reach a repository. It used to be copied to
// `<projectDir>/.agent/evidence-run/` so it could travel with the pull request,
// which put a run's logs, step outputs and oracle XML into someone else's
// product repo as commits a reviewer has to read past to reach the diff.
//
// The app serves the run directory instead, so the evidence is reachable
// without being committed anywhere. What follows asserts the writer is gone and
// the artifacts stay where the app can serve them.
{
  const runId = 'evidence-stays-put'
  const src = A.runArtifactsDir(runId)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'meta.json'), JSON.stringify({ identity: 'x' }))
  mkdirSync(join(src, 'steps'), { recursive: true })
  writeFileSync(join(src, 'steps', 'step-01.json'), '{}')

  assert.equal(typeof A.publishEvidenceToProject, 'undefined',
    'the writer that copied evidence into a project tree must not exist at all')

  // The artifacts remain where the app reads them from.
  assert.ok(existsSync(join(src, 'meta.json')), 'the bundle stays in the run directory')
  assert.ok(existsSync(join(src, 'steps', 'step-01.json')), 'nested step artifacts stay too')

  // And an agent is told where that is, so it links rather than copies.
  const header = A.artifactHeader(src, undefined, undefined, runId)
  assert.ok(header.includes(`/api/runs/${runId}/artifacts`),
    'the artifact header must name the URL the app serves this run at')
  assert.ok(/never copy artifacts into the repository/i.test(header),
    'the header must say plainly that artifacts are not copied into a repo')
}

rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('run artifacts: all checks passed')
