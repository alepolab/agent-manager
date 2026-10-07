/**
 * A resumed agent session is told where the run's artifacts and checkout are
 * now, and that directory exists. ASECRM-270 resumed a session started under
 * another instance, wrote its oracle to that instance's artifacts directory,
 * and failed for a file it had written - the header that names the directory
 * is sent only to a fresh session.
 *
 * Both routes that resume a session are driven for real: a step continuing
 * its own session, and the change brief asked of the step that made the
 * change. Each time the artifacts directory has been deleted first, as a run
 * moved from another instance finds it.
 *
 *   node scripts/test-resume-names-artifacts.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'resume-where-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
process.env.AGENT_WORKSPACE_ROOT = join(root, 'ws')
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const { AgentResultError } = await import('../server/utils/agentCaller.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
const SESSION = 'ses-where'
const PROJECT = 'proj-where'
// A session can be resumed only while its transcript is on disk.
mkdirSync(join(process.env.CLAUDE_DIR, 'projects', PROJECT), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'projects', PROJECT, `${SESSION}.jsonl`), '{"type":"user"}\n')

const workflowFile = wf => writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', `${wf.slug}.json`),
  JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
const told = (input, dir) => input.startsWith(`Artifacts directory for this run: ${dir}\n`)

// ── 1. a step that continues its own session ────────────────────────────────
{
  const wf = { slug: 'where-step', name: 'Where step', steps: [{ id: 'a', agentSlug: 'agent-a', label: 'A', next: [] }] }
  workflowFile(wf)
  const seen = []
  let dir
  runner.setAgentCaller(async (slug, input, cwd, opts = {}) => {
    seen.push({ input, resume: opts.resume, dirThere: existsSync(dir) })
    opts.onSession?.(SESSION, PROJECT)
    if (seen.length === 1) {
      // Gone between the visits, as on an instance that never had this run.
      rmSync(dir, { recursive: true, force: true })
      throw new AgentResultError('Reached maximum number of turns (60)', { input_tokens: 5, output_tokens: 1 }, 'error_max_turns')
    }
    return { output: 'out', model: 'm', usage: null, sessionId: SESSION }
  })
  let r = await runner.startRun({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  dir = runArtifactsDir(r.id)
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(seen[1]?.resume, SESSION, 'the second visit resumed the session')
  assert.ok(told(seen[1].input, dir), `a resumed step is told the artifacts directory before anything else:\n${seen[1].input.slice(0, 200)}`)
  assert.ok(seen[1].dirThere, 'and that directory exists when it is told, though it had been deleted')
}

// ── 2. the change brief, asked of the step that made the change ─────────────
{
  const wf = { slug: 'where-brief', name: 'Where brief', steps: [
    { id: 'fix', agentSlug: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['done'] },
    { id: 'done', agentSlug: 'sdlc-jira-tracker-stub', label: 'Jira: Dev Done', next: [], approval: true },
  ] }
  workflowFile(wf)
  const asks = []
  let dir
  runner.setAgentCaller(async (slug, input, cwd, opts = {}) => {
    if (/reviewer's brief/.test(input)) {
      asks.push({ input, resume: opts.resume, dirThere: existsSync(dir) })
      return 'not written'
    }
    opts.onSession?.(SESSION, PROJECT)
    return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }
  })
  let r = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
  dir = runArtifactsDir(r.id)
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(r.status, 'paused', 'the run waits at its gate')
  rmSync(dir, { recursive: true, force: true })
  const before = asks.length
  await runner.ensureChangeBrief(r)
  const ask = asks[before]
  assert.ok(ask, 'the brief was asked for')
  assert.equal(ask.resume, SESSION, 'of the session that made the change')
  assert.ok(told(ask.input, dir),
    `THE GAP IN THE FIRST FIX: a resumed brief request named no directory and still said to write there:\n${ask.input.slice(0, 200)}`)
  assert.ok(ask.dirThere, 'and the directory exists when it is asked')
}

rmSync(root, { recursive: true, force: true })
console.log('ok - a resumed session is told where the artifacts are now, and they are there')
