/**
 * A project's whole work, held as tasks, dispatched one run at a time.
 *
 * Runs are expensive: one holds a checkout and a capacity slot. So forty tasks
 * cannot be forty runs — twelve tasks against one repository can never be
 * twelve live runs, whatever the concurrency cap says. The queue is the cheap
 * half: every task exists and is listed from the moment the project is
 * created, and runs are minted from it as slots free.
 *
 *   node scripts/test-task-queue.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'queue-'))
process.env.CLAUDE_DIR = dir
process.env.AGENT_RUNS_DIR = join(dir, 'runs')
delete process.env.AGENT_MAX_CONCURRENT_RUNS
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ agentManager: { maxConcurrentRuns: 1 } }))

const Q = await import('../server/utils/taskQueue.ts')
const store = await import('../server/utils/workflowRunStore.ts')

const task = (id, over = {}) => ({
  id, title: `task ${id}`, detail: `do ${id}`, order: Number(id.replace(/\D/g, '')) || 0,
  deps: [], workflowSlug: 'wf', projectDir: `/tmp/repo-${id}`, module: `repo-${id}`, ...over,
})

// ---- A task with nothing to dispatch is skipped from birth --------------
// Listing it as pending would promise a run that is never coming — the exact
// dishonesty this page exists to remove.
{
  await Q.setQueue('P', [task('1'), { ...task('2'), projectDir: undefined, note: 'human work' }])
  const q = await Q.readQueue()
  assert.equal(q.tasks.find(t => t.id === '1').status, 'pending')
  const human = q.tasks.find(t => t.id === '2')
  assert.equal(human.status, 'skipped')
  assert.match(human.note, /human work/, 'and it carries the reason, not a bare status')
}

// ---- Dependencies gate eligibility --------------------------------------
{
  await Q.setQueue('P', [task('1'), { ...task('2'), deps: ['1'] }, { ...task('3'), deps: ['1'] }])
  let q = await Q.readQueue()
  assert.deepEqual(Q.eligible(q).map(t => t.id), ['1'], 'only the task with no unmet dependency')

  q.tasks.find(t => t.id === '1').status = 'done'
  assert.deepEqual(Q.eligible(q).map(t => t.id), ['2', '3'], 'finishing it frees both, in order')
}

// ---- One run at a time, and the rest say why ----------------------------
{
  await Q.setQueue('P', [task('1'), task('2'), task('3')])
  const started = []
  const r = await Q.dispatch(async ([t]) => {
    const run = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: t.detail,
      watch: 'direct-invocation', projectDir: t.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...run, status: 'running' })
    started.push(t.id)
    return run
  })
  assert.deepEqual(r.started, ['1'], 'a cap of one starts exactly one')
  assert.equal(started.length, 1)
  // The two it could not start are not silently absent: each carries the reason.
  assert.ok(r.held['2'] && r.held['3'], 'every held task says why')
  assert.match(r.held['2'], /allows 1 run at once/)
}

// ---- Settling frees the slot, and the next one goes ---------------------
{
  let q = await Q.readQueue()
  const running = q.tasks.find(t => t.status === 'running')
  assert.ok(running?.runId, 'the task points at its run')

  const run = await store.getRun(running.runId)
  await store.saveRun({ ...run, status: 'completed', endedAt: Date.now() })

  q = await Q.reconcile()
  assert.equal(q.tasks.find(t => t.id === running.id).status, 'done',
    'a task is done because its run is, not because anything told the queue')

  const r = await Q.dispatch(async ([t]) => {
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: t.detail,
      watch: 'direct-invocation', projectDir: t.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  assert.deepEqual(r.started, ['2'], 'the next task starts once the slot is free')
}

// ---- A failed run fails its task, and the task can be requeued ----------
{
  const q = await Q.reconcile()
  const running = q.tasks.find(t => t.status === 'running')
  const run = await store.getRun(running.runId)
  await store.saveRun({ ...run, status: 'failed', error: 'boom', endedAt: Date.now() })

  const after = await Q.reconcile()
  const failed = after.tasks.find(t => t.id === running.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.note, /run failed.*boom/, 'the reason travels with it')

  const back = await Q.setTaskStatus(running.id, 'pending')
  assert.equal(back.status, 'pending')
  assert.equal(back.runId, undefined, 'requeueing clears the dead run')
}

// ---- Two tasks on one checkout serialise; others are not blocked --------
// The constraint that decides everything: twelve tasks against one repository
// can never be twelve live runs. They must yield to tasks elsewhere rather
// than consume the dispatch attempt.
{
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ agentManager: { maxConcurrentRuns: 5 } }))
  await Q.setQueue('P', [
    { ...task('1'), projectDir: '/tmp/same', module: 'same' },
    { ...task('2'), projectDir: '/tmp/same', module: 'same' },
    { ...task('3'), projectDir: '/tmp/other', module: 'other' },
  ])
  const r = await Q.dispatch(async ([t]) => {
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: t.detail,
      watch: 'direct-invocation', projectDir: t.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  // Both tasks on `same` go in ONE run (they share a checkout, so they could
  // never have been concurrent), and `other` goes at the same time in its own.
  assert.deepEqual(r.started.sort(), ['1', '2', '3'],
    'a shared checkout is one run for all of its tasks, and another repository runs in parallel')
  const q2 = await Q.readQueue()
  assert.equal(new Set(q2.tasks.filter(t => t.module === 'same').map(t => t.runId)).size, 1,
    'the two on one checkout share a run')
  assert.notEqual(q2.tasks.find(t => t.id === '3').runId, q2.tasks.find(t => t.id === '1').runId,
    'and the other repository has a run of its own')
}

// ---- A group is one run, and groups go in parallel ---------------------
// Twelve tasks against one repository could only ever be twelve runs one after
// another, because the workspace lock allows one run per checkout. That was
// not a policy, it was the lock — and it made the queue as slow as its busiest
// repository.
{
  for (const prev of (await Q.readQueue()).tasks.filter(x => x.status === 'running')) {
    const r = await store.getRun(prev.runId)
    await store.saveRun({ ...r, status: 'completed', endedAt: Date.now() })
  }
  await Q.reconcile()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ agentManager: { maxConcurrentRuns: 5 } }))
  await Q.setQueue('P', [
    { ...task('1'), projectDir: '/tmp/repoA', module: 'A' },
    { ...task('2'), projectDir: '/tmp/repoA', module: 'A' },
    { ...task('3'), projectDir: '/tmp/repoA', module: 'A' },
    { ...task('4'), projectDir: '/tmp/repoB', module: 'B' },
  ])
  const batches = []
  const r = await Q.dispatch(async (group) => {
    batches.push(group.map(g => g.id))
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: 'x',
      watch: 'direct-invocation', projectDir: group[0].projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  assert.deepEqual(batches, [['1', '2', '3'], ['4']],
    'the three sharing a checkout are ONE run; the other repository goes at the same time')
  assert.deepEqual(r.started.sort(), ['1', '2', '3', '4'], 'all four are started, in two runs')

  const q = await Q.readQueue()
  const ids = new Set(q.tasks.filter(t => t.module === 'A').map(t => t.runId))
  assert.equal(ids.size, 1, 'and the group shares one run id')

  // Settling that one run settles the whole group.
  const run = await store.getRun([...ids][0])
  await store.saveRun({ ...run, status: 'completed', endedAt: Date.now() })
  const after = await Q.reconcile()
  assert.deepEqual(after.tasks.filter(t => t.module === 'A').map(t => t.status), ['done', 'done', 'done'],
    'a group settles together, because a group is one run')
}

// ---- The lock must survive the runner rewriting projectDir --------------
// The case the plain-path test above could not see: once a run cuts its
// branch, its projectDir becomes the WORKTREE (`<repo>@<branch>`), not the
// checkout it was started against. Comparing strings never matched, so two
// tasks on one repository both started — which is the corruption the lock
// exists to prevent.
{
  // Settle what the previous block started: setQueue refuses to replace a
  // queue while anything is running, which is the guard working.
  for (const prev of (await Q.readQueue()).tasks.filter(x => x.status === 'running')) {
    const r = await store.getRun(prev.runId)
    await store.saveRun({ ...r, status: 'completed', endedAt: Date.now() })
  }
  await Q.reconcile()

  const { execFileSync } = await import('node:child_process')
  const { mkdirSync } = await import('node:fs')
  const repo = join(dir, 'realrepo')
  mkdirSync(repo, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@x'); git('config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('commit', '-qm', 'init')
  const worktree = `${repo}@fix-X-1234`
  git('worktree', 'add', '--quiet', '-b', 'fix/X-1234', worktree)

  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ agentManager: { maxConcurrentRuns: 5 } }))
  await Q.setQueue('P', [
    { ...task('1'), projectDir: repo, module: 'realrepo' },
    { ...task('2'), projectDir: repo, module: 'realrepo' },
  ])
  // A live run whose projectDir is the worktree, exactly as the runner leaves it.
  const live = await store.createRun({
    workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: 'x',
    watch: 'direct-invocation', projectDir: worktree,
    steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
  })
  await store.saveRun({ ...live, status: 'running' })

  const r = await Q.dispatch(async () => { throw new Error('must not start') })
  assert.deepEqual(r.started, [], 'no task starts against a repository whose worktree is already live')
  assert.match(r.held['1'], /busy with run/, 'and the reason names the run holding it')

  await store.saveRun({ ...live, status: 'completed', endedAt: Date.now() })
}

// ---- Replacing the queue while something runs is refused ----------------
// It would orphan a live run: the task pointing at it would be gone and
// nothing would ever reconcile it back.
{
  await Q.setQueue('P', [task('7')])
  await Q.dispatch(async ([tk]) => {
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: tk.detail,
      watch: 'direct-invocation', projectDir: tk.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  assert.equal((await Q.readQueue()).tasks.find(x => x.id === '7').status, 'running')
  await assert.rejects(() => Q.setQueue('P', [task('9')]), /are running/)
}

// ---- Removing a task takes it out of the graph, and says what it broke ----
// `skipped` was the only way to shelve a task, and it is the wrong shape here:
// a skipped task counts as SETTLED, so its dependents are released and run
// against a dependency nobody satisfied. Removal holds them instead.
{
  // The block above deliberately leaves '7' running; settle it so the queue
  // can be replaced, which is the same thing setQueue refuses to do for us.
  await Q.setTaskStatus('7', 'skipped')
  await Q.setQueue('P', [task('10'), { ...task('11'), deps: ['10'] }])
  const r = await Q.removeTask('10')
  assert.equal(r.removed.id, '10', 'the task is gone')
  assert.deepEqual(r.orphaned, ['11'], 'and the task waiting on it is named, not silently repaired')

  const left = await Q.readQueue()
  assert.equal(left.tasks.length, 1, 'only the dependent is left')
  assert.ok(!Q.eligible(left).some(t => t.id === '11'), '11 does not become eligible just because 10 vanished')

  assert.equal(await Q.removeTask('nope'), null, 'removing what is not there is a 404, not a crash')
}

// ---- A running task cannot be removed ------------------------------------
// Its run is live; deleting the row leaves that run with nothing to settle.
{
  await Q.setQueue('P', [task('12')])
  await Q.dispatch(async ([tk]) => {
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: tk.detail,
      watch: 'direct-invocation', projectDir: tk.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  await assert.rejects(() => Q.removeTask('12'), /Stop that run first/)
  assert.equal((await Q.readQueue()).tasks.length, 1, 'and it is still there')
}

rmSync(dir, { recursive: true, force: true })
console.log('task queue: the whole project is listed, dependencies and capacity gate it, one checkout takes one run at a time, a settled run frees the next, and a removed task holds its dependents rather than releasing them')
