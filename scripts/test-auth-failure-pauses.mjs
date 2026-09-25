/**
 * A step that cannot reach the model pauses its run; it does not fail it.
 *
 * A server started without the Anthropic settings failed nine runs in a row,
 * each within three seconds on "Not logged in · Please run /login". Every
 * failure freed a slot and the next resumed run failed into the same error.
 * That is the server's environment, not the work, and nothing about it is a
 * reason to throw a run away.
 *
 *   node scripts/test-auth-failure-pauses.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'auth-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'auth-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const { isAuthFailure } = runner

for (const m of [
  'Claude Code returned an error result (success, is_error): Not logged in · Please run /login',
  'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  'Invalid API key · Please run /login',
  'OAuth token has expired',
]) assert.ok(isAuthFailure(m), m)
for (const m of [
  'API Error: Request rejected (429) · all 6 accounts are at their quota or rate limit',
  'Claude Code returned an error result (error_max_turns): no further detail',
  'the test asserts login fails with 401 for a bad password',
]) assert.ok(!isAuthFailure(m), m)

const workflow = { slug: 'auth', name: 'Auth', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'Intake', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'Stand Up Stack', next: [] },
] }
let loggedIn = false
const calls = []
runner.setAgentCaller(async (slug) => {
  calls.push(slug)
  if (slug === 'agent-b' && !loggedIn) throw new Error('Claude Code returned an error result (success, is_error): Not logged in · Please run /login')
  return `out ${slug}`
})

let run = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
run = await runner.waitForSettled(run.id, 8000)
assert.equal(run.status, 'paused', `paused, not failed: ${run.error ?? ''}`)
assert.equal(run.question.reason, 'auth')
assert.match(run.question.text, /Stand Up Stack.*could not reach the model.*Not logged in/s, run.question.text)
const b = run.steps.find(s => s.stepId === 'b')
assert.equal(b.status, 'pending', 'the step is put back, not failed')
assert.equal(b.visits, 0, 'and the attempt that never reached a model costs it no visit')
assert.equal(run.steps.find(s => s.stepId === 'a').status, 'completed', 'finished work is kept')

// Credentials fixed: Continue runs the step again and the run finishes.
loggedIn = true
await runner.continueRun(run.id)
run = await runner.waitForSettled(run.id, 8000)
assert.equal(run.status, 'completed', run.error)
assert.deepEqual(calls, ['agent-a', 'agent-b', 'agent-b'], 'the finished step is not re-run; the paused one is')

console.log('ok - a step that cannot reach the model pauses the run')
