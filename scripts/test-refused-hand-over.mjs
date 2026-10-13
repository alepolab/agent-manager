/**
 * A step that hands the run to a step that cannot run yet is refused and the
 * run pauses for a person - it does not fail.
 *
 * ASECRM-243: PR Checks sent the run back to Implement Fix, which then printed
 * PIPELINE-REWORK naming Verify + Regression while Code Review and the Jira
 * steps feeding it were pending again. restartRun threw "has predecessors that
 * did not complete" inside the run loop and a run with an open PR failed.
 *
 *   node scripts/test-refused-hand-over.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'handoff-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'handoff-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'handoff-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const { gateAsk } = await import('../shared/utils/notifications.ts')
let preflights = 0
runner.setPreflight(async () => { preflights++; return { at: Date.now(), checks: [] } })
const TIMEOUT = 15000

const wf = { slug: 'handoff', name: 'Hand-over', steps: [
  { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['review'] },
  { id: 'review', agentSlug: 'agent-review', label: 'Code Review', next: ['verify'] },
  { id: 'verify', agentSlug: 'agent-verify', label: 'Verify + Regression', next: ['checks'] },
  { id: 'checks', agentSlug: 'agent-checks', label: 'PR Checks + Review', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const calls = []
let checksVisits = 0
let fixVisits = 0
runner.setAgentCaller(async (slug, input) => {
  calls.push(slug)
  if (slug === 'agent-checks') {
    checksVisits++
    // First pass: CI is red, send it back to the fix.
    return checksVisits === 1 ? 'CI red.\nPIPELINE-REWORK: Implement Fix — two ITs fail in the shared JVM' : 'green'
  }
  if (slug === 'agent-fix') {
    fixVisits++
    // Sent back: the fix lives in a test file this step may not touch, so it
    // hands on - to a step downstream of the one it would run next.
    return fixVisits === 2 ? 'Blocked by the oracle lock.\nPIPELINE-REWORK: Verify + Regression — add DelegateHandler.class to the reset list' : 'fixed'
  }
  return `out ${slug}`
})

// ── the refusal: paused for a person, not failed ─────────────────────────────
let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
run = await runner.waitForSettled(run.id, TIMEOUT)
assert.notEqual(run.status, 'failed', `THE REGRESSION: the run failed on the hand-over: ${run.error}`)
assert.equal(run.status, 'paused')
assert.equal(run.error, undefined)
assert.equal(run.endedAt, undefined, 'not a finished run')
const q = run.question
assert.equal(q.kind, 'approval')
assert.equal(q.reason, 'handoff')
assert.equal(q.stepId, 'review', 'Continue carries on from the step the run would run next')
assert.deepEqual(run.nextStepIds, ['review'])
assert.deepEqual(q.handoff, { from: 'fix', target: 'verify', instruction: 'add DelegateHandler.class to the reset list', waitingOn: ['review'] })
assert.match(q.text, /"Implement Fix" handed the run to "Verify \+ Regression", which cannot run yet: "Code Review" has to complete first/)
assert.match(q.text, /add DelegateHandler\.class to the reset list/, 'the instruction verbatim')
assert.match(q.text, /Carry on from "Code Review" without the hand-over/, "worded as the button is")
assert.equal(run.reworks, 1, 'the refused hand-over is not counted: only the send-back from PR Checks is')
assert.equal(Object.values(run.reworksBy ?? {}).reduce((a, b) => a + b, 0), 1, 'nor in any send-back bucket')
assert.equal(run.steps.find(s => s.stepId === 'fix').status, 'completed')
assert.equal(run.steps.find(s => s.stepId === 'review').status, 'pending', 'nothing downstream ran')
assert.equal(calls.filter(c => c === 'agent-verify').length, 1, 'Verify ran once, before the send-back')
assert.match(gateAsk(run), /hand-over was refused/)

// ── Continue: the run carries on from Code Review, without the hand-over ─────
await runner.continueRun(run.id)
run = await runner.waitForSettled(run.id, TIMEOUT)
assert.equal(run.status, 'completed', run.error)
assert.equal(run.question, undefined)
assert.deepEqual(calls, ['agent-fix', 'agent-review', 'agent-verify', 'agent-checks', 'agent-fix', 'agent-review', 'agent-verify', 'agent-checks'])

// ── Carry on approves nothing: a gated next step still asks its owner ───────
// The pause names Code Review only as where the run goes next. Continue once
// marked it approved, which waived its approval gate and gateRole: a refused
// hand-over plus one click ran a developer's gate straight through. Run twice,
// the second time with the live record dropped before Continue, as a server
// restart between the pause and the answer leaves it.
for (const restarted of [false, true]) {
  const gated = { ...wf, slug: `handover-gated${restarted ? '-restarted' : ''}`, steps: wf.steps.map(s => s.id === 'review' ? { ...s, approval: true, gateRole: 'developer' } : s) }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${gated.slug}.json`),
    JSON.stringify({ name: gated.name, description: '', steps: gated.steps, createdAt: new Date().toISOString() }))
  calls.length = 0; checksVisits = 0; fixVisits = 0
  const tag = restarted ? ' (after a restart)' : ''
  let g = (await runner.startOrQueue({ workflow: gated, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
  g = await runner.waitForSettled(g.id, TIMEOUT)
  // First pause: Code Review's own gate, before anything has run past it.
  assert.equal(g.question?.stepId, 'review'); assert.equal(g.question?.reason, undefined)
  await runner.continueRun(g.id, 'looks right')
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.question?.reason, 'handoff', `the hand-over is refused${tag}`)
  assert.equal(g.question?.stepId, 'review')
  if (restarted) {
    runner._dropLive(g.id)
    // Owner-gated as well: carrying on approves nothing, so it asks no reason -
    // the step's own approval below still does.
    const stored = await store.getRun(g.id)
    await store.saveRun({ ...stored, blastRadius: 'money' })
  }
  await runner.continueRun(g.id)
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'paused', `THE REGRESSION: carrying on past the hand-over ran the gated step${tag}: ${g.status}`)
  assert.equal(g.question?.stepId, 'review', `it stops at Code Review's own gate${tag}`)
  assert.equal(g.question?.reason, undefined, `as an ordinary approval, not the hand-over again${tag}`)
  assert.equal(g.question?.role, 'developer', `asking the developer, whose gate it is${tag}`)
  assert.equal(calls.filter(c => c === 'agent-review').length, 1, `Code Review did not run a second time without its approval${tag}`)
  if (restarted) await assert.rejects(runner.continueRun(g.id), /owner-gated/, 'the gated step\'s own approval still needs its reason')
  await runner.continueRun(g.id, 'reviewed the fix')
  g = await runner.waitForSettled(g.id, TIMEOUT)
  assert.equal(g.status, 'completed', g.error)
  assert.equal(calls.filter(c => c === 'agent-review').length, 2, `it ran once its owner approved it${tag}`)
}

// ── a person's restart at a blocked step is refused before anything is reset ─
{
  const stored = await store.getRun(run.id)
  // As a stopped run with Code Review never re-run would read.
  stored.status = 'stopped'
  for (const s of stored.steps) if (s.stepId === 'review') Object.assign(s, { status: 'pending', output: '' })
  for (const s of stored.steps) if (s.stepId === 'checks') Object.assign(s, { output: 'kept' })
  await store.saveRun(stored)
  const before = preflights
  await assert.rejects(runner.restartRun(run.id, 'verify', 'try'), /has predecessors that did not complete/)
  assert.equal(preflights, before, 'refused before the worktree rebuild and preflight a restart that cannot happen would spend')
  const after = await store.getRun(run.id)
  assert.equal(after.status, 'stopped')
  assert.equal(after.steps.find(s => s.stepId === 'checks').output, 'kept', 'descendants were not reset by a refused restart')
}

console.log('ok - a hand-over to a step that cannot run yet pauses for a person, and does not fail the run')
