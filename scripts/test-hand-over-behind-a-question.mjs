/**
 * A hand-over that arrives while another step in the same wave is asking the
 * operator a question waits behind that question; it does not replace it.
 *
 * Found in review of the refused hand-over (#143): with `fix -> review ->
 * verify` beside `ask -> verify`, Implement Fix handed the run to Verify while
 * the parallel step asked a question. The refusal overwrote the question with
 * its own prompt; after Continue the run sat paused on the asking step with no
 * question at all, and nothing could answer it.
 *
 *   node scripts/test-hand-over-behind-a-question.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'handoff-ask-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'handoff-ask-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'handoff-ask-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const TIMEOUT = 15000

const wf = { slug: 'handoff-ask', name: 'Hand-over beside a question', steps: [
  { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['review'] },
  { id: 'ask', agentSlug: 'agent-ask', label: 'Ask', next: ['verify'] },
  { id: 'review', agentSlug: 'agent-review', label: 'Code Review', next: ['verify'] },
  { id: 'verify', agentSlug: 'agent-verify', label: 'Verify + Regression', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

const calls = []
runner.setAgentCaller(async (slug, input) => {
  calls.push(slug)
  if (slug === 'agent-fix') return calls.filter(c => c === 'agent-fix').length === 1
    ? 'Blocked.\nPIPELINE-REWORK: Verify + Regression — add DelegateHandler.class to the reset list'
    : 'fixed'
  if (slug === 'agent-ask') {
    if (/User response/.test(input)) return 'answered'
    const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
    writeFileSync(join(dir, 'decision.json'), JSON.stringify({ question: 'Which base?', situation: 's',
      options: [{ key: 'a', label: 'develop', next: 'n', delivers: 'd', leaves: 'l' }, { key: 'b', label: 'the PR branch', next: 'n', delivers: 'd', leaves: 'l' }] }))
    return 'PIPELINE-ASK: Which base?'
  }
  return `out ${slug}`
})

for (const restart of [false, true]) {
  calls.length = 0
  let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: `dev-${restart}` })).run
  run = await runner.waitForSettled(run.id, TIMEOUT)

  // The question stands; the hand-over is held behind it.
  assert.equal(run.status, 'paused')
  assert.equal(run.question?.kind, 'question', `THE REGRESSION: the parallel step's question was replaced (${run.question?.reason ?? 'no question'})`)
  assert.equal(run.question.stepId, 'ask')
  assert.ok(run.question.brief, 'with its brief')
  assert.deepEqual(run.currentStepIds, ['ask'])
  assert.deepEqual(run.deferredRework, { from: 'fix', target: 'verify', instruction: 'add DelegateHandler.class to the reset list' }, 'the hand-over is held on the record')
  assert.equal(run.reworks ?? 0, 0, 'nothing counted yet')

  if (restart) runner._dropLive(run.id)

  // Answering the question brings the hand-over back - refused now, because
  // Code Review still has to run before Verify can.
  await runner.respondToRun(run.id, 'a')
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'paused')
  assert.equal(run.steps.find(s => s.stepId === 'ask').status, 'completed', 'the answer reached the step')
  assert.equal(run.question?.reason, 'handoff', 'then the held hand-over is put to the operator')
  assert.deepEqual(run.question.handoff.waitingOn, ['review'])
  assert.equal(run.deferredRework, undefined, 'and is no longer held')

  // Carrying on finishes the run.
  if (restart) runner._dropLive(run.id)
  await runner.continueRun(run.id)
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'completed', run.error)
  assert.equal(calls.filter(c => c === 'agent-verify').length, 1, 'Verify ran once, after both its feeders')
}

// ── A hand-over that the answer unblocks is carried out, not refused ────────
{
  const wf2 = { slug: 'handoff-ask-2', name: 'Unblocked by the answer', steps: [
    { id: 'review', agentSlug: 'agent-review2', label: 'Code Review', next: ['verify'] },
    { id: 'ask', agentSlug: 'agent-ask', label: 'Ask', next: ['verify'] },
    { id: 'verify', agentSlug: 'agent-verify2', label: 'Verify + Regression', next: [] },
  ] }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf2.slug}.json`),
    JSON.stringify({ name: wf2.name, description: '', steps: wf2.steps, createdAt: new Date().toISOString() }))
  let verifyInputs = []
  runner.setAgentCaller(async (slug, input) => {
    calls.push(slug)
    if (slug === 'agent-review2') return calls.filter(c => c === 'agent-review2').length === 1 ? 'PIPELINE-REWORK: Verify + Regression — rerun with the seed' : 'ok'
    if (slug === 'agent-verify2') { verifyInputs.push(input); return 'verified' }
    if (slug === 'agent-ask') {
      if (/User response/.test(input)) return 'answered'
      const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
      writeFileSync(join(dir, 'decision.json'), JSON.stringify({ question: 'Which base?', situation: 's',
        options: [{ key: 'a', label: 'develop', next: 'n', delivers: 'd', leaves: 'l' }, { key: 'b', label: 'other', next: 'n', delivers: 'd', leaves: 'l' }] }))
      return 'PIPELINE-ASK: Which base?'
    }
    return `out ${slug}`
  })
  calls.length = 0
  let run = (await runner.startOrQueue({ workflow: wf2, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev-unblocked' })).run
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.question?.kind, 'question')
  await runner.respondToRun(run.id, 'a')
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.notEqual(run.question?.reason, 'handoff', 'Verify can run now, so the hand-over is not refused')
  assert.equal(run.status, 'completed', run.error)
  assert.ok(verifyInputs.some(i => /rerun with the seed/.test(i)), 'and Verify received the instruction')
  assert.equal(run.reworks, 1, 'counted as the send-back it is')
}

console.log('ok - a hand-over waits behind an open question, and is judged once it is answered')
process.exit(0)
