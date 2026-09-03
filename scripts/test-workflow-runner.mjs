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

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('workflowRunner: all assertions passed')
