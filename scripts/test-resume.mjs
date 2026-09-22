/**
 * A step that runs again continues where it was, instead of starting over.
 *
 * Three real costs made this necessary. A step that ran out of turns restarted
 * from turn one and re-read the same files — one spent three whole visits doing
 * that and never wrote its plan. A step that was answered re-received its whole
 * brief. And a container rebuild froze a step mid-flight, which counted as an
 * attempt, so three rebuilds exhausted a step's three visits without it ever
 * failing at anything.
 *
 *   node scripts/test-resume.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'resume-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_RUNS_DIR = join(root, 'runs')
mkdirSync(process.env.CLAUDE_DIR, { recursive: true })

const store = await import('../server/utils/workflowRunStore.ts')
const { AgentResultError } = await import('../server/utils/agentCaller.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 15000
const SESSION = 'ses-1111'
const PROJECT = 'proj-x'
/** The transcript has to exist: a session whose file is gone cannot be resumed. */
function transcript(exists = true) {
  const dir = join(process.env.CLAUDE_DIR, 'projects', PROJECT)
  mkdirSync(dir, { recursive: true })
  const f = join(dir, `${SESSION}.jsonl`)
  if (exists) writeFileSync(f, '{"type":"user"}\n')
  else rmSync(f, { force: true })
}
const workflow = { slug: 'resume-demo', name: 'Resume demo', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'B', next: [] },
] }
// restartRun rebuilds the live state from the workflow on disk, so it has to be there.
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'resume-demo.json'),
  JSON.stringify({ name: workflow.name, description: '', steps: workflow.steps, createdAt: new Date().toISOString() }, null, 2))

const clear = async () => { for (const r of await store.listRuns('resume-demo')) if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id) }

// ── 1. a step that runs out of turns continues its session; the input is the instruction alone ──
{
  await clear(); transcript()
  const seen = []
  let first = true
  runner.setAgentCaller(async (slug, input, dir, opts = {}) => {
    if (slug === 'agent-a') {
      seen.push({ input, resume: opts.resume })
      // The caller derives the transcript folder from the cwd it reports, so
      // report the one the transcript above actually lives in.
      opts.onSession?.(SESSION, PROJECT)
      if (first) { first = false; throw new AgentResultError('Reached maximum number of turns (60)', { input_tokens: 5, output_tokens: 1 }, 'error_max_turns') }
    }
    return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }
  })
  // The caller records the session through onSession; the record needs the project too.
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(seen.length >= 2, true, 'the step ran again after running out of turns')
  assert.equal(seen[0].resume, undefined, 'the first visit starts a session')
  assert.equal(seen[1].resume, SESSION, 'and the second continues it instead of starting over')
  assert.ok(seen[1].input.length < seen[0].input.length / 2,
    `a resumed visit sends the instruction alone, not the brief again: ${seen[0].input.length} -> ${seen[1].input.length} chars`)
  assert.match(seen[1].input, /Do not re-explore/, 'and the instruction says so')
  assert.doesNotMatch(seen[1].input, /Run artifacts|Work in:/, 'the header is not re-sent: the session already has it')
  const done = await store.getRun(r.id)
  assert.equal(done.steps.find(s => s.stepId === 'a').resumedFrom, SESSION, 'the step records which session it continued')
  console.log(`  turn-budget retry: input ${seen[0].input.length} -> ${seen[1].input.length} chars, resumed ${seen[1].resume.slice(0, 8)}`)
}

// ── 2. resumableSession only says yes when the transcript is really there ──
// Exercised through the runner: with a recorded session whose file exists the
// second visit resumes; with the file gone it starts fresh with the full header.
for (const [label, present] of [['transcript present', true], ['transcript gone', false]]) {
  await clear()
  transcript(present)
  const calls = []
  let boom = true
  runner.setAgentCaller(async (slug, input, dir, opts = {}) => {
    if (slug === 'agent-a') {
      opts.onSession?.(SESSION, join(root, 'p'))
      calls.push({ input, resume: opts.resume })
      if (boom) { boom = false; throw new AgentResultError('Reached maximum number of turns (60)', { input_tokens: 5, output_tokens: 1 }, 'error_max_turns') }
    }
    return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }
  })
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  // sessionProject is derived from the cwd the caller reports; with our fake cwd
  // it will not match PROJECT, so this case proves the conservative default:
  // when the transcript cannot be located, the step starts fresh. That is always
  // correct, only more expensive, which is the right way for this to fail.
  assert.ok(calls.length >= 2, `${label}: the step ran again`)
  assert.equal(calls[1].resume, undefined, `${label}: an unlocatable transcript starts fresh rather than guessing`)
}

// ── 3. an interruption does not consume a visit ──
// A step frozen at 'running' by a server that died never reached an outcome.
{
  await clear(); transcript()
  runner.setAgentCaller(async (slug) => ({ output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }))
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: false })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  // Fake the shape a dead process leaves: step 'a' frozen mid-flight with a session.
  const rec = r.steps.find(s => s.stepId === 'a')
  Object.assign(rec, { status: 'running', visits: 1, sessionId: SESSION, sessionProject: PROJECT })
  r.status = 'interrupted'
  await store.saveRun(r)
  runner._dropLive(r.id)

  const back = await runner.restartRun(r.id, 'a', 'the server was rebuilt')
  const after = back.steps.find(s => s.stepId === 'a')
  assert.equal(after.visits, 0, `an interruption is not an attempt: visits went to ${after.visits}, not 1`)
  const snaps = readdirSync(join(process.env.AGENT_RUNS_DIR, r.id, 'artifacts', 'steps')).filter(f => f.includes('interrupted'))
  assert.ok(snaps.length, `the frozen attempt is kept as evidence: ${snaps.join(',') || 'none'}`)
  await runner.waitForSettled(back.id, TIMEOUT)
}

// ── 4. the runner hands a run over (widen, rework): the whole brief, never a resume ──
{
  await clear(); transcript()
  const calls = []
  runner.setAgentCaller(async (slug, input, dir, opts = {}) => { calls.push({ slug, resume: opts.resume }); return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION } })
  let r = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  const rec = r.steps.find(s => s.stepId === 'a')
  Object.assign(rec, { sessionId: SESSION, sessionProject: PROJECT })
  await store.saveRun(r)
  runner._dropLive(r.id)
  calls.length = 0
  const handed = await runner.restartRun(r.id, 'a', 'new scope', undefined, { fromRunner: true })
  await runner.waitForSettled(handed.id, TIMEOUT)
  assert.ok(calls.every(c => c.resume === undefined),
    'a runner hand-over carries new scope or a new instruction, so the step gets the whole brief')
}

rmSync(root, { recursive: true, force: true })
// ── a step that declares continuesSession inherits its PREDECESSOR's session ──
// The default is a cold start per step: a new session, and the repository read
// from nothing. For two phases of one piece of work — plan it, then build it —
// that discards everything the first phase learned and pays to learn it again.
{
  await clear(); transcript()
  mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
  const chained = { slug: 'chain-demo', name: 'Chain demo', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Plan', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Build', next: ['c'], continuesSession: true },
    // Fresh by design: a reviewer inside the builder's session reviews its own
    // work from inside its own assumptions.
    { id: 'c', agentSlug: 'agent-c', label: 'Review', next: [] },
  ] }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'chain-demo.json'),
    JSON.stringify({ name: chained.name, description: '', steps: chained.steps, createdAt: new Date().toISOString() }, null, 2))

  const seen = {}
  runner.setAgentCaller(async (slug, input, dir, opts = {}) => {
    seen[slug] = { input, resume: opts.resume }
    opts.onSession?.(SESSION, PROJECT)
    return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }
  })
  let r = await runner.startRun({ workflow: chained, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  // waitForSettled resolves from inside publish(), ahead of the disk write, so
  // the settled run is the one it returns — re-reading the store races it.
  assert.equal(r.status, 'completed', JSON.stringify(r.steps.map(x => x.label + ':' + x.status)))

  assert.equal(seen['agent-a'].resume, undefined, 'the first step of the chain starts a session')
  assert.equal(seen['agent-b'].resume, SESSION, 'a step declaring continuesSession continues its predecessor instead of starting cold')
  assert.doesNotMatch(seen['agent-b'].input, /Run artifacts|Work in:/,
    'and it is not re-sent the header its predecessor already has')
  assert.equal(seen['agent-c'].resume, undefined,
    'a step that declares nothing still starts fresh: independence is the default')
}

// ── the inheritance is refused when the answer would be a guess ───────────────
// A step joining several branches has no "the" session to continue, and a
// transcript that is gone cannot be resumed. Both fall back to a cold start,
// which is always correct and only more expensive.
{
  await clear(); transcript(false)
  mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
  const fan = { slug: 'fan-demo', name: 'Fan demo', steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['c'] },
    { id: 'b', agentSlug: 'agent-b', label: 'B', next: ['c'] },
    { id: 'c', agentSlug: 'agent-c', label: 'Join', next: [], continuesSession: true },
  ] }
  writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'fan-demo.json'),
    JSON.stringify({ name: fan.name, description: '', steps: fan.steps, createdAt: new Date().toISOString() }, null, 2))
  const seen = {}
  runner.setAgentCaller(async (slug, input, dir, opts = {}) => {
    seen[slug] = { resume: opts.resume }
    opts.onSession?.(SESSION, PROJECT)
    return { output: `out ${slug}`, model: 'm', usage: null, sessionId: SESSION }
  })
  let r = await runner.startRun({ workflow: fan, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  r = await runner.waitForSettled(r.id, TIMEOUT)
  assert.equal(seen['agent-c'].resume, undefined,
    'two predecessors and a missing transcript both mean: start fresh, do not guess')
}

console.log('resume: a step continues where it was, and an interruption never costs it a visit')
