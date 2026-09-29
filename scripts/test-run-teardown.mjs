/**
 * A run with an outcome gives back what it took - its own compose stacks and
 * its worktree - and nothing else.
 *
 * Nothing did before: the provisioner's stack had to outlive it, no later step
 * owned taking it down, and a failed or stopped run never got that far.
 *
 *   node scripts/test-run-teardown.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { teardownRun, runProjectNames } = await import('../server/utils/runTeardown.ts')

const ID = 'ABCDEF12-3456-7890-abcd-ef1234567890'
const id = ID.toLowerCase()
const stackSteps = [{ agentSlug: 'sdlc-stack-provisioner' }, { agentSlug: 'sdlc-verifier' }]

/** Answers docker and git as they would, and records every call. */
function fakeExec({ projects = [], dirty = '', failDown = [] } = {}) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    if (cmd === 'docker' && args[1] === 'ls') return JSON.stringify(projects.map(Name => ({ Name })))
    if (cmd === 'docker' && args.includes('down')) {
      if (failDown.includes(args[2])) throw new Error('daemon said no')
      return ''
    }
    if (cmd === 'git' && args[0] === 'status') return dirty
    return ''
  }
  exec.calls = calls
  exec.downed = () => calls.filter(c => c.args.includes('down')).map(c => c.args[2])
  return exec
}

// ── only this run's projects, never -v ──
{
  const exec = fakeExec({ projects: [`sdlc-${id}`, `sdlc-${id}-verify`, `sdlc-${id.slice(0, 8)}`, 'sdlc-99999999', 'infra', 'alepo-sso', `sdlc-${id}x`] })
  const r = await teardownRun({ id: ID, steps: stackSteps }, exec)
  assert.deepEqual(exec.downed().sort(), [`sdlc-${id}`, `sdlc-${id}-verify`, `sdlc-${id.slice(0, 8)}`].sort(),
    'the run\'s own projects come down; another run\'s, the shared ones and a lookalike do not')
  assert.ok(exec.calls.filter(c => c.args.includes('down')).every(c => !c.args.includes('-v')), 'and never with -v: volumes are kept')
  assert.equal(r.stacks.length, 3)
  assert.deepEqual(runProjectNames(ID), [`sdlc-${id}`, `sdlc-${id.slice(0, 8)}`])
}

// ── a refused down is reported, not thrown ──
{
  const exec = fakeExec({ projects: [`sdlc-${id}`], failDown: [`sdlc-${id}`] })
  const r = await teardownRun({ id: ID, steps: stackSteps }, exec)
  assert.equal(r.stacks[0].removed, false)
  assert.match(r.stacks[0].error, /daemon said no/)
}

// ── a run with no stack step never asks docker ──
{
  const exec = fakeExec({ projects: [`sdlc-${id}`] })
  await teardownRun({ id: ID, steps: [{ agentSlug: 'sdlc-scanner-security' }, { agentSlug: 'sdlc-finding-triage' }] }, exec)
  assert.equal(exec.calls.filter(c => c.cmd === 'docker').length, 0, 'no stack step, no docker')
}

// ── the worktree: removed when clean, kept when not; a scan's branch goes with it ──
const root = mkdtempSync(join(tmpdir(), 'teardown-'))
{
  const wt = join(root, 'ase-crm@scan-abcdef12')
  mkdirSync(wt, { recursive: true })
  const exec = fakeExec()
  const r = await teardownRun({ id: ID, steps: [], branch: 'scan/abcdef12', projectDir: wt }, exec)
  assert.equal(r.worktree.removed, true, 'a clean worktree is removed')
  const git = exec.calls.filter(c => c.cmd === 'git').map(c => c.args.join(' '))
  assert.ok(git.includes(`worktree remove ${wt}`), 'with git, not rm')
  assert.ok(git.includes('branch -D scan/abcdef12'), 'and a scan branch, which holds nothing, goes with it')
  assert.equal(exec.calls.find(c => c.args[0] === 'worktree').cwd, join(root, 'ase-crm'), 'from the clone it belongs to')
}
{
  const wt = join(root, 'ase-crm@fix-ASECRM-1-abcdef12')
  mkdirSync(wt, { recursive: true })
  const exec = fakeExec()
  await teardownRun({ id: ID, steps: [], branch: 'fix/ASECRM-1-abcdef12', projectDir: wt }, exec)
  assert.ok(!exec.calls.some(c => c.args[0] === 'branch'), 'a fix branch is kept: a pull request may be built on it')
}
{
  const wt = join(root, 'ase-crm@fix-ASECRM-2-abcdef12')
  mkdirSync(wt, { recursive: true })
  const exec = fakeExec({ dirty: ' M src/App.java\n?? notes.txt\n' })
  const r = await teardownRun({ id: ID, steps: [], branch: 'fix/ASECRM-2-abcdef12', projectDir: wt }, exec)
  assert.equal(r.worktree.removed, false, 'an uncommitted change is never discarded')
  assert.match(r.worktree.reason, /2 uncommitted/)
  assert.ok(!exec.calls.some(c => c.args[0] === 'worktree'), 'and nothing is removed')
}
{
  // A run that works in the shared clone, or a directory it was handed, owns no worktree.
  const exec = fakeExec()
  const r = await teardownRun({ id: ID, steps: [], branch: 'fix/x', projectDir: join(root, 'ase-crm') }, exec)
  assert.equal(r.worktree, undefined, 'a directory that is not <clone>@<branch> is never removed')
}

// ── the switch ──
{
  process.env.RUN_TEARDOWN_DISABLED = '1'
  const exec = fakeExec({ projects: [`sdlc-${id}`] })
  await teardownRun({ id: ID, steps: stackSteps }, exec)
  assert.equal(exec.calls.length, 0, 'RUN_TEARDOWN_DISABLED=1 leaves everything standing')
  delete process.env.RUN_TEARDOWN_DISABLED
}

rmSync(root, { recursive: true, force: true })
console.log('run teardown: a run gives back its own stacks and worktree, and nothing else')
