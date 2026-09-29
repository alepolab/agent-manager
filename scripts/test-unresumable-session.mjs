/**
 * A step whose session the API will not continue is run again cold, once,
 * instead of failing the run.
 *
 * ASECRM-290's Failing Test was interrupted by a server reload and resumed
 * into "API Error: 400 due to tool use concurrency issues": the transcript
 * held a tool call with no result. The run failed, and a restart would have
 * resumed the same transcript into the same error.
 *
 *   node scripts/test-unresumable-session.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'unresumable-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'unresumable-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'unresumable-ws-'))
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

assert.equal(runner.isUnresumable('Claude Code returned an error result (success, is_error): API Error: 400 due to tool use concurrency issues.'), true)
assert.equal(runner.isUnresumable('messages.3: `tool_use` ids were found without `tool_result` blocks immediately after'), true)
assert.equal(runner.isUnresumable('API Error: 400 prompt is too long'), false)

const workflow = { slug: 'one', name: 'One', steps: [{ id: 's', agentSlug: 'agent-s', label: 'Step', next: [] }] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'one.json'), JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps, createdAt: new Date().toISOString() }))
const cwd = '/work/one'
const project = cwd.replace(/[^A-Za-z0-9]/g, '-')
const calls = []
let script = []
runner.setAgentCaller(async (_slug, _input, _dir, opts) => {
  calls.push(opts?.resume)
  const next = script.shift()
  if (!opts?.resume) {
    // The session the step records, with its transcript on disk, so a restart resumes it.
    const sid = `sess-${calls.length}`
    mkdirSync(join(process.env.CLAUDE_DIR, 'projects', project), { recursive: true })
    writeFileSync(join(process.env.CLAUDE_DIR, 'projects', project, `${sid}.jsonl`), '{}\n')
    opts?.onSession?.(sid, cwd)
  }
  if (next instanceof Error) throw next
  return next ?? 'done'
})

// The failed wave finishes settling a moment after the status is published.
const restart = async (id) => {
  for (let i = 0; ; i++) {
    try { return await runner.restartRun(id, 's') } catch (e) { if (i > 100 || !/running run/.test(e.message)) throw e }
    await new Promise(r => setTimeout(r, 25))
  }
}

// ── Resumed into the refusal: run again cold, and the run completes ──────────
{
  script = [new Error('interrupted')]
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  let run = await runner.waitForSettled(started.id, 8000)
  assert.equal(run.status, 'failed')
  script = [new Error('API Error: 400 due to tool use concurrency issues.'), 'done']
  await restart(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  assert.deepEqual(calls, [undefined, 'sess-1', undefined], 'the restart resumed; the retry after the refusal did not')
  assert.equal(run.status, 'completed', 'the refusal did not fail the run')
  assert.equal(run.steps[0].visits, 2, 'the refused visit was handed back')
}

// ── Once: a cold call that fails the same way fails the step ────────────────
{
  calls.length = 0
  script = [new Error('interrupted')]
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  let run = await runner.waitForSettled(started.id, 8000)
  script = [new Error('tool use concurrency issues'), new Error('tool use concurrency issues')]
  await restart(run.id)
  run = await runner.waitForSettled(run.id, 8000)
  assert.equal(calls.length, 3, 'one cold retry, not a loop')
  assert.equal(run.status, 'failed')
}

console.log('ok - a step whose session cannot be resumed runs again cold, once')
process.exit(0)
