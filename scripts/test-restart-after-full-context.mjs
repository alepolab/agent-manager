/**
 * A step that failed because its context was full starts a fresh session when
 * restarted, instead of resuming the one that filled up.
 *
 * ASECRM-372's Failing Test failed on "Autocompact is thrashing" after 94
 * turns. A restart resumes the step's session, so it would have begun at the
 * limit it had just failed at.
 *
 *   node scripts/test-restart-after-full-context.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'full-context-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const { AgentResultError } = await import('../server/utils/agentCaller.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
const PROJECT = 'proj-full'
// A session can be resumed only while its transcript is on disk.
mkdirSync(join(process.env.CLAUDE_DIR, 'projects', PROJECT), { recursive: true })

const THRASH = 'Claude Code returned an error result (success, is_error): Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.'

assert.equal(runner.isContextExhausted(THRASH), true)
assert.equal(runner.isContextExhausted('API Error: 400 prompt is too long: 210000 tokens > 200000 maximum'), true)
assert.equal(runner.isContextExhausted('Reached maximum number of turns (60)'), false)
assert.equal(runner.isContextExhausted('Step halted: the oracle failed on 3 rows'), false)

/** One step that fails once with `error`, then succeeds; returns what each call was asked to resume. */
async function failThenRestart(slug, error) {
  const session = `ses-${slug}`
  writeFileSync(join(process.env.CLAUDE_DIR, 'projects', PROJECT, `${session}.jsonl`), '{"type":"user"}\n')
  const wf = { slug, name: slug, steps: [{ id: 's', agentSlug: 'agent-s', label: 'Failing Test', next: [], maxVisits: 1 }] }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${slug}.json`),
    JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
  const resumes = []
  runner.setAgentCaller(async (_slug, _input, _cwd, opts = {}) => {
    resumes.push(opts.resume)
    opts.onSession?.(session, PROJECT)
    if (resumes.length === 1) throw new AgentResultError(error, { input_tokens: 5, output_tokens: 1 }, 'error_during_execution')
    return { output: 'out', model: 'm', usage: null, sessionId: session }
  })
  let r = await runner.startRun({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'failed', `${slug}: the first attempt fails the run`)
  // The failure is published a moment before the run lets go of its slot.
  for (let i = 0; ; i++) {
    try { await runner.restartRun(r.id, 's', 'try again'); break }
    catch (err) { if (err.statusCode !== 409 || i > 50) throw err; await new Promise(res => setTimeout(res, 20)) }
  }
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'completed', `${slug}: the restart completes`)
  return resumes
}

// ── 1. a full context: the restart starts fresh ──
{
  const resumes = await failThenRestart('full', THRASH)
  assert.equal(resumes.length, 2)
  assert.equal(resumes[1], undefined, `THE REGRESSION: a step that failed on a full context resumed the same session (${resumes[1]})`)
}

// ── 2. any other failure: the restart still continues where it was ──
{
  const resumes = await failThenRestart('other', 'Claude Code returned an error result (success, is_error): Step halted: the oracle failed on 3 rows')
  assert.equal(resumes[1], 'ses-other', 'a step that failed for another reason keeps its session on restart')
}

rmSync(root, { recursive: true, force: true })
console.log('ok - a step whose context filled up is restarted in a fresh session')
process.exit(0)
