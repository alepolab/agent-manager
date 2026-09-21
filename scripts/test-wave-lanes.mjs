/**
 * Self-check for the per-wave lane worktrees.
 *
 *   node scripts/test-wave-lanes.mjs
 *
 * Two agents in one parallel wave used to work in the run's single worktree.
 * That is safe while they read and a race the moment they write: git takes one
 * index lock, so the second `git commit` fails outright and that agent's work
 * is simply lost. The first assertion here is that control case, against real
 * git — without it a passing lane test proves only that lanes work, not that
 * they were needed.
 *
 * The rest proves the lane contract: a worktree per concurrent step, on its own
 * branch, both committing at once, both merged back into the run branch, and
 * nothing left registered afterwards.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const git = (cwd, args) => execFileP('git', args, { cwd }).then(r => r.stdout.trim())

// Set before the runner is imported, the way test-workflow-runner.mjs does it.
process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'lanes-claude-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'lanes-artifacts-'))

const { ensureLane, mergeLane, removeLane, laneBranchFor, laneDirFor } = await import('../server/utils/workspace.ts')

const root = mkdtempSync(join(tmpdir(), 'wave-lanes-'))
try {
  // A clone with one commit, and the run's own worktree beside it — the shape
  // ensureRunBranch leaves behind.
  const clone = join(root, 'repo')
  await execFileP('git', ['init', '-q', clone])
  await git(clone, ['config', 'user.email', 'test@example.com'])
  await git(clone, ['config', 'user.name', 'Test'])
  writeFileSync(join(clone, 'README.md'), 'base\n')
  await git(clone, ['add', '-A'])
  await git(clone, ['commit', '-qm', 'base'])

  const runBranch = 'fix/CSUP-1'
  const runWt = `${clone}@fix-CSUP-1`
  await git(clone, ['worktree', 'add', '--quiet', '-B', runBranch, runWt, 'HEAD'])

  const commitIn = async (dir, name) => {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-qm', `from ${name}`])
  }

  // The control: concurrent commits in ONE worktree. One of them fails, which
  // is the defect lanes exist to remove.
  let shared = null
  await Promise.all([commitIn(runWt, 'alpha'), commitIn(runWt, 'beta')]).catch((err) => { shared = err })
  assert.ok(shared, 'two concurrent commits in one worktree must fail; if this ever passes, lanes are no longer load-bearing')
  // Back to the base commit, so the lane run below starts clean.
  await git(runWt, ['reset', '-q', '--hard', 'HEAD~1'])
  await git(runWt, ['clean', '-qfd'])

  // Lane names are derived from the run branch and the step label, so two
  // steps of one wave can never collide and a person can read which is which.
  const backBranch = laneBranchFor(runBranch, 'Implement Backend')
  const frontBranch = laneBranchFor(runBranch, 'Implement Frontend')
  assert.equal(backBranch, 'fix/CSUP-1--lane-implement-backend')
  assert.notEqual(backBranch, frontBranch)
  assert.notEqual(laneDirFor(runWt, backBranch), laneDirFor(runWt, frontBranch), 'each lane needs its own directory')

  const backDir = await ensureLane(runWt, backBranch)
  const frontDir = await ensureLane(runWt, frontBranch)
  assert.ok(existsSync(join(backDir, '.git')), 'the backend lane is a real worktree')
  assert.ok(existsSync(join(frontDir, '.git')), 'the frontend lane is a real worktree')
  assert.equal(await git(backDir, ['branch', '--show-current']), backBranch, 'a lane sits on its own branch')

  // Cutting the same lane twice is a restart into the middle of a wave, not an error.
  assert.equal(await ensureLane(runWt, backBranch), backDir, 'an existing lane on the right branch is reused')

  for (const dir of [backDir, frontDir]) {
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
  }

  // The whole point: both write and commit at once, and neither fails.
  await Promise.all([commitIn(backDir, 'backend'), commitIn(frontDir, 'frontend')])

  assert.match(await mergeLane(runWt, backBranch), /merged 1 commit/, 'the backend lane merges into the run branch')
  assert.match(await mergeLane(runWt, frontBranch), /merged 1 commit/, 'the frontend lane merges into the run branch')
  assert.ok(existsSync(join(runWt, 'backend.txt')), "the backend lane's work is on the run branch")
  assert.ok(existsSync(join(runWt, 'frontend.txt')), "the frontend lane's work is on the run branch")

  // A lane with nothing on it is not an error: a review step commits nothing.
  const idleBranch = laneBranchFor(runBranch, 'Data & Migration Review')
  await ensureLane(runWt, idleBranch)
  assert.match(await mergeLane(runWt, idleBranch), /no commits to merge/, 'an idle lane merges to nothing')

  for (const b of [backBranch, frontBranch, idleBranch]) await removeLane(runWt, b)
  assert.ok(!existsSync(join(backDir, '.git')), 'a merged lane is removed')
  assert.equal(await git(runWt, ['branch', '--list', backBranch]), '', 'a merged lane branch is deleted')
  // The clone and the run worktree, and nothing else still registered.
  assert.equal((await git(runWt, ['worktree', 'list'])).split('\n').length, 2, 'no lane is left registered')

  // A conflicting lane is reported, never resolved silently: losing one agent's
  // work while reporting success is worse than failing the wave.
  const clashBranch = laneBranchFor(runBranch, 'Clash')
  const clashDir = await ensureLane(runWt, clashBranch)
  await git(clashDir, ['config', 'user.email', 'test@example.com'])
  await git(clashDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(clashDir, 'README.md'), 'lane version\n')
  await git(clashDir, ['add', '-A'])
  await git(clashDir, ['commit', '-qm', 'lane edit'])
  writeFileSync(join(runWt, 'README.md'), 'run version\n')
  await git(runWt, ['add', '-A'])
  await git(runWt, ['commit', '-qm', 'run edit'])
  await assert.rejects(() => mergeLane(runWt, clashBranch), /conflicts with the run branch and was left unmerged/)
  // The failed merge is not left half-applied, so the next step reads a clean tree.
  assert.equal(await git(runWt, ['status', '--porcelain']), '', 'an aborted merge leaves no conflict markers staged')

  // ── The runner end: a real parallel wave in a real checkout ───────────────
  //
  // The helpers above can be right while nothing calls them. This drives an
  // actual run whose second wave has two steps, and asserts from the OUTSIDE
  // that each step's agent was given its own directory and that both steps'
  // commits arrived on the run branch.
  const runner = await import('../server/utils/workflowRunner.ts')
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

  const project = join(root, 'project')
  await execFileP('git', ['init', '-q', project])
  await git(project, ['config', 'user.email', 'test@example.com'])
  await git(project, ['config', 'user.name', 'Test'])
  writeFileSync(join(project, 'app.txt'), 'start\n')
  await git(project, ['add', '-A'])
  await git(project, ['commit', '-qm', 'initial'])

  const fanOut = {
    slug: 'lanes', name: 'Lanes',
    steps: [
      { id: 'plan', agentSlug: 'planner', label: 'Plan', next: ['back', 'front'] },
      { id: 'back', agentSlug: 'backend', label: 'Implement Backend', next: ['verify'] },
      { id: 'front', agentSlug: 'frontend', label: 'Implement Frontend', next: ['verify'] },
      { id: 'verify', agentSlug: 'verifier', label: 'Verify', next: [] },
    ],
  }

  // Every step records the directory it was handed; the two writers also commit
  // there, concurrently, which is what used to fail.
  const seen = {}
  runner.setAgentCaller(async (agentSlug, _input, cwd) => {
    seen[agentSlug] = cwd
    if (agentSlug === 'backend' || agentSlug === 'frontend') {
      const file = `${agentSlug}.txt`
      writeFileSync(join(cwd, file), `${agentSlug}\n`)
      await git(cwd, ['config', 'user.email', 'test@example.com'])
      await git(cwd, ['config', 'user.name', 'Test'])
      await git(cwd, ['add', '-A'])
      await git(cwd, ['commit', '-qm', `work by ${agentSlug}`])
    }
    return `OUTPUT-OF-${agentSlug}`
  })

  const settled = await runner.waitForSettled(
    (await runner.startRun({
      workflow: fanOut, initialPrompt: 'CSUP-1 fix it', watch: 'direct-invocation',
      autoRun: true, projectDir: project,
    })).id, 60000)

  assert.equal(settled.status, 'completed', `the run completed (was ${settled.status}: ${settled.error ?? 'no error'})`)
  assert.ok(settled.projectDir, 'the run has a worktree')

  // The two concurrent steps each got their own directory, and neither got the
  // run worktree the sequential steps used.
  assert.ok(seen.backend && seen.front !== undefined || seen.frontend, 'both writers ran')
  assert.notEqual(seen.backend, seen.frontend, 'concurrent steps must not share a directory')
  assert.notEqual(seen.backend, settled.projectDir, 'a concurrent step works in its lane, not the run worktree')
  assert.notEqual(seen.frontend, settled.projectDir, 'a concurrent step works in its lane, not the run worktree')
  // A step that had the wave to itself is unchanged: the run's own worktree.
  assert.equal(seen.planner, settled.projectDir, 'a single-step wave still works in the run worktree')
  assert.equal(seen.verifier, settled.projectDir, 'the join step works in the run worktree, after the lanes merged')

  // Both lanes' commits are on the run branch, so the next step - and the pull
  // request - sees all of the wave's work.
  assert.ok(existsSync(join(settled.projectDir, 'backend.txt')), "the backend lane's commit merged into the run branch")
  assert.ok(existsSync(join(settled.projectDir, 'frontend.txt')), "the frontend lane's commit merged into the run branch")
  // And the record says where each step worked, for the run page.
  const backRec = settled.steps.find(s => s.stepId === 'back')
  assert.equal(backRec.worktree, seen.backend, 'the step record names the lane its agent worked in')
  assert.equal(settled.steps.find(s => s.stepId === 'plan').worktree, undefined, 'a single-step wave records no lane')
  // Nothing is left registered once the run is done.
  assert.equal((await git(settled.projectDir, ['worktree', 'list'])).split('\n').length, 2, 'no lane outlives its wave')

  // ── A retried step, whose lane merged and was removed with its wave ─────
  //
  // A RETRY verdict re-arms the node AFTER its wave has settled, so by the time
  // the step runs again its lane is merged and gone and the next wave holds only
  // it. The second visit therefore works in the run worktree - which already
  // carries the first attempt's commits - and that is the behaviour to pin: the
  // work must survive the lane it was made in.
  {
    const retryFan = {
      slug: 'lanes-retry', name: 'Lanes Retry',
      steps: [
        { id: 'r-plan', agentSlug: 'r-planner', label: 'Plan', next: ['r-back', 'r-front'] },
        { id: 'r-back', agentSlug: 'r-backend', label: 'Implement Backend', next: ['r-done'], monitorSlug: 'r-monitor', maxVisits: 3 },
        { id: 'r-front', agentSlug: 'r-frontend', label: 'Implement Frontend', next: ['r-done'] },
        { id: 'r-done', agentSlug: 'r-verifier', label: 'Verify', next: [] },
      ],
    }
    const project2 = join(root, 'project2')
    await execFileP('git', ['init', '-q', project2])
    await git(project2, ['config', 'user.email', 'test@example.com'])
    await git(project2, ['config', 'user.name', 'Test'])
    writeFileSync(join(project2, 'app.txt'), 'start\n')
    await git(project2, ['add', '-A'])
    await git(project2, ['commit', '-qm', 'initial'])

    const visits = []
    let monitorCalls = 0
    runner.setAgentCaller(async (agentSlug, _input, dir) => {
      if (agentSlug === 'r-monitor') {
        monitorCalls += 1
        return monitorCalls === 1 ? 'Not yet.\nVERDICT: RETRY' : 'Good.\nVERDICT: CONTINUE'
      }
      if (agentSlug === 'r-backend') {
        visits.push(dir)
        const file = `backend-visit-${visits.length}.txt`
        writeFileSync(join(dir, file), 'work\n')
        await git(dir, ['config', 'user.email', 'test@example.com'])
        await git(dir, ['config', 'user.name', 'Test'])
        await git(dir, ['add', '-A'])
        await git(dir, ['commit', '-qm', file])
      }
      return `OUTPUT-OF-${agentSlug}`
    })

    const done = await runner.waitForSettled(
      (await runner.startRun({
        workflow: retryFan, initialPrompt: 'CSUP-2 retry me', watch: 'direct-invocation',
        autoRun: true, projectDir: project2,
      })).id, 60000)

    assert.equal(done.status, 'completed', `the retried run completed (was ${done.status}: ${done.error ?? 'no error'})`)
    assert.equal(visits.length, 2, 'the monitor sent the step back exactly once')
    // First visit in a lane (it shared the wave with the frontend step), second
    // in the run worktree (it had that wave to itself).
    assert.notEqual(visits[0], done.projectDir, 'the first visit ran in a lane')

    // What must be true, pinned on the work rather than on the directory.
    //
    // The old assertion was `visits[1] === done.projectDir`, which holds only
    // when the retry has its wave to itself - and whether it does depends on
    // when the SIBLING step settles. On a slower machine the retry can share a
    // wave and be given a lane, which is correct behaviour and failed the test:
    // it went red in CI on a commit that changed nothing but the product
    // registry, while passing four times locally including under load.
    //
    // The behaviour the comment above says is being pinned is that the work
    // must survive the lane it was made in. That is what is asserted now, and
    // it holds whichever wave the retry lands in.
    assert.ok(existsSync(join(visits[1], 'backend-visit-1.txt')),
      `the retry sees the first attempt's commits, so the work survived its lane; ${visits[1]} does not have them`)
    assert.notEqual(visits[1], visits[0], 'and it is not the first attempt\'s lane, which was merged and removed')
    assert.ok(existsSync(join(done.projectDir, 'backend-visit-1.txt')), 'both attempts are on the run branch at the end')
    assert.ok(existsSync(join(done.projectDir, 'backend-visit-2.txt')))
    // Both attempts' commits are on the run branch: the lane did not take the
    // first attempt's work with it when it was removed.
    assert.ok(existsSync(join(done.projectDir, 'backend-visit-1.txt')), "the first attempt's commit survived its lane")
    assert.ok(existsSync(join(done.projectDir, 'backend-visit-2.txt')), "the retry's commit is on the run branch")
    assert.equal((await git(done.projectDir, ['worktree', 'list'])).split('\n').length, 2, 'no lane outlives the retried wave')
  }

  // ── a lane's test unlock stays inside that lane ─────────────────────────
// Run a3cb9d37 (CSUP-7526, $35.54): the client lane could not commit because
// lock state armed by the BACKEND lane was reachable from it. The unlock was
// written into the run's shared worktree as well as the lane's own, which
// makes that shared `.agent` directory a channel between lanes running at the
// same moment - one lane's permission visible to a sibling that never earned
// it, in exactly the wave where both are writing.
//
// The copy existed so the reason would survive the lane being removed. That is
// now the run's evidence's job: withdrawTestUnlocks copies the reason into the
// run artifacts when the run ends.
{
  const { testUnlockTargets } = await import('../server/utils/workflowRunner.ts')
  const run = { id: 'lane-scope', projectDir: '/w/run-worktree' }
  const lane = '/w/run-worktree__implement-client-change'

  assert.deepEqual(testUnlockTargets(run, lane), [lane],
    'a lane unlock is written ONLY in that lane; the run worktree is shared with every sibling lane')

  // A step that is not in a lane works in the run's own worktree, and still
  // gets its unlock there.
  assert.deepEqual(testUnlockTargets(run, '/w/run-worktree'), ['/w/run-worktree'])

  // A run with no checkout at all still yields the one directory it has.
  assert.deepEqual(testUnlockTargets({ id: 'x' }, '/tmp/somewhere'), ['/tmp/somewhere'])
}

// ── A lane holding uncommitted work is kept, not deleted ──────────────────
//
// `mergeLane` merges COMMITS; `removeLane` then runs `worktree remove --force`,
// which deletes everything that was not one. Run a3cb9d37 lost its client fix
// exactly there - "T1/T5 remain staged and uncommitted at fd6e3240, 566
// insertions across 5 files" - with no error and no log line, and the only
// mitigation shipped for it was a sentence in a prompt.
{
  const dirtyFan = {
    slug: 'lanes-dirty', name: 'Lanes Dirty',
    steps: [
      { id: 'd-plan', agentSlug: 'd-planner', label: 'Plan', next: ['d-back', 'd-front'] },
      { id: 'd-back', agentSlug: 'd-backend', label: 'Implement Backend', next: ['d-done'] },
      { id: 'd-front', agentSlug: 'd-frontend', label: 'Implement Frontend', next: ['d-done'] },
      { id: 'd-done', agentSlug: 'd-verifier', label: 'Verify', next: [] },
    ],
  }
  const project2 = join(root, 'project-dirty')
  await execFileP('git', ['init', '-q', project2])
  await git(project2, ['config', 'user.email', 'test@example.com'])
  await git(project2, ['config', 'user.name', 'Test'])
  writeFileSync(join(project2, 'app.txt'), 'start\n')
  await git(project2, ['add', '-A'])
  await git(project2, ['commit', '-qm', 'initial'])

  const lanes = {}
  runner.setAgentCaller(async (agentSlug, _input, cwd) => {
    lanes[agentSlug] = cwd
    if (agentSlug === 'd-backend') {
      // Commits, like a well-behaved step.
      writeFileSync(join(cwd, 'backend.txt'), 'backend\n')
      await git(cwd, ['config', 'user.email', 'test@example.com'])
      await git(cwd, ['config', 'user.name', 'Test'])
      await git(cwd, ['add', '-A'])
      await git(cwd, ['commit', '-qm', 'backend work'])
    }
    if (agentSlug === 'd-frontend') {
      // Writes and never commits: a3cb9d37's client lane.
      writeFileSync(join(cwd, 'client-fix.txt'), 'the fix nobody committed\n')
    }
    return `OUTPUT-OF-${agentSlug}`
  })

  const settled2 = await runner.waitForSettled(
    (await runner.startRun({
      workflow: dirtyFan, initialPrompt: 'CSUP-2 fix it', watch: 'direct-invocation',
      autoRun: true, projectDir: project2,
    })).id, 60000)

  const frontRec = settled2.steps.find(s => s.stepId === 'd-front')
  assert.ok(existsSync(join(lanes['d-frontend'], 'client-fix.txt')),
    'a lane still holding uncommitted work must not be deleted with it inside')
  assert.match(frontRec.laneKept ?? '', /uncommitted file\(s\)/,
    'and the step must say so on the record, where a person and the run summary can see it')
  // The well-behaved lane is unaffected: merged, removed, its commit on the branch.
  assert.ok(existsSync(join(settled2.projectDir, 'backend.txt')), 'a clean lane still merges')
  assert.equal(settled2.steps.find(s => s.stepId === 'd-back').laneKept, undefined,
    'a clean lane is still removed and reports nothing')
  // Keeping a lane is noise, not a failure: the run still finishes. Pinned in
  // both directions so a later edit cannot quietly start failing runs over a
  // stray build artifact, or stop reporting the ones that matter.
  assert.equal(settled2.status, 'completed', 'a kept lane does not fail the run')

  // An UNMEASURABLE lane is kept too. workingTreeDirty answers null when it
  // cannot read the tree at all - a locked or corrupted index, a permission
  // error - and reading that as "clean" would force-delete a worktree nobody
  // checked, which is the same loss through a different door.
  const { workingTreeDirty } = await import('../server/utils/gitFacts.ts')
  const broken = join(root, 'broken-lane')
  await execFileP('git', ['init', '-q', broken])
  await git(broken, ['config', 'user.email', 'test@example.com'])
  await git(broken, ['config', 'user.name', 'Test'])
  writeFileSync(join(broken, 'a.txt'), 'x\n')
  await git(broken, ['add', '-A'])
  await git(broken, ['commit', '-qm', 'base'])
  writeFileSync(join(broken, 'uncommitted.txt'), 'work nobody committed\n')
  writeFileSync(join(broken, '.git', 'index'), 'not an index')
  assert.equal(await workingTreeDirty(broken), null,
    'a tree git cannot read reports null - NOT an empty list, which would read as clean')
  assert.equal(await workingTreeDirty(join(root, 'no-such-dir')), null, 'and so does a directory that is not there')
}

console.log('wave lanes: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
