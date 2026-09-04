/**
 * Self-check for the server-side runner. A stub agent caller drives the loop,
 * so the scheduler, persistence and pause/continue semantics are testable
 * without a single API call.
 *
 *   node scripts/test-workflow-runner.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runner-'))

const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')

const TIMEOUT = 5000

const workflow = {
  slug: 'demo', name: 'Demo',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['b', 'c'] },
    { id: 'b', agentSlug: 'agent-b', label: 'B', next: ['d'] },
    { id: 'c', agentSlug: 'agent-c', label: 'C', next: ['d'] },
    { id: 'd', agentSlug: 'agent-d', label: 'D', next: [] },
  ],
}

// ── 0. startRun returns BEFORE the run finishes — proves the fix ──────────
// The agent call is gated on a promise we control, never resolved until after
// we've already inspected startRun's return value. If startRun still awaited
// the wave to completion, this would deadlock inside the `await` below rather
// than returning — so reaching the assertions at all is part of the proof.
let releaseAgent
const gate = new Promise((resolve) => { releaseAgent = resolve })
let agentCallStarted = false
runner.setAgentCaller(async (agentSlug) => {
  agentCallStarted = true
  await gate
  return `output of ${agentSlug}`
})
const promptRun = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
assert.ok(promptRun.id, 'startRun returns a run with an id')
assert.notEqual(promptRun.status, 'completed',
  'startRun returns before the run has finished, not after')
releaseAgent()
const settledPromptRun = await runner.waitForSettled(promptRun.id, TIMEOUT)
assert.equal(agentCallStarted, true, 'the background loop actually ran the agent call')
assert.equal(settledPromptRun.status, 'completed',
  'the background loop keeps going after startRun has already returned')

const calls = []
runner.setAgentCaller(async (agentSlug, input) => {
  calls.push({ agentSlug, input })
  return `output of ${agentSlug}`
})

// ── 1. A manual run stops after the first wave and persists that ──────────
let run = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
run = await runner.waitForSettled(run.id, TIMEOUT)
assert.equal(run.status, 'paused', 'a manual run pauses after its first wave')
assert.equal(run.steps.find(s => s.stepId === 'a').status, 'completed')
assert.equal(run.steps.find(s => s.stepId === 'a').output, 'output of agent-a')
assert.deepEqual(run.nextStepIds.sort(), ['b', 'c'], 'the fan-out is queued')

// It is on disk, not just in memory — that is the whole feature.
const fromDisk = await store.getRun(run.id)
assert.equal(fromDisk.status, 'paused')
assert.equal(fromDisk.steps.find(s => s.stepId === 'a').output, 'output of agent-a')

// ── 2. Continue runs the fan-out as ONE wave ──────────────────────────────
run = await runner.continueRun(run.id)
run = await runner.waitForSettled(run.id, TIMEOUT)
assert.equal(run.steps.find(s => s.stepId === 'b').status, 'completed')
assert.equal(run.steps.find(s => s.stepId === 'c').status, 'completed')
assert.deepEqual(run.nextStepIds, ['d'], 'the join is queued once both branches are done')

// ── 3. The join receives BOTH branches' output ────────────────────────────
run = await runner.continueRun(run.id)
run = await runner.waitForSettled(run.id, TIMEOUT)
const dInput = run.steps.find(s => s.stepId === 'd').input
assert.match(dInput, /output of agent-b/)
assert.match(dInput, /output of agent-c/)
assert.equal(run.status, 'completed')
assert.ok(run.endedAt, 'a finished run records when it ended')

// ── 4. An auto-run goes to completion with no continue calls ──────────────
calls.length = 0
let auto = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
auto = await runner.waitForSettled(auto.id, TIMEOUT)
assert.equal(auto.status, 'completed', 'auto-run finishes on its own')
assert.equal(calls.length, 4, 'every step ran exactly once')

// ── 5. A failing step stops the run and skips the rest ────────────────────
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'agent-b') throw new Error('agent-b exploded')
  return `output of ${agentSlug}`
})
let failing = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
failing = await runner.waitForSettled(failing.id, TIMEOUT)
assert.equal(failing.status, 'failed')
assert.equal(failing.steps.find(s => s.stepId === 'b').status, 'failed')
assert.match(failing.steps.find(s => s.stepId === 'b').error, /exploded/)
assert.equal(failing.steps.find(s => s.stepId === 'd').status, 'skipped',
  'a step downstream of a failure is skipped, never left pending')

// ── 6. Subscribers see progress ───────────────────────────────────────────
runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
const seen = []
let started = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
started = await runner.waitForSettled(started.id, TIMEOUT)
const unsubscribe = runner.subscribe(started.id, r => seen.push(r.status))
await runner.continueRun(started.id)
await runner.waitForSettled(started.id, TIMEOUT)
unsubscribe()
assert.ok(seen.length > 0, 'a subscriber is notified as the run advances')

// ── 7. A monitor that throws must not fail an already-successful step (C1) ────
// Isolated from the wave's success/fail: the step itself completed fine, only the
// monitor blew up. That must record a note and CONTINUE, never overwrite the step
// as 'failed' - the outer try/catch around the main agent call must not see it.
const monitorThrowsWorkflow = {
  slug: 'monitor-throws', name: 'Monitor Throws',
  steps: [{ id: 'm', agentSlug: 'agent-m', label: 'M', next: [], monitorSlug: 'monitor-m' }],
}
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'monitor-m') throw new Error('monitor exploded')
  return `output of ${agentSlug}`
})
let monitorBroke = await runner.startRun({ workflow: monitorThrowsWorkflow, initialPrompt: 'go', autoRun: true })
monitorBroke = await runner.waitForSettled(monitorBroke.id, TIMEOUT)
assert.equal(monitorBroke.status, 'completed',
  'a monitor that throws must not fail an already-successful step (C1)')
const mStep = monitorBroke.steps.find(s => s.stepId === 'm')
assert.equal(mStep.status, 'completed', 'the step itself stays completed, not failed')
assert.equal(mStep.output, 'output of agent-m', 'the real output survives the broken monitor')
assert.match(mStep.monitorNote, /Monitor failed/, 'the failure is recorded as a note, not an error')

// ── 8. respondToRun on a failing reply skips downstream steps, not pending (C2) ──
let respondCallCount = 0
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'agent-a') {
    respondCallCount += 1
    if (respondCallCount === 2) throw new Error('a exploded on reply')
    return `output of ${agentSlug}`
  }
  return `output of ${agentSlug}`
})
let toFail = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
toFail = await runner.waitForSettled(toFail.id, TIMEOUT)
assert.equal(toFail.status, 'paused')
assert.deepEqual(toFail.currentStepIds, ['a'])
toFail = await runner.respondToRun(toFail.id, 'try again')
toFail = await runner.waitForSettled(toFail.id, TIMEOUT)
assert.equal(toFail.status, 'failed')
assert.equal(toFail.steps.find(s => s.stepId === 'a').status, 'failed')
for (const stepId of ['b', 'c', 'd']) {
  assert.equal(toFail.steps.find(s => s.stepId === stepId).status, 'skipped',
    `${stepId} must be skipped, not left pending, after a failing respondToRun (C2)`)
}

// ── 9. respondToRun completing the final step settles as completed, not paused (C3) ──
// A RETRY verdict re-arms the same node and (since autoRun is off) pauses on it -
// currentStepIds and nextStepIds both ['r']. Replying re-runs it; this time the
// monitor says CONTINUE, there is nothing left downstream, and the graph is done.
const retryOnceWorkflow = {
  slug: 'retry-once', name: 'Retry Once',
  steps: [{ id: 'r', agentSlug: 'agent-r', label: 'R', next: [], monitorSlug: 'monitor-r', maxVisits: 3 }],
}
let monitorCall = 0
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'monitor-r') {
    monitorCall += 1
    return monitorCall === 1 ? 'Needs work.\nVERDICT: RETRY' : 'Looks good.\nVERDICT: CONTINUE'
  }
  return `output of ${agentSlug}`
})
let toComplete = await runner.startRun({ workflow: retryOnceWorkflow, initialPrompt: 'go', autoRun: false })
toComplete = await runner.waitForSettled(toComplete.id, TIMEOUT)
assert.equal(toComplete.status, 'paused', 'a RETRY verdict re-arms the node and pauses for review')
assert.deepEqual(toComplete.currentStepIds, ['r'])
assert.deepEqual(toComplete.nextStepIds, ['r'])
toComplete = await runner.respondToRun(toComplete.id, 'please redo')
toComplete = await runner.waitForSettled(toComplete.id, TIMEOUT)
assert.equal(toComplete.status, 'completed',
  "respondToRun completing the graph's final step must settle as completed, not paused (C3)")

// ── 10. stopRun on an already-terminal run is a no-op (C5) ────────────────────
runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
let alreadyDone = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })
alreadyDone = await runner.waitForSettled(alreadyDone.id, TIMEOUT)
assert.equal(alreadyDone.status, 'completed')
const afterStop = await runner.stopRun(alreadyDone.id)
assert.equal(afterStop.status, 'completed', 'stopRun on an already-completed run leaves it completed (C5)')
assert.equal(afterStop.endedAt, alreadyDone.endedAt, 'the real outcome is not overwritten')

// ── 11. A fan-out wave genuinely overlaps, not just runs back-to-back (C4) ────
const timeline = []
runner.setAgentCaller(async (agentSlug) => {
  timeline.push({ agentSlug, event: 'start', t: Date.now() })
  await new Promise(resolve => setTimeout(resolve, agentSlug === 'agent-b' ? 60 : 10))
  timeline.push({ agentSlug, event: 'end', t: Date.now() })
  return `output of ${agentSlug}`
})
let concurrent = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
concurrent = await runner.waitForSettled(concurrent.id, TIMEOUT) // wave 1: a alone
concurrent = await runner.continueRun(concurrent.id)
concurrent = await runner.waitForSettled(concurrent.id, TIMEOUT) // wave 2: b and c, the fan-out
assert.deepEqual(concurrent.currentStepIds.sort(), ['b', 'c'],
  'currentStepIds holds the WHOLE wave once it settles, not just whichever node finished last (C4)')
const bStart = timeline.find(e => e.agentSlug === 'agent-b' && e.event === 'start').t
const bEnd = timeline.find(e => e.agentSlug === 'agent-b' && e.event === 'end').t
const cStart = timeline.find(e => e.agentSlug === 'agent-c' && e.event === 'start').t
assert.ok(cStart < bEnd,
  'agent-c started before agent-b finished - the wave ran concurrently, not sequentially (C4)')

// contextMode 'ancestors' reaches past the immediate predecessors.
// This is THE regression guard for the defect this change exists to fix: the
// evidence step could not see the pre-fix FAIL output, because that output
// belonged to a step three hops upstream.
{
  const chain = {
    slug: 'chain', name: 'Chain',
    steps: [
      { id: 's1', agentSlug: 'a1', label: 'One', next: ['s2'] },
      { id: 's2', agentSlug: 'a2', label: 'Two', next: ['s3'] },
      { id: 's3', agentSlug: 'a3', label: 'Three', next: ['s4'] },
      { id: 's4', agentSlug: 'a4', label: 'Four', next: [], contextMode: 'ancestors' },
    ],
  }
  runner.setAgentCaller(async agentSlug => `OUTPUT-OF-${agentSlug}`)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const s4 = r.steps.find(s => s.stepId === 's4').input
  assert.ok(s4.includes('OUTPUT-OF-a1'), 'ancestors mode reaches the far ancestor')
  assert.ok(s4.includes('OUTPUT-OF-a3'), 'ancestors mode still includes the direct predecessor')

  // And the default is unchanged.
  const plain = { ...chain, slug: 'plain', steps: chain.steps.map(s => ({ ...s, contextMode: undefined })) }
  const r2 = await runner.waitForSettled(
    (await runner.startRun({ workflow: plain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const p4 = r2.steps.find(s => s.stepId === 's4').input
  assert.ok(!p4.includes('OUTPUT-OF-a1'), 'default mode does NOT reach the far ancestor')
  assert.ok(p4.includes('OUTPUT-OF-a3'), 'default mode includes the direct predecessor')
}

// A large upstream output under DEFAULT contextMode is passed through whole.
// This is the guard for the regression the budget nearly introduced: capping
// the default path would silently change every existing workflow whose step
// emits a full diff or log dump.
{
  const huge = 'Y'.repeat(100000)
  const two = {
    slug: 'passthrough', name: 'Passthrough',
    steps: [
      { id: 'p1', agentSlug: 'p-1', label: 'One', next: ['p2'] },
      { id: 'p2', agentSlug: 'p-2', label: 'Two', next: [] },
    ],
  }
  runner.setAgentCaller(async () => huge)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: two, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const input = r.steps.find(s => s.stepId === 'p2').input
  assert.ok(input.includes(huge), 'default mode passes a large upstream output through whole')
  assert.ok(!input.includes('[truncated'), 'default mode never truncates')
}

// The join is capped, and the cap never drops a whole ancestor.
{
  const big = 'X'.repeat(200000)
  const chain = {
    slug: 'big', name: 'Big',
    steps: [
      { id: 'b1', agentSlug: 'big-1', label: 'One', next: ['b2'] },
      { id: 'b2', agentSlug: 'big-2', label: 'Two', next: ['b3'] },
      { id: 'b3', agentSlug: 'big-3', label: 'Three', next: [], contextMode: 'ancestors' },
    ],
  }
  runner.setAgentCaller(async agentSlug => `MARKER-${agentSlug}\n${big}`)
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const input = r.steps.find(s => s.stepId === 'b3').input
  assert.ok(input.length < 200000, 'joined context is capped')
  assert.ok(input.includes('[truncated'), 'truncation is marked, never silent')
  // Every ancestor still contributes. Budget is shared evenly rather than
  // spent first-come, so a long early step cannot squeeze a later one out —
  // and the marker text an agent must find is at the START of its output.
  assert.ok(input.includes('MARKER-big-1'), 'the far ancestor is still present')
  assert.ok(input.includes('MARKER-big-2'), 'the near ancestor is still present')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('workflowRunner: all assertions passed')
