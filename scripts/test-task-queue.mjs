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
  const r = await Q.dispatch(async (t) => {
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

  const r = await Q.dispatch(async (t) => {
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
  const r = await Q.dispatch(async (t) => {
    const nr = await store.createRun({
      workflowSlug: 'wf', workflowName: 'W', autoRun: false, initialPrompt: t.detail,
      watch: 'direct-invocation', projectDir: t.projectDir,
      steps: [{ stepId: 'a', label: 'A', agentSlug: 'x' }],
    })
    await store.saveRun({ ...nr, status: 'running' })
    return nr
  })
  assert.deepEqual(r.started.sort(), ['1', '3'],
    'one per checkout — and the task on a free checkout is NOT blocked behind the busy one')
  assert.match(r.held['2'], /busy with run/, 'and the one that yielded says which repository')
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
  await Q.dispatch(async (tk) => {
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

rmSync(dir, { recursive: true, force: true })
console.log('task queue: the whole project is listed, dependencies and capacity gate it, one checkout takes one run at a time, and a settled run frees the next')
