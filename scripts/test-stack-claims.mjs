/**
 * A run takes over an up stack of its product instead of standing up another,
 * and a stack comes down only when no live run uses it.
 *
 * Ten Runbook A runs sat at their gates each holding ~1 GiB of ase-crm stack,
 * while every new run on the same product stood up one more.
 *
 *   node scripts/test-stack-claims.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'claims-'))
const { claimableStack, teardownRun, stackProjectOf } = await import('../server/utils/runTeardown.ts')

const crm = { name: 'ase-crm', repos: ['alepolab/ase-crm'] }
const A = { id: 'aaaaaaaa-1111-4000-8000-000000000001', status: 'paused', product: crm, steps: [{ agentSlug: 'sdlc-stack-provisioner' }] }
const B = { id: 'bbbbbbbb-2222-4000-8000-000000000002', status: 'running', product: crm, steps: [{ agentSlug: 'sdlc-stack-provisioner' }] }
const P = { id: 'cccccccc-3333-4000-8000-000000000003', status: 'paused', product: { name: 'portal', repos: [] }, steps: [] }
const projA = `sdlc-${A.id}`

/** A docker that knows which compose projects are up and records every `down`. */
function docker(up) {
  const downs = []
  const exec = async (cmd, args) => {
    if (args[1] === 'ls') return JSON.stringify(up.map(n => ({ Name: n, Status: 'running(5)' })))
    if (args.includes('down')) { downs.push(args[args.indexOf('-p') + 1]); up.splice(up.indexOf(args[args.indexOf('-p') + 1]), 1) }
    return ''
  }
  return { exec, downs }
}

// ── Claiming ─────────────────────────────────────────────────────────────────
{
  const d = docker([projA, `sdlc-${P.id}`])
  assert.deepEqual(await claimableStack(B, [A, B, P], d.exec), { project: projA, from: A.id },
    'a paused run\'s stack of the same product is taken over')
  assert.equal(await claimableStack({ ...B, product: { name: 'billing' } }, [A, B, P], d.exec), null, 'never another product\'s')

  const busy = { ...A, status: 'running' }
  assert.equal(await claimableStack(B, [busy, B], d.exec), null, 'never one a run is working in right now')
  const claimer = { id: 'dddddddd-4444-4000-8000-000000000004', status: 'running', product: crm, stackProject: projA }
  assert.equal(await claimableStack(B, [A, B, claimer], d.exec), null, 'nor one another run already took and is working in')
  assert.equal(await claimableStack(B, [A, B], docker([`${projA}-verify`]).exec), null, 'a verifier\'s own stack is not shared')
}

// ── Teardown ─────────────────────────────────────────────────────────────────
{
  const Bc = { ...B, stackProject: projA, stackClaimedFrom: A.id }
  assert.equal(stackProjectOf(Bc), projA)

  // A finishes while B still uses its stack: A only lets go.
  let d = docker([projA])
  let r = await teardownRun({ ...A, status: 'completed' }, d.exec, [{ ...A, status: 'completed' }, Bc])
  assert.deepEqual(d.downs, [], 'the stack stays up for the run that claimed it')
  assert.match(r.stacks[0].error, /kept: in use by run bbbbbbbb/)

  // B, the last user, finishes: now it comes down.
  r = await teardownRun({ ...Bc, status: 'completed' }, d.exec, [{ ...A, status: 'completed' }, { ...Bc, status: 'completed' }])
  assert.deepEqual(d.downs, [projA], 'the last user takes it down')

  // The other way round: the claimer finishes first, the owner is still paused.
  d = docker([projA])
  await teardownRun({ ...Bc, status: 'completed' }, d.exec, [A, { ...Bc, status: 'completed' }])
  assert.deepEqual(d.downs, [], 'the run it was claimed from still uses it')
  await teardownRun({ ...A, status: 'failed' }, d.exec, [{ ...A, status: 'failed' }, { ...Bc, status: 'completed' }])
  assert.deepEqual(d.downs, [projA])

  // Nobody claimed it: unchanged behaviour.
  d = docker([projA])
  await teardownRun({ ...A, status: 'stopped' }, d.exec, [{ ...A, status: 'stopped' }])
  assert.deepEqual(d.downs, [projA])
}

// ── What the claiming run's agents are told ─────────────────────────────────
{
  const { artifactHeader } = await import('../server/utils/runArtifacts.ts')
  const claimed = artifactHeader('/tmp/x', undefined, 'dev', B.id, undefined, undefined, { project: projA, claimedFrom: A.id })
  assert.match(claimed, new RegExp(`Compose project for this run's stack: ${projA} - already up, taken over from run ${A.id}`))
  assert.match(claimed, /do not bring it down or stand up a second one/)
  assert.match(claimed, /deploy this run's own build into it before you test/)
  const own = artifactHeader('/tmp/x', undefined, 'dev', B.id)
  assert.match(own, new RegExp(`Compose project for any stack this run stands up: sdlc-${B.id}`), 'an unclaimed run keeps its own name')
}

// ── A run coming back to a stack that was taken down ────────────────────────
{
  const { stackIsUp, STACK_USING_AGENTS } = await import('../server/utils/runTeardown.ts')
  const { stackNote } = await import('../server/utils/runArtifacts.ts')
  assert.equal(await stackIsUp(projA, docker([projA]).exec), true)
  assert.equal(await stackIsUp(projA, docker([]).exec), false, 'taken down while its run waited')
  assert.equal(await stackIsUp(projA, async () => { throw new Error('no daemon') }), false)
  for (const slug of ['sdlc-stack-update', 'sdlc-qa-automated', 'sdlc-qa-manual', 'sdlc-trace-capture']) assert.ok(STACK_USING_AGENTS.test(slug), slug)
  for (const slug of ['sdlc-stack-provisioner', 'sdlc-verifier', 'sdlc-ce-work']) assert.ok(!STACK_USING_AGENTS.test(slug), slug)
  // A paused run whose stack went takes over the one still up; B was its owner and is paused too.
  const back = { ...A, id: 'eeeeeeee-5555-4000-8000-000000000005', status: 'running' }
  assert.deepEqual(await claimableStack(back, [A, back], docker([projA]).exec), { project: projA, from: A.id })
  // None free: it is told to stand its own up again, by name.
  assert.match(stackNote(back.id, { project: `sdlc-${back.id}`, gone: true }), new RegExp(`sdlc-${back.id} - not up now.*Stand it up again under that name`))
}

console.log('ok - runs take over free stacks of their product, and the last user takes a stack down')
