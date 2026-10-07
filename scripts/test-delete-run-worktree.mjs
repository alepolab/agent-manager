/**
 * Deleting a run gives back its worktree, when git agrees it is clean.
 *
 * A failed run keeps its worktree, to be restarted from (runTeardown.ts). Then
 * nothing removed it: deleting the run took only its record and evidence, so a
 * failed run that was deleted, or never restarted, left a full product checkout
 * with its branch checked out on the host for good.
 *
 *   node scripts/test-delete-run-worktree.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'delete-wt-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')

function fakeExec({ dirty = '' } = {}) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    if (cmd === 'git' && args[0] === 'status') return dirty
    return ''
  }
  exec.calls = calls
  exec.removed = () => calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'remove').map(c => c.args[2])
  return exec
}

/** A settled run on disk working in `<clone>@<branch>`. */
async function settledRun(status, branch) {
  const run = await store.createRun({ workflowSlug: 'wf', workflowName: 'WF', initialPrompt: 'go', watch: 'direct-invocation', steps: [] })
  const dir = join(root, 'ws', `ase-crm@${branch.replace('/', '-')}`)
  mkdirSync(dir, { recursive: true })
  await store.saveRun({ ...run, status, branch, projectDir: dir })
  return { id: run.id, dir }
}

// ── a failed run: its kept worktree goes with it ──
{
  const { id, dir } = await settledRun('failed', 'fix/ASECRM-1-aaaa')
  const exec = fakeExec()
  assert.equal(await store.deleteRun(id, { exec }), 'ok')
  assert.deepEqual(exec.removed(), [dir], 'THE GAP: a deleted failed run left its worktree on the host')
  assert.equal(exec.calls.find(c => c.args[1] === 'remove').cwd, join(root, 'ws', 'ase-crm'), 'removed with git, from its clone')
  assert.ok(!exec.calls.some(c => c.args[0] === 'branch'), 'a fix branch is kept: a pull request may be built on it')
  assert.equal(await store.getRun(id), null, 'and the record is gone')
}

// ── an uncommitted change is never discarded, and the delete still happens ──
{
  const { id } = await settledRun('failed', 'fix/ASECRM-2-bbbb')
  const exec = fakeExec({ dirty: ' M src/App.java\n' })
  assert.equal(await store.deleteRun(id, { exec }), 'ok')
  assert.deepEqual(exec.removed(), [], 'a dirty worktree is kept')
  assert.equal(await store.getRun(id), null, 'the run itself is still deleted, as asked')
}

// ── a scan's branch holds nothing and goes with its worktree ──
{
  const { id } = await settledRun('failed', 'scan/cccc')
  const exec = fakeExec()
  await store.deleteRun(id, { exec })
  assert.ok(exec.calls.some(c => c.args.join(' ') === 'branch -D scan/cccc'))
}

// ── a run with no worktree of its own touches no git ──
{
  const run = await store.createRun({ workflowSlug: 'wf', workflowName: 'WF', initialPrompt: 'go', watch: 'direct-invocation', steps: [] })
  await store.saveRun({ ...run, status: 'completed', branch: 'fix/x', projectDir: join(root, 'ws', 'ase-crm') })
  const exec = fakeExec()
  assert.equal(await store.deleteRun(run.id, { exec }), 'ok')
  assert.equal(exec.calls.length, 0, 'a directory that is not <clone>@<branch> is never removed')
}

// ── a live run is refused before anything is touched ──
{
  const { id } = await settledRun('paused', 'fix/ASECRM-3-dddd')
  const exec = fakeExec()
  assert.equal(await store.deleteRun(id, { exec }), 'live')
  assert.equal(exec.calls.length, 0)
}

rmSync(root, { recursive: true, force: true })
console.log('ok - deleting a run gives back its worktree when it is clean')
