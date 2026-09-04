/**
 * Self-check for the server-side runner. A stub agent caller drives the loop,
 * so the scheduler, persistence and pause/continue semantics are testable
 * without a single API call.
 *
 *   node scripts/test-workflow-runner.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runner-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runner-artifacts-'))

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

/**
 * An agent's only channel for learning where to write is the artifact
 * header prepended to its input (`Write every artifact you produce into:
 * <dir>`). Tests use that same channel to make the stub agent poison
 * meta.json with a false claim mid-run — the one thing only
 * finalizeRunArtifacts, not initRunArtifacts's seed, can undo. Asserting
 * identity/cost alone without this would pass from the seed even with
 * finalize disabled entirely.
 */
function poisonMetaFromInput(input) {
  const m = input.match(/Write every artifact you produce into: (\S+)/)
  if (!m) return
  const metaPath = join(m[1], 'meta.json')
  const cur = JSON.parse(readFileSync(metaPath, 'utf8'))
  writeFileSync(metaPath, JSON.stringify({
    ...cur,
    identity: 'agent-overwrote-this',
    cost: { ...cur.cost, input_tokens: 999999 },
    ticket: 'AGENT-1', // an agent-owned key; must SURVIVE finalize
  }, null, 2))
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

// The runner writes its own record of every run — and finalize's
// re-assertion of the runner-owned keys is what an assertion here actually
// has to prove, not initRunArtifacts's seed. The stub agent poisons
// meta.json mid-run; the settled run's meta.json must show the poison
// overwritten, not merely present from the start.
{
  runner.setAgentCaller(async (agentSlug, input) => {
    poisonMetaFromInput(input)
    return `output of ${agentSlug}`
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  assert.ok(existsSync(join(dir, 'meta.json')), 'meta.json exists after a run')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.identity, 'demo', 'finalize re-asserts the runner identity over the agent claim')
  assert.equal(meta.cost.input_tokens, 0, 'a self-reported token count is overwritten, not trusted')
  assert.equal(meta.ticket, 'AGENT-1', 'agent-owned keys survive finalize')
  assert.ok(existsSync(join(dir, 'steps', 'step-01-agent-a.json')), 'per-step record exists')
  const first = JSON.parse(readFileSync(join(dir, 'steps', 'step-01-agent-a.json'), 'utf8'))
  assert.equal(first.output, 'output of agent-a', 'the step record holds the real output')
  // And the agent was told where to write.
  assert.ok(r.steps.find(s => s.stepId === 'a').input.includes(dir),
    'every step input names the artifacts directory')
}

// finalizeRunArtifacts now lives in exactly one place — publish(), gated on a
// terminal status — rather than at each of the six-plus call sites a run can
// settle from. A run settled purely through respondToRun (never touching
// runWave's terminal branches) must still get a finalized meta.json — proven
// by poisoning it mid-run and checking the poison is gone, not merely by
// checking fields the seed already sets.
{
  // Same shape as the C3 retry-once workflow above: a RETRY verdict re-arms
  // the sole node and pauses on it, so the run's eventual 'completed' comes
  // entirely from respondToRun's own isFinished check — runWave's terminal
  // branches are never reached at all for this run.
  const respondWorkflow = {
    slug: 'respond-settle', name: 'Respond Settle',
    steps: [{ id: 'only', agentSlug: 'agent-only', label: 'Only', next: [], monitorSlug: 'monitor-only', maxVisits: 3 }],
  }
  let monitorCalls = 0
  runner.setAgentCaller(async (agentSlug, input) => {
    poisonMetaFromInput(input)
    if (agentSlug === 'monitor-only') {
      monitorCalls += 1
      return monitorCalls === 1 ? 'Needs work.\nVERDICT: RETRY' : 'Looks good.\nVERDICT: CONTINUE'
    }
    return `output of ${agentSlug}`
  })
  let r = await runner.startRun({ workflow: respondWorkflow, initialPrompt: 'go', autoRun: false })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'paused', 'a RETRY verdict re-arms the node and pauses for review')
  r = await runner.respondToRun(r.id, 'please redo')
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'completed', 'a single-step run settles via respondToRun alone')
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.identity, 'respond-settle',
    'finalize re-asserts the runner identity over the agent claim, with no call site in respondToRun itself')
  assert.equal(meta.cost.input_tokens, 0, 'a self-reported token count is overwritten, not trusted')
  assert.equal(meta.ticket, 'AGENT-1', 'agent-owned keys survive finalize')
}

// stopRun is a second terminal path with no wave-loop coverage; it must
// finalize too — same poison-and-check proof as above.
{
  runner.setAgentCaller(async (agentSlug, input) => {
    poisonMetaFromInput(input)
    return `output of ${agentSlug}`
  })
  let r = await runner.startRun({ workflow, initialPrompt: 'go', autoRun: false })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'paused')
  r = await runner.stopRun(r.id)
  assert.equal(r.status, 'stopped', 'stopRun actually stops a paused run')
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.identity, 'demo', 'finalize re-asserts the runner identity over the agent claim')
  assert.equal(meta.cost.input_tokens, 0, 'a self-reported token count is overwritten, not trusted')
  assert.equal(meta.ticket, 'AGENT-1', 'agent-owned keys survive finalize')
}

// meta.json's `model` now reflects the model(s) steps actually reported,
// not an asserted constant (fix round 3). Frontmatter->model resolution
// itself is covered separately by resolveModel()'s pure tests in
// scripts/test-agent-tool-policy.mjs; this proves the runner RECORDS
// whatever the agent caller reports, end to end through RunStep.model and
// meta.json.
{
  const singleModelWorkflow = {
    slug: 'model-single', name: 'Model Single',
    steps: [{ id: 'only', agentSlug: 'agent-declares-opus', label: 'Only', next: [] }],
  }
  // Stands in for callAgent() resolving frontmatter `model: opus` (see
  // resolveModel() and its tests) and reporting it back, exactly the shape
  // normalizeAgentResult() in workflowRunner.ts expects.
  runner.setAgentCaller(async agentSlug => ({ output: `output of ${agentSlug}`, model: 'opus' }))
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: singleModelWorkflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const step = r.steps.find(s => s.stepId === 'only')
  assert.equal(step.model, 'opus', 'the reported model is recorded on the step')
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.model, 'opus', 'a single-model run records that model, not a constant default')
  const stepFile = JSON.parse(
    readFileSync(join(dir, 'steps', 'step-01-agent-declares-opus.json'), 'utf8'))
  assert.equal(stepFile.model, 'opus', 'the per-step artifact records the model too')
}

{
  const mixedModelWorkflow = {
    slug: 'model-mixed', name: 'Model Mixed',
    steps: [
      { id: 'x', agentSlug: 'agent-x', label: 'X', next: ['y'] },
      { id: 'y', agentSlug: 'agent-y', label: 'Y', next: [] },
    ],
  }
  runner.setAgentCaller(async (agentSlug) => {
    const model = agentSlug === 'agent-x' ? 'opus' : 'haiku'
    return { output: `output of ${agentSlug}`, model }
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: mixedModelWorkflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.model, 'opus+haiku', 'a mixed-model run joins the distinct values, not a single pick')
}

// PIPELINE-HALT stops the run exactly as a throw does.
{
  const haltModel = 'opus'
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug === 'agent-b') {
      return { output: 'could not reach the database\nPIPELINE-HALT: stack unavailable', model: haltModel }
    }
    return `output of ${agentSlug}`
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  assert.equal(r.status, 'failed', 'a halted step fails the run')
  const b = r.steps.find(s => s.stepId === 'b')
  assert.equal(b.status, 'failed', 'the halting step is failed, not completed')
  assert.match(b.error, /stack unavailable/, 'the reason is preserved in the step error')
  assert.ok(b.output.includes('PIPELINE-HALT'), 'the output is kept for the record')
  assert.equal(b.model, haltModel,
    'the model that actually ran is known and recorded even though the step halted')
  assert.equal(r.steps.find(s => s.stepId === 'd').status, 'skipped',
    'downstream steps are skipped, not left pending in a dead run')
}

// Real token usage flows end to end: agentCaller.ts's { output, model, usage }
// shape all the way through executeNode -> RunStep.usage -> runArtifacts.ts's
// summed cost.input_tokens/output_tokens in meta.json. Two steps, two
// distinct usage figures, so a bug that reported only the LAST step's usage
// (instead of summing) would still be caught.
{
  const usageWorkflow = {
    slug: 'usage-sum', name: 'Usage Sum',
    steps: [
      { id: 'x', agentSlug: 'agent-x', label: 'X', next: ['y'] },
      { id: 'y', agentSlug: 'agent-y', label: 'Y', next: [] },
    ],
  }
  runner.setAgentCaller(async (agentSlug) => {
    const usage = agentSlug === 'agent-x'
      ? { input_tokens: 100, output_tokens: 10 }
      : { input_tokens: 250, output_tokens: 40 }
    return { output: `output of ${agentSlug}`, model: 'sonnet', usage }
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: usageWorkflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  const stepX = r.steps.find(s => s.stepId === 'x')
  assert.deepEqual(stepX.usage, { input_tokens: 100, output_tokens: 10 },
    'the real caller\'s usage is recorded on the step that reported it')
  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.equal(meta.cost.input_tokens, 350, 'cost.input_tokens sums real usage across every step, not just the last one')
  assert.equal(meta.cost.output_tokens, 50, 'cost.output_tokens sums the same way')
}

// runWave's empty-wave branch: a workflow with no steps at all has nothing
// ready on the very first call, so runWave must complete the run through
// its OWN "no wave" branch, not the isFinished() branch reached after a wave
// actually runs. No prior test in this suite (old or new) exercises this -
// every other run has at least one step, so readyNodes() is never empty on
// entry.
{
  const emptyWorkflow = { slug: 'empty', name: 'Empty', steps: [] }
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow: emptyWorkflow, initialPrompt: 'go', autoRun: true })).id, TIMEOUT)
  assert.equal(r.status, 'completed', 'a workflow with no steps completes via the empty-wave branch')
  assert.deepEqual(r.currentStepIds, [], 'no step ever ran')
  assert.ok(r.endedAt, 'the empty-wave branch still records when the run ended')
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('workflowRunner: all assertions passed')
