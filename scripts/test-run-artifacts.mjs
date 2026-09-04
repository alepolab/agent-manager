/**
 * Self-check for the run artifacts directory. Everything here is filesystem
 * behaviour under a temp AGENT_RUNS_DIR — no agent calls.
 *
 *   node scripts/test-run-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'artifacts-'))
const A = await import('../server/utils/runArtifacts.ts')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real git repo, on a feature branch with real commits, so tests can
 *  prove the finalize step's computed fix facts against a real projectDir
 *  rather than a stub. */
function makeProjectRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-project-'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.invalid'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  git(dir, ['remote', 'add', 'origin', 'git@github.com:alepolab/ocs_cpp14.git'])
  git(dir, ['checkout', '-q', '-b', 'feature/SA-1203'])
  writeFileSync(join(dir, 'a.txt'), 'line1\nline2-changed\nline3\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'fix it'])
  return dir
}

const run = {
  id: 'run-1', workflowSlug: 'runbook-a', status: 'running',
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
assert.ok('model' in seeded, 'model is seeded')
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
  cost: { input_tokens: 999999, output_tokens: 999999, attempts: 1, wall_clock_min: 0 },
}))
run.endedAt = run.startedAt + 120000
await A.finalizeRunArtifacts(run)
const final = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
assert.equal(final.ticket, 'SA-1203', 'agent-owned keys survive')
assert.equal(final.identity, 'runbook-a', 'runner-owned keys are re-asserted over the agent')
assert.equal(final.cost.wall_clock_min, 2, 'wall clock comes from the runner clock')

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

// 6. a slug with path separators cannot escape the directory
await A.writeStepArtifact(run, { ...rec, agentSlug: '../../etc/passwd' }, 1)
const names = readdirSync(join(dir, 'steps'))
assert.ok(names.every(n => !n.includes('/') && !n.includes('..')),
  'agent slugs are sanitised into the filename, never traversed')

// 7. fix.{repos,files_changed,lines_changed} are computed from git, and win
// over an agent's self-report, in a REAL project directory with real commits.
{
  const projectDir = makeProjectRepo()
  const gitRun = {
    id: 'run-git', workflowSlug: 'runbook-a', status: 'running', projectDir,
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
  const numstat = execFileSync('git', ['diff', '--numstat', 'main..HEAD'], { cwd: projectDir, encoding: 'utf8' })
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
  assert.ok(!('repos' in npMeta.fix), 'fix.repos is absent when git facts cannot be computed, not the agent claim')
  assert.ok(!('files_changed' in npMeta.fix), 'fix.files_changed is absent, not the agent claim')
  assert.ok(!('lines_changed' in npMeta.fix), 'fix.lines_changed is absent, not the agent claim')
  assert.equal(npMeta.fix.test_dirs_unlocked, false, 'unrelated agent-owned fix.* keys still survive')

  rmSync(projectDir, { recursive: true, force: true })
}

rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('run artifacts: all checks passed')
