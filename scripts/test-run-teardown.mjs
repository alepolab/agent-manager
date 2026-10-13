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
function fakeExec({ projects = [], dirty = '', failDown = [], images = [], labelled = [], inUse = [] } = {}) {
  const calls = []
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd })
    if (cmd === 'docker' && args[1] === 'ls') return JSON.stringify(projects.map(Name => ({ Name })))
    // images: every repo:tag; labelled: [{ id, names }] carrying agent-manager.run; inUse: names or ids a container runs
    if (cmd === 'docker' && args[0] === 'images') {
      if (args.includes('--filter')) return labelled.flatMap(l => (l.names.length ? l.names : ['<none>:<none>']).map(n => `${l.id}\t${n}`)).join('\n')
      return [...images, ...labelled.flatMap(l => l.names)].join('\n')
    }
    if (cmd === 'docker' && args[0] === 'ps') return inUse.includes(args.at(-1).replace('ancestor=', '')) ? 'c0ffee\n' : ''
    if (cmd === 'docker' && args[0] === 'rmi') {
      if (inUse.includes(args[1])) throw new Error(`conflict: unable to delete ${args[1]} (must be forced) - container c0ffee is using its referenced image`)
      return `Untagged: ${args[1]}`
    }
    if (cmd === 'docker' && args.includes('down')) {
      if (failDown.includes(args[2])) throw new Error('daemon said no')
      return ''
    }
    if (cmd === 'git' && args[0] === 'status') return dirty
    return ''
  }
  exec.calls = calls
  exec.downed = () => calls.filter(c => c.args.includes('down')).map(c => c.args[2])
  exec.withVolumes = () => calls.filter(c => c.args.includes('down') && c.args.includes('-v')).map(c => c.args[2])
  exec.rmi = () => calls.filter(c => c.args[0] === 'rmi').map(c => c.args[1])
  return exec
}

// ── only this run's projects, and its own with their volumes ──
{
  const exec = fakeExec({ projects: [`sdlc-${id}`, `sdlc-${id}-verify`, `sdlc-${id.slice(0, 8)}`, 'sdlc-99999999', 'infra', 'alepo-sso', `sdlc-${id}x`] })
  const r = await teardownRun({ id: ID, steps: stackSteps }, exec, [])
  assert.deepEqual(exec.downed().sort(), [`sdlc-${id}`, `sdlc-${id}-verify`, `sdlc-${id.slice(0, 8)}`].sort(),
    'the run\'s own projects come down; another run\'s, the shared ones and a lookalike do not')
  assert.deepEqual(exec.withVolumes().sort(), [`sdlc-${id}`, `sdlc-${id}-verify`, `sdlc-${id.slice(0, 8)}`].sort(),
    'THE LEAK: the run\'s own projects came down without -v, and their volumes stayed for good')
  assert.ok(r.stacks.every(s => s.volumes === true))
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
  assert.equal(exec.calls.filter(c => c.cmd === 'docker' && c.args[0] === 'compose').length, 0, 'no stack step, no compose')
  assert.ok(exec.calls.every(c => c.args[0] !== 'compose'), 'a scan builds images, so only those are looked for')
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
  // ASECRM-357: a failed run is restarted in its worktree. Removing it - which
  // stopped part-way at a container's files - left nothing a restart could use.
  const wt = join(root, 'ase-crm@fix-ASECRM-3-abcdef12')
  mkdirSync(wt, { recursive: true })
  const exec = fakeExec({ projects: [`sdlc-${id}`] })
  const r = await teardownRun({ id: ID, status: 'failed', steps: stackSteps, branch: 'fix/ASECRM-3-abcdef12', projectDir: wt }, exec, [])
  assert.equal(r.worktree.removed, false, 'THE REGRESSION: a failed run\'s worktree was removed')
  assert.match(r.worktree.reason, /restarted from here/)
  assert.ok(!exec.calls.some(c => c.cmd === 'git'), 'git is not asked to remove it')
  assert.deepEqual(exec.downed(), [`sdlc-${id}`], 'its stack still comes down')
}
{
  const wt = join(root, 'ase-crm@fix-ASECRM-4-abcdef12')
  mkdirSync(wt, { recursive: true })
  for (const status of ['completed', 'stopped']) {
    const exec = fakeExec()
    const r = await teardownRun({ id: ID, status, steps: [], branch: 'fix/ASECRM-4-abcdef12', projectDir: wt }, exec)
    assert.equal(r.worktree.removed, true, `a ${status} run's clean worktree still goes`)
  }
}
{
  // A run that works in the shared clone, or a directory it was handed, owns no worktree.
  const exec = fakeExec()
  const r = await teardownRun({ id: ID, steps: [], branch: 'fix/x', projectDir: join(root, 'ase-crm') }, exec)
  assert.equal(r.worktree, undefined, 'a directory that is not <clone>@<branch> is never removed')
}

// ── the images it built: by its id and by its label, and nobody else's ──
// Nothing removed a run's images before: three weeks of runs filled a 492 GB disk to 99%.
const OTHER = 'abcdef12-0000-4000-8000-000000000000' // shares this run's first eight characters
{
  const exec = fakeExec({
    images: [
      `localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}-verify`, // short id, in the tag
      `sdlc-${id.slice(0, 8)}-ui-builder:latest`,             // short id, in the repository
      `ase-crm-backend-builder:sdlc-${id}`,                    // full id
      `localhost/agent-sdlc/ase-crm:${OTHER}-verify`,          // another run's full id, same first eight
      'localhost/agent-sdlc/ase-crm:99999999-fix',             // another run's short id
      'ase-crm:latest', 'ghcr.io/alepolab/ase-crm:develop',    // the shared stack's
      `ase-crm:sha-${id.slice(0, 8)}9f0e`,                     // eight characters inside a longer sha
      'asecrm549-ui-builder:latest',                           // named by ticket: not provably this run's
    ],
    labelled: [{ id: 'img1', names: ['ghcr.io/alepolab/ase-crm:local-develop-3f2a', 'asecrm1-ui-builder:latest'] }, { id: 'img2', names: [] }],
  })
  const r = await teardownRun({ id: ID, steps: [{ agentSlug: 'sdlc-test-author' }] }, exec, [])
  assert.deepEqual(exec.rmi().sort(), [
    `localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}-verify`, `sdlc-${id.slice(0, 8)}-ui-builder:latest`, `ase-crm-backend-builder:sdlc-${id}`,
    'ghcr.io/alepolab/ase-crm:local-develop-3f2a', 'asecrm1-ui-builder:latest', 'img2',
  ].sort(), 'THE REGRESSION: the run\'s images stayed on the disk')
  assert.ok(exec.rmi().every(n => !n.startsWith('-')) && exec.calls.filter(c => c.args[0] === 'rmi').every(c => !c.args.includes('-f') && !c.args.includes('--force')), 'never forced')
  assert.equal(r.images.removed.length, 6)
  assert.deepEqual(r.images.refused, [])
}
{
  // An image a container still uses: the daemon refuses its name, and a labelled one keeps all of its names.
  const exec = fakeExec({
    images: [`localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}`, `sdlc-${id.slice(0, 8)}-ui-builder:latest`],
    labelled: [{ id: 'img3', names: ['ghcr.io/alepolab/ase-crm:local-develop-77aa'] }],
    inUse: [`localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}`, 'img3'],
  })
  const r = await teardownRun({ id: ID, steps: [{ agentSlug: 'sdlc-verifier' }] }, exec, [])
  assert.deepEqual(r.images.removed, [`sdlc-${id.slice(0, 8)}-ui-builder:latest`])
  assert.deepEqual(r.images.refused.map(x => x.image).sort(), ['ghcr.io/alepolab/ase-crm:local-develop-77aa', `localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}`].sort(), 'refused, kept and reported')
  assert.match(r.images.refused.find(x => x.image.startsWith('localhost')).error, /must be forced/)
  assert.ok(!exec.rmi().includes('ghcr.io/alepolab/ase-crm:local-develop-77aa'), 'a labelled image a container runs is not untagged')
}
{
  // A stack another live run still uses: it stays up, without -v, and the run's images stay with it.
  const claimer = { id: '11111111-2222-4333-8444-555555555555', status: 'paused', stackProject: `sdlc-${id}` }
  const exec = fakeExec({ projects: [`sdlc-${id}`], images: [`localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}`] })
  const r = await teardownRun({ id: ID, steps: stackSteps }, exec, [claimer])
  assert.deepEqual(exec.downed(), [], 'kept for the run that claimed it')
  assert.deepEqual(exec.rmi(), [], 'and so are its images')
  assert.match(r.images.kept, /11111111/)
}
{
  // A project this run took over from another: down, but its volumes are not this run's to drop.
  const from = 'sdlc-22222222-3333-4444-8555-666666666666'
  const exec = fakeExec({ projects: [from] })
  const r = await teardownRun({ id: ID, steps: stackSteps, stackProject: from }, exec, [])
  assert.deepEqual(exec.downed(), [from])
  assert.deepEqual(exec.withVolumes(), [], 'a claimed project never gets -v')
  assert.equal(r.stacks[0].volumes, false)
}
{
  // A run with no step that builds anything never asks docker for images.
  const exec = fakeExec({ images: [`localhost/agent-sdlc/ase-crm:${id.slice(0, 8)}`] })
  const r = await teardownRun({ id: ID, steps: [{ agentSlug: 'sdlc-jira-tracker' }, { agentSlug: 'sdlc-notifier' }] }, exec, [])
  assert.equal(exec.calls.filter(c => c.cmd === 'docker').length, 0)
  assert.equal(r.images, undefined)
}
{
  const { imageNamedFor } = await import('../server/utils/runTeardown.ts')
  for (const [name, want] of [
    [`x:${id.slice(0, 8)}`, true], [`x:${id}`, true], [`X:${ID}-verify`, true], [`sdlc-${id.slice(0, 8)}-ui:latest`, true],
    [`x:${OTHER}`, false], [`x:${id.slice(0, 8)}0`, false], [`x:a${id.slice(0, 8)}`, false], ['ase-crm:latest', false],
  ]) assert.equal(imageNamedFor(ID, name), want, name)
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
console.log('run teardown: a run gives back its own stacks, volumes, images and worktree, and nothing else')
