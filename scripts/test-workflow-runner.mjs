/**
 * Self-check for the server-side runner. A stub agent caller drives the loop,
 * so the scheduler, persistence and pause/continue semantics are testable
 * without a single API call.
 *
 *   node scripts/test-workflow-runner.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runner-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runner-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
// The runner's own checks are about the runner: whether THIS machine has a
// checkout, a docker daemon or the plugin installed is what
// scripts/test-preflight.mjs asserts. One case below restores the real gate.
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
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
const promptRun = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
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
let run = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
let auto = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
auto = await runner.waitForSettled(auto.id, TIMEOUT)
assert.equal(auto.status, 'completed', 'auto-run finishes on its own')
assert.equal(calls.length, 4, 'every step ran exactly once')

// ── 5. A failing step stops the run and skips the rest ────────────────────
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'agent-b') throw new Error('agent-b exploded')
  return `output of ${agentSlug}`
})
let failing = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
failing = await runner.waitForSettled(failing.id, TIMEOUT)
assert.equal(failing.status, 'failed')
assert.equal(failing.steps.find(s => s.stepId === 'b').status, 'failed')
assert.match(failing.steps.find(s => s.stepId === 'b').error, /exploded/)
assert.equal(failing.steps.find(s => s.stepId === 'd').status, 'skipped',
  'a step downstream of a failure is skipped, never left pending')

// ── 6. Subscribers see progress ───────────────────────────────────────────
runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
const seen = []
let started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
let monitorBroke = await runner.startRun({ workflow: monitorThrowsWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
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
let toFail = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
let toComplete = await runner.startRun({ workflow: retryOnceWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
toComplete = await runner.waitForSettled(toComplete.id, TIMEOUT)
assert.equal(toComplete.status, 'paused', 'a RETRY verdict re-arms the node and pauses for review')
assert.deepEqual(toComplete.currentStepIds, ['r'])
assert.deepEqual(toComplete.nextStepIds, ['r'])
toComplete = await runner.respondToRun(toComplete.id, 'please redo')
toComplete = await runner.waitForSettled(toComplete.id, TIMEOUT)
assert.equal(toComplete.status, 'completed',
  "respondToRun completing the graph's final step must settle as completed, not paused (C3)")

// A RETRY verdict must not erase the attempt it retried: the deficient
// output and the monitor's note that triggered the retry get their own
// snapshot file, distinct from the step's final artifact - otherwise the
// eventual completed write (same stepId/agentSlug, same filename) silently
// overwrites it, and a reviewer sees cost.attempts: 2 with only one file.
{
  const stepsDir = join(process.env.AGENT_RUNS_DIR, toComplete.id, 'artifacts', 'steps')
  const names = readdirSync(stepsDir)
  const retryFile = names.find(n => n.includes('retry-1'))
  assert.ok(retryFile, `a retry-1 snapshot file exists alongside the final one: ${names.join(', ')}`)
  const retrySnapshot = JSON.parse(readFileSync(join(stepsDir, retryFile), 'utf8'))
  assert.equal(retrySnapshot.monitorVerdict, 'RETRY', 'the snapshot records the RETRY verdict, not the eventual CONTINUE')
  assert.match(retrySnapshot.monitorNote, /Needs work/, "the monitor's note that triggered the retry is preserved")

  const finalFile = names.find(n => !n.includes('retry'))
  const finalRecord = JSON.parse(readFileSync(join(stepsDir, finalFile), 'utf8'))
  assert.equal(finalRecord.monitorVerdict, 'CONTINUE', 'the final artifact reflects the attempt that actually completed')
}

// ── 10. stopRun on an already-terminal run is a no-op (C5) ────────────────────
runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
let alreadyDone = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
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
let concurrent = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  const s4 = r.steps.find(s => s.stepId === 's4').input
  assert.ok(s4.includes('OUTPUT-OF-a1'), 'ancestors mode reaches the far ancestor')
  assert.ok(s4.includes('OUTPUT-OF-a3'), 'ancestors mode still includes the direct predecessor')

  // And the default is unchanged.
  const plain = { ...chain, slug: 'plain', steps: chain.steps.map(s => ({ ...s, contextMode: undefined })) }
  const r2 = await runner.waitForSettled(
    (await runner.startRun({ workflow: plain, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow: two, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow: chain, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
  let r = await runner.startRun({ workflow: respondWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
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
    (await runner.startRun({ workflow: singleModelWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow: mixedModelWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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

// PIPELINE-SKIP is a SUCCESS: the run continues, downstream steps still run,
// and only the recorded status differs. This is the distinction that makes the
// outcome worth having - a step that skipped must not read, in the evidence
// bundle, like a step that failed OR like one that did the work.
{
  const skipModel = 'haiku'
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug === 'agent-b') {
      return {
        output: 'ran `grep -ci eswatini docker-compose.crm.yml` -> 8, already present\nPIPELINE-SKIP: capability already in place',
        model: skipModel,
      }
    }
    return `output of ${agentSlug}`
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)

  assert.equal(r.status, 'completed', 'a skipped step does not fail the run - that is the whole point')
  const b = r.steps.find(s => s.stepId === 'b')
  assert.equal(b.status, 'skipped', 'the skipping step records skipped, not completed')
  assert.equal(b.skipReason, 'capability already in place', 'the stated reason is preserved')
  assert.equal(b.error, undefined, 'a skip is not an error')
  assert.equal(b.model, skipModel, 'the model that ran is still recorded')
  assert.ok(b.output.includes('PIPELINE-SKIP'), 'the output is kept for the record')

  // The load-bearing assertion. A halt marks downstream steps `skipped`
  // because the run died; a self-declared skip must instead let them RUN.
  // Those two produce the same status on `d` if the scheduler treats them
  // alike, so assert on d's own completion, not merely that it is not pending.
  const d = r.steps.find(s => s.stepId === 'd')
  assert.equal(d.status, 'completed',
    'downstream of a skip must actually run - a skip schedules like a completed step, unlike a halt')
  assert.ok(d.output.includes('output of'), 'the downstream step produced real output')
}

// A run that names a ticket tells that ticket it finished. The notifier is
// gated (it posts nothing without JIRA_POST_ENABLED=1 and real credentials),
// so what is asserted here is the wiring: a completed run with a ticketKey
// renders and RECORDS the comment as jira-comment.json beside its evidence.
// Without a ticket key nothing is written - an ad-hoc run against a scratch
// brief must not invent an issue to comment on.
{
  runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)

  const withTicket = await runner.waitForSettled(
    (await runner.startRun({
      workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
      ticketKey: 'DEVOPS-15',
    })).id, TIMEOUT)
  assert.equal(withTicket.status, 'completed')
  assert.equal(withTicket.ticketKey, 'DEVOPS-15',
    'the ticket key is runner-owned provenance carried onto the run, like `watch`')
  const notified = join(process.env.AGENT_RUNS_DIR, withTicket.id, 'artifacts', 'jira-comment.json')
  assert.ok(existsSync(notified),
    'a completed run naming a ticket must record the comment it would post')
  const recorded = JSON.parse(readFileSync(notified, 'utf8'))
  assert.match(JSON.stringify(recorded), /DEVOPS-15/,
    'the recorded comment names the ticket it is for')

  const noTicket = await runner.waitForSettled(
    (await runner.startRun({
      workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
    })).id, TIMEOUT)
  assert.equal(noTicket.status, 'completed')
  assert.ok(!existsSync(join(process.env.AGENT_RUNS_DIR, noTicket.id, 'artifacts', 'jira-comment.json')),
    'no ticket key: nothing is recorded, and no issue is invented to comment on')
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
    (await runner.startRun({ workflow: usageWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
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
    (await runner.startRun({ workflow: emptyWorkflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(r.status, 'completed', 'a workflow with no steps completes via the empty-wave branch')
  assert.deepEqual(r.currentStepIds, [], 'no step ever ran')
  assert.ok(r.endedAt, 'the empty-wave branch still records when the run ended')
}


// ── 9. restartRun re-runs a failed step and its descendants only ──────────
// The runner loads the workflow from disk to rehydrate, so write it there.
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps }))

// Earlier cases leave paused runs of this workflow behind; restart honours the
// one-active-run rule, so settle them first.
for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)

let explode = true
runner.setAgentCaller(async (agentSlug, input) => {
  calls.push(agentSlug)
  if (agentSlug === 'agent-b' && explode) throw new Error('agent-b exploded')
  return `output of ${agentSlug} <- ${input.slice(-40).replace(/\n/g, ' ')}`
})
calls.length = 0
let rst = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
rst = await runner.waitForSettled(rst.id, TIMEOUT)
assert.equal(rst.status, 'failed')
const aOutput = rst.steps.find(s => s.stepId === 'a').output

// A restart while nothing is live is the realistic case: simulate a server
// restart by forgetting the in-memory record before restarting.
runner._dropLive(rst.id)
explode = false
calls.length = 0
// The template sync rewrites the workflow file with fresh step ids. A restart
// must still find its way: same agents in the same order means the same run.
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'demo.json'), JSON.stringify({
  name: workflow.name, description: '',
  steps: workflow.steps.map(s => ({ ...s, id: `new-${s.id}`, next: s.next.map(n => `new-${n}`) })),
}))
await assert.rejects(runner.restartRun(rst.id, 'nope'), /nope/, 'unknown step id is refused')
rst = await runner.restartRun(rst.id, 'b')
assert.equal(rst.status, 'running', 'restart drives the run immediately')
rst = await runner.waitForSettled(rst.id, TIMEOUT)
assert.equal(rst.status, 'completed', 'restart from b runs b and d to completion')
assert.deepEqual(calls.sort(), ['agent-b', 'agent-d'], 'only the failed step and its descendants re-run')
assert.equal(rst.steps.find(s => s.stepId === 'a').output, aOutput, 'a kept its output')
assert.equal(rst.steps.find(s => s.stepId === 'c').status, 'completed', 'c, not downstream of b, is untouched')
assert.equal(rst.steps.find(s => s.stepId === 'b').visits, 2, 'visits keep counting across a restart')
const stepFiles = readdirSync(join(process.env.AGENT_RUNS_DIR, rst.id, 'artifacts', 'steps'))
assert.ok(stepFiles.some(f => /step-02-.*-restart-1\.json$/.test(f)), 'the failed attempt is snapshotted before the restart')

// A genuinely different workflow (extra step) is refused, not guessed at.
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'demo.json'), JSON.stringify({
  name: workflow.name, description: '',
  steps: [...workflow.steps, { id: 'e', agentSlug: 'agent-e', label: 'E', next: [] }],
}))
runner._dropLive(rst.id)
await assert.rejects(runner.restartRun(rst.id, 'b'), /changed since this run started/, 'a reshaped workflow refuses restart')
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps }))

// Refused while running.
runner.setAgentCaller(async (agentSlug) => { await new Promise(r => setTimeout(r, 300)); return `slow ${agentSlug}` })
let busy = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
await assert.rejects(runner.restartRun(busy.id, 'a'), /running/, 'restart refused while the run is running')
await runner.waitForSettled(busy.id, TIMEOUT)

// ── 9b. a restart does not charge the run for the time it sat failed ──────
//
// Reported from the runs page: a run failed, was restarted later, and its
// Duration column kept climbing from the FIRST attempt's start - 73 minutes
// against twelve minutes of agent work. Duration was `endedAt - startedAt`,
// and a restart resumes the same run id, so the gap was being reported as run
// time. The run clock (shared/utils/runClock.ts) counts only the stretches the
// run was actually running.
{
  const { runElapsedMs } = await import('../shared/utils/runClock.ts')
  const { summarizeRunCost } = await import('../server/utils/costReport.ts')
  const HOUR = 3600_000

  explode = true
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug === 'agent-b' && explode) throw new Error('agent-b exploded')
    return `output of ${agentSlug}`
  })
  let gap = await runner.waitForSettled((await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })).id, TIMEOUT)
  assert.equal(gap.status, 'failed')
  const workedFirstAttempt = runElapsedMs(gap)

  // The run now sits failed for an hour. Nothing can move the test's clock
  // forward, so move the run's timestamps back instead - the same record a
  // person would be looking at the next time they opened the page. activeMs is
  // a DURATION, not a timestamp, and deliberately stays as measured.
  const shift = t => (typeof t === 'number' ? t - HOUR : t)
  await store.saveRun({
    ...gap,
    startedAt: shift(gap.startedAt),
    endedAt: shift(gap.endedAt),
    runningSince: shift(gap.runningSince),
    steps: gap.steps.map(st => ({
      ...st,
      startedAt: shift(st.startedAt),
      completedAt: shift(st.completedAt),
      lastActivityAt: shift(st.lastActivityAt),
    })),
  })
  const failedForAnHour = await store.getRun(gap.id)
  assert.ok(Date.now() - failedForAnHour.startedAt > HOUR, 'the run has existed for over an hour')
  assert.ok(runElapsedMs(failedForAnHour) < 60_000,
    'a run sitting failed does not accrue duration while it waits for a person')

  explode = false
  runner._dropLive(gap.id)
  gap = await runner.waitForSettled((await runner.restartRun(gap.id, 'b')).id, TIMEOUT)
  assert.equal(gap.status, 'completed', 'the restart still runs the run to completion')
  assert.ok(gap.endedAt - gap.startedAt > HOUR,
    'the wall clock between first start and final end really is over an hour')
  assert.ok(runElapsedMs(gap) < 60_000,
    'but the duration is the work, not the hour the run spent waiting to be restarted')
  assert.ok(runElapsedMs(gap) >= workedFirstAttempt,
    'and the first attempt\'s own time is still counted, not discarded by the restart')
  assert.equal(summarizeRunCost(gap).wall_clock_min, 0,
    'the cost report and the evidence bundle read the same clock, not the hour-wide span')
}

// ── 10. continueRun resumes an interrupted run from the executing step ────
runner.setAgentCaller(async (agentSlug) => { calls.push(agentSlug); return `output of ${agentSlug}` })
calls.length = 0
let intr = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
intr = await runner.waitForSettled(intr.id, TIMEOUT)          // paused after a
// Fake a dead owner: rewrite the record with a pid that cannot exist and a
// step frozen as running, then forget the live record.
{
  const p = join(process.env.CLAUDE_DIR, 'workflow-runs', `${intr.id}.json`)
  const rec = JSON.parse(readFileSync(p, 'utf8'))
  rec.status = 'running'; rec.pid = 2 ** 22 + 7
  rec.currentStepIds = ['b']
  rec.steps.find(s => s.stepId === 'b').status = 'running'
  writeFileSync(p, JSON.stringify(rec))
  runner._dropLive(intr.id)
}
assert.equal((await store.getRun(intr.id)).status, 'interrupted', 'a dead pid reads as interrupted')
calls.length = 0
intr = await runner.continueRun(intr.id)
assert.equal(intr.status, 'running', 'continue on an interrupted run restarts it')
intr = await runner.waitForSettled(intr.id, TIMEOUT)
assert.ok(calls.includes('agent-b'), 'the step that was executing re-runs')
assert.ok(!calls.includes('agent-a'), 'completed steps do not re-run')

// ── 11. usage totals and cost are runner-owned facts on the run ───────────
for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
runner.setAgentCaller(async (agentSlug) => ({ output: `out ${agentSlug}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } }))
let costed = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
costed = await runner.waitForSettled(costed.id, TIMEOUT)
assert.equal(costed.status, 'completed')
assert.equal(costed.usage.input_tokens, 4000, 'input tokens summed over four steps')
assert.equal(costed.usage.output_tokens, 400)
assert.ok(costed.usage.usd > 0, 'a dollar estimate is computed from the model that ran')

// ── 12. a token budget pauses a run before the next wave and asks ─────────
process.env.AGENT_RUN_MAX_TOKENS = '1500'
let capped = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
capped = await runner.waitForSettled(capped.id, TIMEOUT)
assert.equal(capped.status, 'paused', 'reaching the budget pauses the run instead of failing it')
assert.equal(capped.question?.kind, 'approval')
assert.equal(capped.question?.reason, 'budget', 'the question says it is the budget asking')
assert.match(capped.question?.text ?? '', /budget/i, 'and why')
assert.ok(capped.steps.some(s => s.status === 'pending'), 'later steps wait; nothing is skipped')
const capBefore = capped.budget.maxTokens
// Continuing is the operator granting another allowance: the cap rises and the run finishes.
await runner.continueRun(capped.id)
capped = await runner.waitForSettled(capped.id, TIMEOUT)
delete process.env.AGENT_RUN_MAX_TOKENS
assert.equal(capped.status, 'completed', 'the run finishes on the extended budget')
assert.ok(capped.budget.maxTokens > capBefore, 'the cap was raised, not ignored')

// ── 13. stopRun aborts the agent call in flight ───────────────────────────
runner.setAgentCaller((agentSlug, input, projectDir, { signal } = {}) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(`late ${agentSlug}`), 4000)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
}))
let inflight = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
await new Promise(r => setTimeout(r, 200))
const t0 = Date.now()
await runner.stopRun(inflight.id)
inflight = await runner.waitForSettled(inflight.id, TIMEOUT)
assert.ok(Date.now() - t0 < 2000, 'stop returns without waiting for the agent to finish on its own')
assert.equal(inflight.status, 'stopped', 'an aborted wave leaves the run stopped, not failed')
// The stop publishes first; the aborted step's own failure lands a moment later.
for (let i = 0; i < 20 && (await store.getRun(inflight.id)).steps.find(s => s.stepId === 'a').status === 'running'; i++) await new Promise(r => setTimeout(r, 50))
inflight = await store.getRun(inflight.id)
assert.equal(inflight.status, 'stopped', 'the step failure does not turn a stopped run into a failed one')
assert.equal(inflight.steps.find(s => s.stepId === 'a').status, 'failed', 'the aborted step records a failure, not a completion')
assert.match(inflight.steps.find(s => s.stepId === 'a').error, /stopped/i)

// ── 14. a restart note reaches the restarted step's input ─────────────────
for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
const inputsSeen = {}
let cFailedOnce = false
runner.setAgentCaller(async (agentSlug, input) => {
  inputsSeen[agentSlug] = input
  if (agentSlug === 'agent-c' && !cFailedOnce) { cFailedOnce = true; throw new Error('c failed once') }
  return `out ${agentSlug}`
})
let noted = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
noted = await runner.waitForSettled(noted.id, TIMEOUT)
assert.equal(noted.status, 'failed')
noted = await runner.restartRun(noted.id, 'c', 'Use the staging CRM, not production')
noted = await runner.waitForSettled(noted.id, TIMEOUT)
assert.equal(noted.status, 'completed')
assert.match(inputsSeen['agent-c'], /Operator note:\s*Use the staging CRM/, 'the note is in the restarted step input')
assert.match(inputsSeen['agent-c'], /Your previous attempt/, 'the previous attempt travels with it, as a monitor retry would')

// ── 15. a paused run whose process was replaced continues from disk ───────
// In a container every server is pid 1, so a dead owner cannot be told apart
// by pid. The run must still continue once nothing in memory knows it.
runner.setAgentCaller(async (agentSlug) => { calls.push(agentSlug); return `out ${agentSlug}` })
for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
let orphan = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
orphan = await runner.waitForSettled(orphan.id, TIMEOUT)
assert.equal(orphan.status, 'paused')
runner._dropLive(orphan.id)
calls.length = 0
orphan = await runner.continueRun(orphan.id)
assert.equal(orphan.status, 'running', 'a paused run with no live record is rehydrated and continued')
orphan = await runner.waitForSettled(orphan.id, TIMEOUT)
assert.deepEqual(calls.sort(), ['agent-b', 'agent-c'], 'the queued wave ran once')
{
  const p = join(process.env.CLAUDE_DIR, 'workflow-runs', `${orphan.id}.json`)
  const rec = JSON.parse(readFileSync(p, 'utf8'))
  rec.status = 'running'; rec.bootId = 'some-other-process'; rec.currentStepIds = ['d']
  rec.steps.find(s => s.stepId === 'd').status = 'running'
  writeFileSync(p, JSON.stringify(rec))
  runner._dropLive(orphan.id)
}
assert.equal((await store.getRun(orphan.id)).status, 'interrupted', 'a different boot id reads as interrupted even when the pid is alive')

// ── 16. the starter's environment reaches every agent call ────────────────
for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
runner.setEnvResolver(async (login) => (login === 'sandeep' ? { GH_TOKEN: 'gh-for-sandeep', JIRA_API_TOKEN: 'jira-for-sandeep' } : {}))
const envsSeen = []
runner.setAgentCaller(async (agentSlug, input, projectDir, { env } = {}) => { envsSeen.push(env); return `out ${agentSlug}` })
let owned = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'sandeep' })
owned = await runner.waitForSettled(owned.id, TIMEOUT)
assert.equal(owned.startedBy, 'sandeep', 'the run records who started it')
assert.equal(envsSeen.length, 4)
assert.ok(envsSeen.every(e => e?.GH_TOKEN === 'gh-for-sandeep' && e?.JIRA_API_TOKEN === 'jira-for-sandeep'), 'every agent call carries the starter identity')
let anon = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
anon = await runner.waitForSettled(anon.id, TIMEOUT)
assert.deepEqual(envsSeen[4], {}, 'no starter, no identity env')
// ── 17. a run refuses to start without somewhere to write evidence ────────
{
  const saved = process.env.AGENT_RUNS_DIR
  const blocker = join(tmpdir(), `runner-blocker-${process.pid}`)
  writeFileSync(blocker, '')
  process.env.AGENT_RUNS_DIR = join(blocker, 'runs')
  await assert.rejects(runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false }), /not writable/, 'the failure is one line at start, not an agent step later')
  process.env.AGENT_RUNS_DIR = saved
  rmSync(blocker, { force: true })
}

// ── 18. a run with a checkout gets its own branch and its ticket key ──────
{
  const projectDir = mkdtempSync(join(tmpdir(), 'runner-branch-'))
  git(projectDir, ['init', '-q', '-b', 'develop'])
  git(projectDir, ['config', 'user.email', 'test@example.invalid']); git(projectDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(projectDir, 'a.txt'), 'a\n'); git(projectDir, ['add', '.']); git(projectDir, ['commit', '-q', '-m', 'init'])
  runner.setAgentCaller(async (agentSlug) => `out ${agentSlug}`)
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  let br = await runner.startRun({ workflow, initialPrompt: 'CSUP-77: labels unprintable', watch: 'direct-invocation', autoRun: false, projectDir })
  assert.equal(br.ticketKey, 'CSUP-77', 'the ticket key is read from the prompt so the notifier can find the issue')
  assert.equal(br.branch, `fix/CSUP-77-${br.id.slice(0, 8)}`, 'the runner names the branch')
  assert.equal(br.projectDir, `${projectDir}@fix-CSUP-77-${br.id.slice(0, 8)}`, 'and works in a worktree beside the clone')
  assert.equal(git(br.projectDir, ['branch', '--show-current']), br.branch, 'checked out there before any agent runs')
  assert.equal(git(projectDir, ['branch', '--show-current']), 'develop', 'while the clone stays on its own branch')
  br = await runner.waitForSettled(br.id, TIMEOUT)

  // 18b. a step that owns its tests gets the plugin's unlock file in the checkout it works in, before it starts
  const seenUnlock = {}
  runner.setAgentCaller(async (agentSlug, input, dir) => { seenUnlock[agentSlug] = dir && existsSync(join(dir, '.agent', 'test-unlock.json')); return `out ${agentSlug}` })
  const unlocked = { ...workflow, slug: 'unlock-demo', steps: workflow.steps.map(s => s.id === 'b' ? { ...s, testsUnlocked: true } : s) }
  let ul = await runner.startRun({ workflow: unlocked, initialPrompt: 'CSUP-78: unlock', watch: 'direct-invocation', autoRun: true, projectDir })
  ul = await runner.waitForSettled(ul.id, TIMEOUT)
  assert.equal(ul.status, 'completed')
  assert.equal(seenUnlock['agent-a'], false, 'a step without the flag sees no unlock file')
  assert.equal(seenUnlock['agent-b'], true, 'the flagged step finds .agent/test-unlock.json in its worktree')
  const unlock = JSON.parse(readFileSync(join(ul.projectDir, '.agent', 'test-unlock.json'), 'utf8'))
  assert.match(unlock.reason, /writes tests and code together/, 'with the reason recorded for the evidence')
  rmSync(projectDir, { recursive: true, force: true })
}

// ── 18c. a failed preflight stops the run before any agent, and says why ──
// Four real runs each spent 20-60 minutes of paid model work discovering an
// environment defect. The gate turns that into seconds, and the reason has to
// survive on the record: a run that never started is exactly the one whose
// artifacts a person reads afterwards.
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  let called = 0
  runner.setAgentCaller(async (slug) => { called++; return `out ${slug}` })
  runner.setPreflight(async () => ({ at: Date.now(), checks: [
    { name: 'deployment compose', level: 'fail', detail: 'alepo-dev-team-infra is on branch main and has no docker-compose.pms.yml' },
    { name: 'docker', level: 'warn', detail: 'alepo-shared is missing' },
  ] }))
  let pf = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  assert.equal(pf.status, 'failed', 'a hard preflight failure fails the run at once')
  assert.match(pf.error, /^Preflight: deployment compose — .*docker-compose\.pms\.yml/, pf.error)
  assert.equal(called, 0, 'and not one agent turn was spent')
  assert.ok(pf.steps.every(s => s.status === 'skipped'), 'every step is settled as skipped, never left looking pending')
  assert.equal(pf.preflight.checks.length, 2, 'the whole report is on the record, warnings included')
  assert.ok(existsSync(join(process.env.AGENT_RUNS_DIR, pf.id, 'artifacts', 'meta.json')),
    'and the artifacts exist, because a run that never started is the one whose reason gets read')
  const stored = await store.getRun(pf.id)
  assert.equal(stored.preflight.checks[0].level, 'fail', 'the report survives on disk, not only in memory')

  // A warning-only report never blocks.
  runner.setPreflight(async () => ({ at: Date.now(), checks: [{ name: 'docker', level: 'warn', detail: 'alepo-shared is missing' }] }))
  let warned = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  warned = await runner.waitForSettled(warned.id, TIMEOUT)
  assert.equal(warned.status, 'completed', 'a warning is a note on the run page, not a gate')
  assert.ok(called > 0, 'the agents ran')
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
}

// ── 19. live output: every line an agent reports is kept, streamed and logged ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  runner.setAgentCaller(async (agentSlug, input, projectDir, { onProgress } = {}) => {
    onProgress?.({ turn: 1, lastTool: 'Bash', lastActivityAt: Date.now(), line: `[Bash] echo ${agentSlug}` })
    onProgress?.({ turn: 1, lastTool: 'Bash', lastActivityAt: Date.now(), line: '→ done' })
    return `out ${agentSlug}`
  })
  const seen = []
  let lr = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const off = runner.subscribeLog(lr.id, (stepId, line) => seen.push([stepId, line]))
  lr = await runner.waitForSettled(lr.id, TIMEOUT)
  off()
  assert.equal(lr.status, 'completed')
  const tail = await runner.getLiveLog(lr.id)
  assert.ok(tail.a?.some(l => /\[Bash\] echo agent-a$/.test(l)), 'the tail holds the reported line, timestamped')
  assert.ok(tail.a?.[0] && /step started, visit 1$/.test(tail.a[0]), 'and opens with the step start')
  assert.ok(seen.some(([s, l]) => s === 'b' && /→ done$/.test(l)), 'listeners hear each line as it happens')
  const logs = readdirSync(join(process.env.AGENT_RUNS_DIR, lr.id, 'artifacts', 'steps')).filter(f => f.endsWith('.log'))
  assert.ok(logs.includes('step-01-agent-a.log'), `the step log is an artifact: ${logs.join(',')}`)
  assert.match(readFileSync(join(process.env.AGENT_RUNS_DIR, lr.id, 'artifacts', 'steps', 'step-01-agent-a.log'), 'utf8'), /\[Bash\] echo agent-a/, 'holding the same lines')
  runner._dropLive(lr.id)
  const fromDisk = await runner.getLiveLog(lr.id)
  assert.deepEqual(fromDisk.a, tail.a, 'once the process that ran it is gone, the same lines come from the artifact')
}

// ── 19b. a burst of progress lines reaches the artifact IN ORDER ──
// The unchained `void appendFile` reordered lines reported in one tick: the
// live tail and the step log artifact then told different stories, and only
// the artifact survives the process.
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const BURST = 40
  runner.setAgentCaller(async (agentSlug, input, projectDir, { onProgress } = {}) => {
    for (let i = 0; i < BURST; i++) onProgress?.({ turn: 1, lastTool: 'Bash', lastActivityAt: Date.now(), line: `line-${String(i).padStart(3, '0')}` })
    return `out ${agentSlug}`
  })
  let lr = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  lr = await runner.waitForSettled(lr.id, TIMEOUT)
  assert.equal(lr.status, 'completed')
  const tail = await runner.getLiveLog(lr.id)
  runner._dropLive(lr.id)
  const fromDisk = await runner.getLiveLog(lr.id)
  const nums = l => l.filter(x => /line-\d{3}$/.test(x)).map(x => x.slice(-3))
  assert.equal(nums(fromDisk.a ?? []).length, BURST, 'every burst line reached the artifact')
  assert.deepEqual(nums(fromDisk.a ?? []), nums(tail.a ?? []),
    'the artifact holds the burst in the order it was reported, not the order the writes happened to finish')
}

// ── 20. a checkout cloned mid-run gets the run branch before the next step ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const wsRoot = mkdtempSync(join(tmpdir(), 'runner-ws-'))
  const savedRoot = process.env.AGENT_WORKSPACE_ROOT
  process.env.AGENT_WORKSPACE_ROOT = wsRoot
  const cloned = join(wsRoot, 'alice', 'ase_lbss')
  const seenBranch = {}
  runner.setAgentCaller(async (agentSlug, input, projectDir) => {
    if (agentSlug === 'agent-a') {
      // The provisioner: clone into the developer's workspace, on main, no branch.
      mkdirSync(cloned, { recursive: true })
      git(cloned, ['init', '-q', '-b', 'main']); git(cloned, ['config', 'user.email', 't@x']); git(cloned, ['config', 'user.name', 't'])
      writeFileSync(join(cloned, 'a.txt'), 'a\n'); git(cloned, ['add', '.']); git(cloned, ['commit', '-q', '-m', 'init'])
    } else {
      seenBranch[agentSlug] = { branch: git(projectDir, ['branch', '--show-current']), projectDir, header: /Working checkout: .* on branch fix\/CSUP-9-/.test(input) }
    }
    return `out ${agentSlug}`
  })
  let lazy = await runner.startRun({ workflow, initialPrompt: 'CSUP-9: cloned later', watch: 'direct-invocation', autoRun: true, startedBy: 'alice' })
  assert.equal(lazy.branch, undefined, 'nothing to branch before the clone exists')
  lazy = await runner.waitForSettled(lazy.id, TIMEOUT)
  assert.equal(lazy.status, 'completed')
  assert.equal(lazy.branch, `fix/CSUP-9-${lazy.id.slice(0, 8)}`, 'the branch was made once the checkout appeared')
  assert.equal(lazy.projectDir, `${cloned}@fix-CSUP-9-${lazy.id.slice(0, 8)}`, 'and the run now knows its worktree, beside the clone')
  assert.equal(seenBranch['agent-b'].branch, lazy.branch, 'the next step ran with the branch checked out')
  assert.equal(seenBranch['agent-b'].projectDir, lazy.projectDir, 'in that worktree')
  assert.equal(git(cloned, ['branch', '--show-current']), 'main', 'and the clone was left on main')
  assert.ok(seenBranch['agent-b'].header, 'and was told so in its header')
  process.env.AGENT_WORKSPACE_ROOT = savedRoot
  rmSync(wsRoot, { recursive: true, force: true })
}

// ── 21. an agent's question pauses the run; the answer resumes it ─────────
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const inputs = {}
  runner.setAgentCaller(async (agentSlug, input) => {
    inputs[agentSlug] = input
    if (agentSlug === 'agent-a' && !/User response/.test(input)) return 'I need to know.\nPIPELINE-ASK: Which customer profile applies, SaskTel or Lum?'
    return `out ${agentSlug}`
  })
  let q = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'paused', 'a question pauses the run')
  assert.equal(q.question?.kind, 'question'); assert.match(q.question.text, /SaskTel or Lum/)
  assert.equal(q.steps.find(s => s.stepId === 'a').status, 'waiting', 'the asking step waits rather than completing')
  assert.deepEqual(q.currentStepIds, ['a'])
  q = await runner.respondToRun(q.id, 'SaskTel')
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'completed', 'the answer re-runs the step and a run-to-completion run carries on')
  assert.equal(q.question, undefined)
  assert.match(inputs['agent-a'], /User response:\nSaskTel/, 'the step saw the answer with its own previous output')
  assert.ok(inputs['agent-d'], 'downstream steps ran after the answer')
}

// ── 21b. a step that asks again after an answer pauses again; it never turns into a stuck run ──
// A real run died here: the answered step asked a second question, the
// run-to-completion loop found no schedulable step and failed the run as stuck
// with the question still on the record.
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  let asks = 0
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug === 'agent-a' && asks < 2) { asks++; return `PIPELINE-ASK: question number ${asks}?` }
    return `out ${agentSlug}`
  })
  let q = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'paused'); assert.match(q.question.text, /number 1/)
  q = await runner.respondToRun(q.id, 'first answer')
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'paused', `a second question pauses the run again, it does not fail it: ${q.error ?? ''}`)
  assert.match(q.question?.text ?? '', /number 2/, 'and the new question is the one on the record')
  assert.equal(q.steps.find(s => s.stepId === 'a').status, 'waiting')
  // A paused run is continued, not restarted; a stopped one restarted from the asking
  // step has its question answered by the restart itself: no stale "waiting for you" on a running run.
  await runner.stopRun(q.id)
  q = await runner.restartRun(q.id, 'a', 'restarted instead of answered')
  assert.equal(q.question, undefined, 'a restart clears the question it supersedes')
  q = await runner.waitForSettled(q.id, TIMEOUT)
  assert.equal(q.status, 'completed', 'and the restarted step, no longer asking, lets the run finish')
}

// ── 22. a step marked for approval waits for a person, note travels with the go-ahead ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const gated = { ...workflow, steps: workflow.steps.map(s => s.id === 'd' ? { ...s, approval: true } : s) }
  const inputs = {}
  runner.setAgentCaller(async (agentSlug, input) => { inputs[agentSlug] = input; return `out ${agentSlug}` })
  let g = await runner.startRun({ workflow: gated, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused', 'run-to-completion still stops at an approval gate')
  assert.equal(g.question?.kind, 'approval'); assert.equal(g.question.stepId, 'd')
  assert.equal(g.steps.find(s => s.stepId === 'd').status, 'pending', 'the gated step has not started')
  assert.equal(inputs['agent-d'], undefined)
  g = await runner.continueRun(g.id, 'Target the SaskTel branch policy')
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'completed')
  assert.match(inputs['agent-d'], /Operator note from the operator, sent while the run was in flight: Target the SaskTel branch policy/, 'the approval note reached the gated step')
}

// ── 23. a note sent while a step runs reaches whichever step starts next ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const inputs = {}
  runner.setAgentCaller(async (agentSlug, input) => { inputs[agentSlug] = input; if (agentSlug === 'agent-a') await new Promise(r => setTimeout(r, 400)); return `out ${agentSlug}` })
  let n = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(await runner.noteRun(n.id, 'The plugin lives under modules/administrator'), { queued: 'The plugin lives under modules/administrator' })
  n = await runner.waitForSettled(n.id, TIMEOUT)
  assert.equal(n.status, 'completed')
  assert.ok(!/modules\/administrator/.test(inputs['agent-a']), 'the step already running did not get it')
  const carriers = ['agent-b', 'agent-c', 'agent-d'].filter(s => /Operator note .*modules\/administrator/.test(inputs[s] ?? ''))
  assert.equal(carriers.length, 1, `exactly one later step carries the note: ${carriers.join(',')}`)
  assert.equal(await runner.noteRun('no-such-run', 'x'), null, 'a run not in flight here cannot take a note')
}

// ── 24. a restart does not re-run a step that declared a skip ─────────────
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const calls = []
  let dFails = true
  runner.setAgentCaller(async (agentSlug) => {
    calls.push(agentSlug)
    if (agentSlug === 'agent-b') return 'nothing to stand up here\nPIPELINE-SKIP: unit-test-only change'
    if (agentSlug === 'agent-d' && dFails) throw new Error('d failed once')
    return `out ${agentSlug}`
  })
  let sk = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  sk = await runner.waitForSettled(sk.id, TIMEOUT)
  assert.equal(sk.status, 'failed')
  assert.equal(sk.steps.find(s => s.stepId === 'b').status, 'skipped')
  assert.ok(sk.steps.find(s => s.stepId === 'b').skipReason, 'the skip was declared, not scheduled')
  runner._dropLive(sk.id)
  dFails = false
  calls.length = 0
  sk = await runner.restartRun(sk.id, 'd')
  sk = await runner.waitForSettled(sk.id, TIMEOUT)
  assert.equal(sk.status, 'completed')
  assert.deepEqual(calls, ['agent-d'], `only the restarted step ran; a declared skip stays settled: ${calls.join(',')}`)
  assert.equal(sk.steps.find(s => s.stepId === 'b').visits, 1, 'the skipped step was not visited again')
}

// ── 25. a restart is always worth one visit, and reads the record, not a stale memory ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const calls = []
  let cFails = 3
  runner.setAgentCaller(async (agentSlug) => { calls.push(agentSlug); if (agentSlug === 'agent-c' && cFails-- > 0) throw new Error('c keeps failing'); return `out ${agentSlug}` })
  let v = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  v = await runner.waitForSettled(v.id, TIMEOUT)
  assert.equal(v.status, 'failed')
  // Two restarts fail too, leaving c at its visit cap of 3.
  v = await runner.waitForSettled((await runner.restartRun(v.id, 'c')).id, TIMEOUT)
  v = await runner.waitForSettled((await runner.restartRun(v.id, 'c')).id, TIMEOUT)
  assert.equal(v.steps.find(s => s.stepId === 'c').visits, 3, 'c is at its cap')
  calls.length = 0
  v = await runner.waitForSettled((await runner.restartRun(v.id, 'c')).id, TIMEOUT)
  assert.equal(v.status, 'completed', 'a restart at the cap still runs the step once more: ' + v.error + ' calls=' + calls.join(','))
  assert.ok(calls.includes('agent-c'), 'the capped step actually ran')
  assert.equal(v.steps.find(s => s.stepId === 'c').visits, 3, 'the visit count saturates at the cap the evidence schema allows')
  // The record on disk, not memory, is what a restart reads.
  const rec = await store.getRun(v.id)
  rec.status = 'failed'; rec.steps.find(s => s.stepId === 'd').status = 'failed'
  await store.saveRun(rec)
  calls.length = 0
  v = await runner.waitForSettled((await runner.restartRun(v.id, 'd')).id, TIMEOUT)
  assert.equal(v.status, 'completed'); assert.deepEqual(calls, ['agent-d'], 'the step marked failed on disk ran, whatever memory remembered')
}

// ── 26. running out of turns is a checkpoint: the retry starts from the log tail ──
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const { AgentResultError } = await import('../server/utils/agentCaller.ts')
  const inputs = {}
  let starved = true
  runner.setAgentCaller(async (agentSlug, input, projectDir, { onProgress } = {}) => {
    inputs[agentSlug] = inputs[agentSlug] ?? []; inputs[agentSlug].push(input)
    if (agentSlug === 'agent-b' && starved) {
      onProgress?.({ turn: 1, lastTool: 'Bash', lastActivityAt: Date.now(), line: '[Bash] JUNIT=/x/junit.jar java org.junit.runner.JUnitCore T' })
      onProgress?.({ turn: 1, lastTool: 'Bash', lastActivityAt: Date.now(), line: '→ OK (6 tests) EXIT: 0' })
      starved = false
      throw new AgentResultError('Claude Code returned an error result (error_max_turns): no further detail', { input_tokens: 5, output_tokens: 1 }, 'error_max_turns')
    }
    return `out ${agentSlug}`
  })
  let mt = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  mt = await runner.waitForSettled(mt.id, TIMEOUT)
  assert.equal(mt.status, 'completed', 'the run survives a step that ran out of turns')
  const b = mt.steps.find(s => s.stepId === 'b')
  assert.equal(b.status, 'completed'); assert.equal(b.visits, 2, 'the step ran a second time')
  assert.equal(inputs['agent-b'].length, 2)
  assert.match(inputs['agent-b'][1], /ran out of its turn budget/, 'the retry is told why')
  assert.match(inputs['agent-b'][1], /OK \(6 tests\) EXIT: 0/, 'and gets the tail of what the first attempt did')
  const snaps = readdirSync(join(process.env.AGENT_RUNS_DIR, mt.id, 'artifacts', 'steps'))
  assert.ok(snaps.some(f => /step-02-.*-retry-1\.json$/.test(f)), 'the starved attempt is snapshotted')
}

// THE end-to-end regression this whole change exists for (DEVOPS-15): a real
// project directory, on a long-lived branch that already has real commits
// ahead of main BEFORE the run starts, run through startRun itself — not
// finalizeRunArtifacts called directly, so this proves startRun actually
// captures WorkflowRun.baseCommit (via gitFacts.ts's captureBaseline) and
// that the whole pipeline (startRun -> runWave -> publish -> finalize) wires
// it through correctly. The stub agent halts the run at the first step and
// makes no commits — the exact shape of the real DEVOPS-15 run that
// attested to 33 commits, 17 files and 1083 lines it never touched.
{
  const projectDir = mkdtempSync(join(tmpdir(), 'runner-project-develop-'))
  git(projectDir, ['init', '-q', '-b', 'main'])
  git(projectDir, ['config', 'user.email', 'test@example.invalid'])
  git(projectDir, ['config', 'user.name', 'Test'])
  writeFileSync(join(projectDir, 'a.txt'), 'line1\n')
  git(projectDir, ['add', '.'])
  git(projectDir, ['commit', '-q', '-m', 'initial'])
  git(projectDir, ['remote', 'add', 'origin', 'git@github.com:alepolab/alepo-dev-team-infra.git'])
  git(projectDir, ['checkout', '-q', '-b', 'develop'])
  for (let i = 0; i < 33; i += 1) {
    appendFileSync(join(projectDir, 'a.txt'), `pre-existing line ${i}\n`)
    git(projectDir, ['add', '.'])
    git(projectDir, ['commit', '-q', '-m', `pre-existing develop commit ${i}`])
  }
  const aheadOfMain = git(projectDir, ['rev-list', 'main..HEAD']).split('\n').filter(Boolean)
  assert.equal(aheadOfMain.length, 33, 'sanity: develop is 33 commits ahead of main before the run starts')
  const developTip = git(projectDir, ['rev-parse', 'HEAD'])

  const haltWorkflow = {
    slug: 'devops-15', name: 'DEVOPS-15 Regression',
    steps: [{ id: 'intake', agentSlug: 'sdlc-ticket-intake', label: 'Intake', next: [] }],
  }
  runner.setAgentCaller(async (agentSlug, input) => {
    // An agent halting the run also self-reports a fabricated fix — same
    // shape as the real DEVOPS-15 meta.json (33 commits, 17 files, 1083
    // lines) — proving reconciliation, not merely an honest agent, is what
    // keeps it out of the bundle.
    const m = input.match(/Write every artifact you produce into: (\S+)/)
    const metaPath = join(m[1], 'meta.json')
    const cur = JSON.parse(readFileSync(metaPath, 'utf8'))
    writeFileSync(metaPath, JSON.stringify({
      ...cur,
      fix: {
        repos: [{ repo: 'alepolab/alepo-dev-team-infra', commits: aheadOfMain, pr: null }],
        files_changed: 17, lines_changed: 1083, test_dirs_unlocked: false, unlock_reason: null,
      },
    }, null, 2))
    return `could not bring the stack up\nPIPELINE-HALT: ${agentSlug} stopped`
  })
  const r = await runner.waitForSettled(
    (await runner.startRun({
      workflow: haltWorkflow, initialPrompt: 'fix DEVOPS-15', watch: 'direct-invocation',
      autoRun: true, projectDir,
    })).id, TIMEOUT)
  assert.equal(r.status, 'failed', 'the halted step fails the run, exactly as the real DEVOPS-15 run did')
  assert.equal(r.baseCommit, developTip,
    'startRun captured develop\'s own tip as baseCommit, not main\'s — before the (single, halting) step ran')

  const dir = join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  assert.ok(!meta.fix || !('repos' in meta.fix),
    'a run that made no commits attests to no fix.repos, even though the branch is 33 commits ahead of main')
  assert.ok(!meta.fix || !('files_changed' in meta.fix), 'no fabricated files_changed survives finalize')
  assert.ok(!meta.fix || !('lines_changed' in meta.fix), 'no fabricated lines_changed survives finalize')

  rmSync(projectDir, { recursive: true, force: true })
}

// ── 25. a step that finds the fault elsewhere widens the run instead of halting ──
// A real run halted on a selfcare ticket whose 500 was raised inside the CRM:
// the step could see where the fault was and had no way to bring that code in.
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const wide = { slug: 'widen-demo', name: 'Widen demo', steps: [
    { id: 'p', agentSlug: 'sdlc-stack-provisioner', label: 'Provision', next: ['t'] },
    { id: 't', agentSlug: 'agent-t', label: 'Failing Test', next: [] },
  ] }
  mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'widen-demo.json'), JSON.stringify({ ...wide, description: '', createdAt: new Date().toISOString() }))
  const inputs = { p: [], t: [] }
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug === 'sdlc-stack-provisioner') { inputs.p.push(input); return 'stack up' }
    inputs.t.push(input)
    return inputs.t.length === 1
      ? 'The 500 is raised in the CRM, not here.\nPIPELINE-WIDEN: alepolab/other-crm — the stack trace names its upload handler'
      : 'oracle written in the CRM repository'
  })
  let w = await runner.startRun({ workflow: wide, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  w = await runner.waitForSettled(w.id, TIMEOUT)
  assert.equal(w.status, 'completed', `widening continues the run: ${w.error}`)
  assert.ok(w.product?.repos.includes('alepolab/other-crm'), 'the named repository joined the run')
  assert.equal(w.steps.find(s => s.stepId === 'p').visits, 2, 'provisioning ran again for the wider scope')
  assert.equal(w.steps.find(s => s.stepId === 't').visits, 2, 'and the step that widened ran again after it')
  assert.match(inputs.p[1], /widened to alepolab\/other-crm/, 'the re-run provisioner is told why')
  assert.match(inputs.t[1], /other-crm/, 'the header now names the added repository')
  assert.equal(w.steps.find(s => s.stepId === 't').status, 'completed')

  // An unknown target fails the step with the registered keys named, not the run's honesty.
  runner.setAgentCaller(async (agentSlug) => agentSlug === 'sdlc-stack-provisioner' ? 'stack up' : 'PIPELINE-WIDEN: nonsense — no such thing')
  let bad = await runner.startRun({ workflow: wide, initialPrompt: 'go again', watch: 'direct-invocation', autoRun: true })
  bad = await runner.waitForSettled(bad.id, TIMEOUT)
  assert.equal(bad.status, 'failed')
  assert.match(bad.steps.find(s => s.stepId === 't').error, /neither a registered product/)
}

// ── 26. a step sends the run back to an earlier step instead of halting ─────
// A real security review halted a run over an error body that leaked a message,
// with the implementer one restart away.
{
  for (const r of await store.listRuns('demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  const chain = { slug: 'rework-demo', name: 'Rework demo', steps: [
    { id: 'f', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['r'] },
    { id: 'r', agentSlug: 'agent-review', label: 'Security Review', next: [] },
  ] }
  mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'rework-demo.json'), JSON.stringify({ ...chain, description: '', createdAt: new Date().toISOString() }))
  const fixInputs = []
  let reviews = 0
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug === 'agent-fix') { fixInputs.push(input); return 'fixed' }
    reviews += 1
    return reviews === 1 ? 'VERDICT: FAIL\nPIPELINE-REWORK: Implement Fix — GenericResource.java:198 returns the exception message to the caller; return a generic string' : 'VERDICT: PASS'
  })
  let rw = await runner.startRun({ workflow: chain, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  rw = await runner.waitForSettled(rw.id, TIMEOUT)
  assert.equal(rw.status, 'completed', `the rework continues the run: ${rw.error}`)
  assert.equal(rw.steps.find(s => s.stepId === 'f').visits, 2, 'the fix step ran again')
  assert.equal(rw.steps.find(s => s.stepId === 'r').visits, 2, 'and the review ran again after it')
  assert.match(fixInputs[1], /Sent back by "Security Review".*GenericResource\.java:198/, 'the fix step is told what to change')
  assert.equal(rw.reworks, 1)

  // Two steps disagreeing forever is a failure to report, not a loop to run.
  runner.setAgentCaller(async (agentSlug) => agentSlug === 'agent-fix' ? 'fixed' : 'PIPELINE-REWORK: Implement Fix — still leaking')
  let loop = await runner.startRun({ workflow: chain, initialPrompt: 'go again', watch: 'direct-invocation', autoRun: true })
  loop = await runner.waitForSettled(loop.id, TIMEOUT)
  assert.equal(loop.status, 'failed')
  assert.match(loop.error, /Sent back 3 times/)
  assert.equal(loop.reworks, 3)

  // A target that is not a step of the run fails the step, naming the steps.
  runner.setAgentCaller(async (agentSlug) => agentSlug === 'agent-fix' ? 'fixed' : 'PIPELINE-REWORK: Nowhere — nothing')
  let lost = await runner.startRun({ workflow: chain, initialPrompt: 'go once more', watch: 'direct-invocation', autoRun: true })
  lost = await runner.waitForSettled(lost.id, TIMEOUT)
  assert.equal(lost.status, 'failed')
  assert.match(lost.steps.find(s => s.stepId === 'r').error, /not a step of this run/)
}


// ── 27. Conditional routing: a step runs only when its artifact holds work ─
// The shape that prompted this: a Decision Gate writes two files, and each of
// its two successors consumes one of them. Either may legitimately be empty,
// and the empty branch must not run — nor, when it carries `approval`, ask a
// person to approve doing nothing.
{
  const gateFlow = {
    slug: 'gate-demo', name: 'Gate Demo',
    steps: [
      { id: 'g', agentSlug: 'agent-g', label: 'Decision Gate', next: ['ap', 'esc'] },
      { id: 'ap', agentSlug: 'agent-ap', label: 'Create Jira (Auto-Approved)', next: ['j'], runWhen: { artifact: 'approved-drafts.json' } },
      { id: 'esc', agentSlug: 'agent-esc', label: 'Create Jira (Escalated)', next: ['j'], approval: true, runWhen: { artifact: 'escalated-drafts.json' } },
      { id: 'j', agentSlug: 'agent-j', label: 'Dispatch', next: [] },
    ],
  }

  // The gate learns where to write from the artifact header, exactly as a real
  // agent does — the same channel poisonMetaFromInput uses.
  function gateWriting(approved, escalated) {
    return async (agentSlug, input) => {
      calls.push(agentSlug)
      if (agentSlug === 'agent-g') {
        const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
        if (approved !== null) writeFileSync(join(dir, 'approved-drafts.json'), approved)
        if (escalated !== null) writeFileSync(join(dir, 'escalated-drafts.json'), escalated)
      }
      return `output of ${agentSlug}`
    }
  }

  // ── 27a. The reported bug: nothing escalated, so nobody is asked ─────────
  runner.setAgentCaller(gateWriting('[{"key":"A-1"}]', '[]'))
  calls.length = 0
  let g1 = await runner.startRun({ workflow: gateFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  g1 = await runner.waitForSettled(g1.id, TIMEOUT)

  // The assertion that proves the feature: NOT 'paused'. Before conditional
  // routing this run stopped on an approval prompt for an empty file.
  assert.equal(g1.status, 'completed', 'an empty escalated branch must not pause the run for approval')
  assert.equal(g1.question, undefined, 'and must leave no question behind')
  const esc1 = g1.steps.find(s => s.stepId === 'esc')
  assert.equal(esc1.status, 'skipped', 'the branch whose artifact was empty is skipped')
  assert.match(esc1.skipReason, /escalated-drafts\.json/, 'the reason names the file')
  assert.match(esc1.skipReason, /empty array/, 'and what was found in it')
  assert.equal(esc1.visits, 0, 'a condition skip spends no visit')
  assert.equal(g1.steps.find(s => s.stepId === 'ap').status, 'completed', 'the branch with work runs')
  assert.equal(g1.steps.find(s => s.stepId === 'j').status, 'completed', 'the join still runs')
  assert.ok(!calls.includes('agent-esc'), 'the skipped step never reached its agent')
  assert.deepEqual(calls.sort(), ['agent-ap', 'agent-g', 'agent-j'])

  // ── 27b. Both branches empty: the join runs and is TOLD they were empty ──
  runner.setAgentCaller(gateWriting('[]', '[]'))
  calls.length = 0
  let g2 = await runner.startRun({ workflow: gateFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  g2 = await runner.waitForSettled(g2.id, TIMEOUT)
  assert.equal(g2.status, 'completed')
  assert.equal(g2.steps.find(s => s.stepId === 'ap').status, 'skipped')
  assert.equal(g2.steps.find(s => s.stepId === 'esc').status, 'skipped')
  const join2 = g2.steps.find(s => s.stepId === 'j')
  assert.equal(join2.status, 'completed', 'a join whose every branch was empty still runs')
  // The point of publishing the skip as a sentence: an unset output would hand
  // the join two empty strings, indistinguishable from steps that ran and
  // produced nothing. The join has to be able to report that there was no work.
  assert.match(join2.input, /approved-drafts\.json/, 'the join is told the approved branch was empty')
  assert.match(join2.input, /escalated-drafts\.json/, 'and the escalated one too')
  assert.deepEqual(calls.sort(), ['agent-g', 'agent-j'])

  // ── 27c. A non-empty escalated branch still gates on approval ────────────
  runner.setAgentCaller(gateWriting('[{"key":"A-1"}]', '[{"key":"E-1"}]'))
  calls.length = 0
  let g3 = await runner.startRun({ workflow: gateFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  g3 = await runner.waitForSettled(g3.id, TIMEOUT)
  assert.equal(g3.status, 'paused', 'real escalations still wait for a person')
  assert.equal(g3.question.kind, 'approval')
  assert.equal(g3.question.stepId, 'esc')
  // Documents a defect this change does NOT fix: the approval gate holds the
  // WHOLE wave, so the auto-approved sibling waits on the human too. Conditional
  // routing only removes the case where the escalated branch was empty.
  assert.equal(g3.steps.find(s => s.stepId === 'ap').status, 'pending',
    'known limitation: one gated node still holds its whole wave')
  g3 = await runner.continueRun(g3.id)
  g3 = await runner.waitForSettled(g3.id, TIMEOUT)
  assert.equal(g3.status, 'completed')
  assert.ok(calls.includes('agent-esc'), 'the approved branch runs once a person says yes')

  // ── 27d. A missing artifact skips; the run does not silently look normal ─
  runner.setAgentCaller(gateWriting(null, null))
  calls.length = 0
  let g4 = await runner.startRun({ workflow: gateFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  g4 = await runner.waitForSettled(g4.id, TIMEOUT)
  assert.equal(g4.status, 'completed')
  assert.match(g4.steps.find(s => s.stepId === 'ap').skipReason, /was not written/,
    'a file nobody wrote reads differently from one that is empty')

  // ── 27e. Malformed JSON FAILS the step; it never reads as "nothing to do" ─
  runner.setAgentCaller(gateWriting('{', '[]'))
  calls.length = 0
  let g5 = await runner.startRun({ workflow: gateFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  g5 = await runner.waitForSettled(g5.id, TIMEOUT)
  assert.equal(g5.status, 'failed', 'a producer that crashed mid-write must not complete the run quietly')
  const ap5 = g5.steps.find(s => s.stepId === 'ap')
  assert.equal(ap5.status, 'failed')
  assert.match(ap5.error, /approved-drafts\.json/, 'the error names the file')
  assert.match(ap5.error, /not valid JSON/, 'and why it could not be evaluated')
  assert.ok(!calls.includes('agent-j'), 'nothing downstream runs')

  // ── 27f. An artifact name that escapes the run directory is refused ──────
  {
    const escapeFlow = {
      slug: 'gate-escape', name: 'Gate Escape',
      steps: [
        { id: 'g', agentSlug: 'agent-g', label: 'Gate', next: ['x'] },
        { id: 'x', agentSlug: 'agent-x', label: 'X', next: [], runWhen: { artifact: '../../../etc/passwd' } },
      ],
    }
    runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
    let g6 = await runner.startRun({ workflow: escapeFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
    g6 = await runner.waitForSettled(g6.id, TIMEOUT)
    assert.equal(g6.status, 'failed')
    assert.match(g6.steps.find(s => s.stepId === 'x').error, /outside the run's artifacts directory/)
  }

  // ── 27g. A terminal conditional step COMPLETES the run, never "stuck" ────
  // Guards the stuck detector: it counts steps whose record still reads
  // 'pending', so the condition must resolve before it, not after.
  {
    const tailFlow = {
      slug: 'gate-tail', name: 'Gate Tail',
      steps: [
        { id: 'g', agentSlug: 'agent-g', label: 'Gate', next: ['t'] },
        { id: 't', agentSlug: 'agent-t', label: 'Tail', next: [], runWhen: { artifact: 'never-written.json' } },
      ],
    }
    runner.setAgentCaller(async (agentSlug) => `output of ${agentSlug}`)
    let g7 = await runner.startRun({ workflow: tailFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
    g7 = await runner.waitForSettled(g7.id, TIMEOUT)
    assert.equal(g7.status, 'completed', 'a workflow ending in a skipped conditional step is finished, not stuck')
    assert.equal(g7.error, undefined, 'and reports no "No step can run" error')
    assert.equal(g7.steps.find(s => s.stepId === 't').status, 'skipped')
  }

  // ── 27h. A monitor RETRY is not swallowed by the condition ───────────────
  // runWhen gates a forward arming only. A retry arrives by another route and
  // re-testing the artifact there would discard the monitor's feedback.
  {
    const retryFlow = {
      slug: 'gate-retry', name: 'Gate Retry',
      steps: [
        { id: 'g', agentSlug: 'agent-g', label: 'Gate', next: ['r'] },
        { id: 'r', agentSlug: 'agent-r', label: 'R', next: [], runWhen: { artifact: 'work.json' }, monitorSlug: 'mon' },
      ],
    }
    let rCalls = 0
    let verdict = 'VERDICT: RETRY'
    runner.setAgentCaller(async (agentSlug, input) => {
      if (agentSlug === 'agent-g') {
        const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
        writeFileSync(join(dir, 'work.json'), '[1]')
        return 'gate done'
      }
      if (agentSlug === 'mon') { const v = verdict; verdict = 'VERDICT: CONTINUE'; return v }
      if (agentSlug === 'agent-r') {
        rCalls++
        // Empty the artifact after the first attempt: a re-test would now skip.
        const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
        writeFileSync(join(dir, 'work.json'), '[]')
        return 'r done'
      }
      return `output of ${agentSlug}`
    })
    let g8 = await runner.startRun({ workflow: retryFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
    g8 = await runner.waitForSettled(g8.id, TIMEOUT)
    assert.equal(rCalls, 2, 'the monitor retry re-runs the step even though the artifact is now empty')
    assert.equal(g8.steps.find(s => s.stepId === 'r').status, 'completed')
  }

  // ── 27i. An operator restart outranks the condition ──────────────────────
  // Same concession as the extra visit a restart grants: a predicate guards
  // automatic scheduling, not a person naming the step they want run. It also
  // proves the skip rehydrates as settled — skipReason is what makes it so.
  {
    mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
    writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'gate-restart.json'),
      JSON.stringify({ name: 'Gate Restart', description: '', steps: [
        { id: 'g', agentSlug: 'agent-g', label: 'Gate', next: ['ap', 'esc'] },
        { id: 'ap', agentSlug: 'agent-ap', label: 'AP', next: ['j'], runWhen: { artifact: 'approved-drafts.json' } },
        { id: 'esc', agentSlug: 'agent-esc', label: 'ESC', next: ['j'], runWhen: { artifact: 'escalated-drafts.json' } },
        { id: 'j', agentSlug: 'agent-j', label: 'J', next: [] },
      ] }))
    const restartFlow = { slug: 'gate-restart', name: 'Gate Restart', steps: JSON.parse(readFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'gate-restart.json'), 'utf8')).steps }

    runner.setAgentCaller(gateWriting('[{"key":"A-1"}]', '[]'))
    calls.length = 0
    let g9 = await runner.startRun({ workflow: restartFlow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
    g9 = await runner.waitForSettled(g9.id, TIMEOUT)
    assert.equal(g9.status, 'completed')
    assert.equal(g9.steps.find(s => s.stepId === 'esc').status, 'skipped')

    // Forget the live record, as a server restart would, then restart the very
    // step the condition skipped. The artifact is still empty.
    runner._dropLive(g9.id)
    calls.length = 0
    g9 = await runner.restartRun(g9.id, 'esc')
    g9 = await runner.waitForSettled(g9.id, TIMEOUT)
    assert.ok(calls.includes('agent-esc'),
      'restarting a condition-skipped step by name runs it despite the still-empty artifact')
    assert.equal(g9.status, 'completed')
  }
}
// ── 28. triggerWorkflow: one child run per entry, dispatched not awaited ───
// Replaces the sdlc-auto-dispatcher agent, whose "dispatch" was a JSON file
// nothing read. The step starts real runs, so these assert real run records.
{
  const queue = await import('../server/utils/runQueue.ts')
  process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'runner-workspaces-'))
  // Deterministic: every entry dispatches at once, so nothing is queued except
  // where 28h deliberately lowers the cap to test queueing.
  process.env.AGENT_MAX_CONCURRENT_PIPELINES = '10'

  // The child workflows must exist on disk — the runner reads them from
  // CLAUDE_DIR/workflows, never from the parent's definition.
  const wfDir = join(process.env.CLAUDE_DIR, 'workflows')
  mkdirSync(wfDir, { recursive: true })
  const childWorkflow = name => JSON.stringify({
    name, steps: [{ id: 'only', agentSlug: 'agent-child', label: name, next: [] }],
  })
  writeFileSync(join(wfDir, 'runbook-a.json'), childWorkflow('Runbook A'))
  writeFileSync(join(wfDir, 'runbook-b.json'), childWorkflow('Runbook B'))

  const dispatchFlow = (trigger, slug = 'scan-demo') => ({
    slug, name: 'Scan Demo',
    steps: [
      { id: 's', agentSlug: 'agent-s', label: 'Scan', next: ['d'] },
      { id: 'd', agentSlug: 'sdlc-auto-dispatcher', label: 'Dispatch', next: [], triggerWorkflow: trigger },
    ],
  })
  const ROUTING = { source: 'created-tickets.json', routeBy: 'work_type', routes: { bug: 'runbook-a', feature: 'runbook-b' } }

  // The scan step writes the artifact the dispatch step reads, through the
  // artifact header — the same channel a real agent learns the path from.
  function scanWriting(tickets) {
    return async (agentSlug, input) => {
      calls.push(agentSlug)
      if (agentSlug === 'agent-s' && tickets !== null) {
        const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
        writeFileSync(join(dir, 'created-tickets.json'), tickets)
      }
      return `output of ${agentSlug}`
    }
  }
  const settleAll = async ids => Promise.all(ids.map(id => runner.waitForSettled(id, TIMEOUT)))

  // ── 28a. The feature: a mixed batch fans out, one child run per entry ────
  runner.setAgentCaller(scanWriting(JSON.stringify([
    { jira_key: 'CSUP-1', work_type: 'bug', summary: 'crash on save' },
    { jira_key: 'CSUP-2', work_type: 'feature', summary: 'dark mode' },
  ])))
  calls.length = 0
  let d1 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true, startedBy: 'dev' })
  d1 = await runner.waitForSettled(d1.id, TIMEOUT)

  assert.equal(d1.status, 'completed', 'the parent completes; it never waits for a child')
  const step1 = d1.steps.find(s => s.stepId === 'd')
  assert.equal(step1.status, 'completed')
  assert.equal(step1.childRunIds.length, 2, 'one child run per entry')
  assert.equal(step1.model, null, 'a dispatch step is runner-executed: no model')
  assert.equal(step1.usage, null, 'and no usage to report')
  assert.ok(!calls.includes('sdlc-auto-dispatcher'), 'the dispatch step never reaches an agent')
  assert.match(step1.output, /Dispatched CSUP-1 to runbook-a/, 'the output names each child and its workflow')
  assert.match(step1.output, /Dispatched CSUP-2 to runbook-b/)

  const kids = await settleAll(step1.childRunIds)
  assert.deepEqual(kids.map(k => k.workflowSlug).sort(), ['runbook-a', 'runbook-b'],
    'each entry routed on its own work_type')
  for (const kid of kids) {
    assert.equal(kid.parentRunId, d1.id, 'every child records the run that dispatched it')
    assert.equal(kid.watch, `workflow-trigger:${d1.id}`, 'and answers "what triggered this?" honestly')
    assert.match(kid.ticketKey, /^CSUP-[12]$/, 'a ticket-shaped key becomes the child ticketKey')
  }
  // The whole reason children get their own directory: two runs editing one
  // checkout corrupt each other, and the run lock is scoped to the directory.
  assert.equal(new Set(kids.map(k => k.projectDir)).size, 2, 'each child works in its own checkout')
  assert.ok(kids.every(k => k.projectDir.includes('CSUP-')), 'named after the entry it was dispatched for')

  // ── 28b. Nothing to dispatch is an outcome, not a failure ───────────────
  runner.setAgentCaller(scanWriting('[]'))
  let d2 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  d2 = await runner.waitForSettled(d2.id, TIMEOUT)
  assert.equal(d2.status, 'completed', 'an empty batch completes the run')
  const step2 = d2.steps.find(s => s.stepId === 'd')
  assert.equal(step2.status, 'completed')
  assert.match(step2.output, /Dispatched nothing/, 'and says plainly that it dispatched nothing')
  assert.match(step2.output, /empty array/, 'naming what it found')
  assert.equal(step2.childRunIds, undefined)

  // A file that was never written is the same outcome, said differently.
  runner.setAgentCaller(scanWriting(null))
  let d3 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  d3 = await runner.waitForSettled(d3.id, TIMEOUT)
  assert.equal(d3.status, 'completed')
  assert.match(d3.steps.find(s => s.stepId === 'd').output, /was not written/)

  // ── 28c. Routing is all-or-nothing ──────────────────────────────────────
  // A half-dispatched batch leaves some tickets in flight and some silently
  // dropped, with nothing on the run recording which were which.
  const runsBefore = (await store.listRuns()).length
  runner.setAgentCaller(scanWriting(JSON.stringify([
    { jira_key: 'CSUP-3', work_type: 'bug' },
    { jira_key: 'CSUP-4', work_type: 'docs' },
  ])))
  let d4 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  d4 = await runner.waitForSettled(d4.id, TIMEOUT)
  assert.equal(d4.status, 'failed', 'an unroutable entry fails the step')
  const step4 = d4.steps.find(s => s.stepId === 'd')
  assert.equal(step4.status, 'failed')
  assert.match(step4.error, /CSUP-4 routes on "work_type": "docs"/, 'the error names the entry and the value')
  assert.equal((await store.listRuns()).length, runsBefore + 1,
    'and the routable entry alongside it was NOT dispatched — only the parent exists')

  // ── 28d. Malformed is a failure, never "nothing to dispatch" ────────────
  // A producer that crashed mid-write must not read as a scan with no findings.
  runner.setAgentCaller(scanWriting('not json'))
  let d5 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  d5 = await runner.waitForSettled(d5.id, TIMEOUT)
  assert.equal(d5.status, 'failed')
  assert.match(d5.steps.find(s => s.stepId === 'd').error, /not valid JSON/)

  // An object where an array belongs is malformed too, not an empty batch.
  runner.setAgentCaller(scanWriting('{"jira_key":"CSUP-5"}'))
  let d6 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  d6 = await runner.waitForSettled(d6.id, TIMEOUT)
  assert.equal(d6.status, 'failed')
  assert.match(d6.steps.find(s => s.stepId === 'd').error, /not the array of entries/)

  // ── 28e. An unknown target workflow fails before anything starts ────────
  const before5 = (await store.listRuns()).length
  runner.setAgentCaller(scanWriting(JSON.stringify([
    { jira_key: 'CSUP-6', work_type: 'bug' },
    { jira_key: 'CSUP-7', work_type: 'feature' },
  ])))
  let d7 = await runner.startRun({
    workflow: dispatchFlow({ ...ROUTING, routes: { bug: 'runbook-a', feature: 'no-such-runbook' } }),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
  })
  d7 = await runner.waitForSettled(d7.id, TIMEOUT)
  assert.equal(d7.status, 'failed')
  assert.match(d7.steps.find(s => s.stepId === 'd').error, /no workflow "no-such-runbook"/)
  assert.equal((await store.listRuns()).length, before5 + 1,
    'the valid target was not dispatched either — every target is checked first')

  // ── 28f. A path outside the run's artifacts directory is refused ────────
  runner.setAgentCaller(scanWriting('[]'))
  let d8 = await runner.startRun({
    workflow: dispatchFlow({ ...ROUTING, source: '../../../etc/passwd' }),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
  })
  d8 = await runner.waitForSettled(d8.id, TIMEOUT)
  assert.equal(d8.status, 'failed')
  assert.match(d8.steps.find(s => s.stepId === 'd').error, /outside the run's artifacts directory/)

  // ── 28g. Recursion: a workflow may not dispatch one it descends from ────
  // Nothing else in the runner can see this. maxVisits and MAX_TOTAL_RUNS are
  // per-run, and each generation here would be a NEW run with a fresh budget.
  writeFileSync(join(wfDir, 'loop-demo.json'), JSON.stringify({
    name: 'Loop Demo',
    steps: [
      { id: 's', agentSlug: 'agent-s', label: 'Scan', next: ['d'] },
      { id: 'd', agentSlug: 'sdlc-auto-dispatcher', label: 'Dispatch', next: [], triggerWorkflow: { source: 'created-tickets.json', slug: 'loop-demo' } },
    ],
  }))
  runner.setAgentCaller(scanWriting(JSON.stringify([{ jira_key: 'CSUP-8' }])))
  let d9 = await runner.startRun({
    workflow: dispatchFlow({ source: 'created-tickets.json', slug: 'loop-demo' }, 'loop-demo'),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
  })
  d9 = await runner.waitForSettled(d9.id, TIMEOUT)
  assert.equal(d9.status, 'failed', 'a self-dispatching workflow is refused')
  assert.match(d9.steps.find(s => s.stepId === 'd').error, /already descends from|dispatch itself forever/)

  // ── 28h. The cap queues the overflow, and a settling run drains it ──────
  // Without a cap a twenty-finding scan opens twenty clones and twenty agent
  // budgets at once. The overflow is a REAL RUN in `queued` status, not an
  // entry in a side file: it has an id, it is listed against its parent, and
  // it is visible and stoppable on /runs.
  //
  // A cap of 1, and the dispatching scan itself holds that slot while it
  // dispatches - see runQueue.ts's inFlightForGroup, which counts every live
  // run in the group and not only the dispatched ones. So both children wait,
  // and the drain starts them as the scan and then each child settles.
  process.env.AGENT_MAX_CONCURRENT_PIPELINES = '1'
  runner.setAgentCaller(scanWriting(JSON.stringify([
    { jira_key: 'CSUP-9', work_type: 'bug' },
    { jira_key: 'CSUP-10', work_type: 'feature' },
  ])))
  let d10 = await runner.startRun({ workflow: dispatchFlow(ROUTING), initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  const queuedChildren = () => store.listRuns().then(rs => rs.filter(r => r.parentRunId === d10.id && r.status === 'queued'))
  d10 = await runner.waitForSettled(d10.id, TIMEOUT)
  assert.equal(d10.status, 'completed', 'the scan does not wait for what it dispatched')
  // Asserted from the step's own recorded output rather than from live run
  // status: the parent settling frees its slot and the drain starts a child
  // immediately, so "is it still queued" is a race by design. What the step
  // DID is durable.
  const step10 = d10.steps.find(s => s.stepId === 'd')
  assert.equal(step10.childRunIds.length, 2,
    'BOTH children are recorded against the parent - a queued child used to be untraceable until it started')
  assert.match(step10.output, /Queued CSUP-9 for runbook-a \(run [0-9a-f-]+, waiting for a slot in default\)/,
    'the overflow is queued, not dropped, and the line names the run so it can be found')
  assert.match(step10.output, /Queued CSUP-10 for runbook-b \(run [0-9a-f-]+, waiting for a slot in default\)/)

  // The queue drains as each run settles, so both children start on their own.
  for (let i = 0; i < 200 && (await queuedChildren()).length; i++) await new Promise(r => setTimeout(r, 50))
  assert.equal((await queuedChildren()).length, 0, 'the queue drains once slots free up')
  const dispatched = (await store.listRuns()).filter(r => r.parentRunId === d10.id)
  assert.equal(dispatched.length, 2, 'both entries eventually got a run - queued work is not lost')
  assert.deepEqual(dispatched.map(r => r.workflowSlug).sort(), ['runbook-a', 'runbook-b'])
  assert.deepEqual(dispatched.map(r => r.id).sort(), [...step10.childRunIds].sort(),
    'and they are the same two runs the step named when it queued them')

  // THE ONE THAT MATTERS: a launched child's clock starts when it launches.
  // The budget, the wall clock and the cost report are all measured from
  // startedAt, so a child that kept its admission time would pause on a spent
  // budget having done no work.
  for (const d of dispatched) {
    assert.ok(d.startedAt >= d.queuedAt,
      'startedAt is restated at launch; queuedAt keeps the record of the wait')
    assert.notEqual(d.status, 'paused', 'and it did not pause on a budget it had not spent')
  }

  // ── 28i. A run cancelled while queued reports nothing about work it never did
  // Left ungated, publish() finalised an evidence bundle for a run with zero
  // executed steps and commented "run stopped" on its ticket.
  {
    const q = await runner.enqueueRun({
      workflow: { slug: 'runbook-a', name: 'Runbook A', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A' }] },
      initialPrompt: 'CSUP-77 something',
      watch: 'direct-invocation',
      ticketKey: 'CSUP-77',
      autoRun: true,
      projectDir: join(process.env.AGENT_WORKSPACE_ROOT, 'cancel-me'),
    })
    assert.equal(q.status, 'queued')
    assert.ok(q.queuedAt > 0, 'a queued run records when it joined the queue')
    assert.equal(q.baseCommit, undefined,
      'and carries no baseline: one captured now would name a HEAD that has moved by the time it starts')
    assert.equal(q.branch, undefined, 'and no branch: it has taken no checkout')
    const stopped = await runner.stopRun(q.id)
    assert.equal(stopped.status, 'stopped', 'a queued run can be cancelled')
    assert.ok(stopped.steps.every(s => s.status === 'skipped'), 'and every step it never ran is skipped')
    assert.equal(existsSync(join(process.env.AGENT_RUNS_DIR, q.id, 'artifacts', 'bundle.md')), false,
      'no evidence bundle is assembled for a run that did nothing')
    assert.equal(await store.deleteRun(q.id), 'ok', 'and once stopped it can be deleted')
  }

  process.env.AGENT_MAX_CONCURRENT_PIPELINES = '10'
  void queue

  rmSync(process.env.AGENT_WORKSPACE_ROOT, { recursive: true, force: true })
}

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
rmSync(process.env.AGENT_RUNS_DIR, { recursive: true, force: true })
console.log('workflowRunner: all assertions passed')
