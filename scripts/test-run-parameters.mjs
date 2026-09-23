/**
 * Self-check for a run's declared inputs, end to end: the block agents are
 * told them in, the run record that carries them, and what a dispatched child
 * inherits.
 *
 * These assertions live in their own file rather than in
 * test-run-artifacts.mjs and test-workflow-runner.mjs, where they logically
 * belong, because both of those suites already abort earlier than the point
 * they would sit at - one on a POSIX-only path assertion, one on the
 * stopped/failed regression - and an assertion after an abort is an assertion
 * that never runs.
 *
 *   node scripts/test-run-parameters.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'runparams-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runparams-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'runparams-workspaces-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '10'

const A = await import('../server/utils/runArtifacts.ts')
const runner = await import('../server/utils/workflowRunner.ts')
const store = await import('../server/utils/workflowRunStore.ts')

const TIMEOUT = 5000
const BLOCK = /^## Run parameters$/m
const occurrences = (text, needle) => text.split(needle).length - 1

// ══ 1. the block, in isolation ════════════════════════════════════════════
{
  const dir = process.env.AGENT_RUNS_DIR

  assert.doesNotMatch(A.artifactHeader(dir), BLOCK,
    'no parameters, no block - a run given nothing must not be handed an empty section')
  assert.doesNotMatch(A.artifactHeader(dir, undefined, undefined, undefined, undefined, {}), BLOCK,
    'an empty map is the same as none')

  const stated = A.artifactHeader(dir, undefined, undefined, 'run-1', undefined, {
    projectDir: '/repos/ase', jira_project: 'DEVOPS',
  })
  assert.match(stated, BLOCK, 'stated parameters get their own section')
  assert.match(stated, /^projectDir: \/repos\/ase$/m, 'each one is stated as a fact, one per line')
  assert.match(stated, /^jira_project: DEVOPS$/m)
  assert.match(stated, /do not re-derive them from the prompt/,
    'and the block says not to re-derive them, which is the whole point of declaring them')

  // A value that resolved to nothing is worse than absent: `severity: ` in a
  // header teaches an agent nothing and invites it to invent one.
  const partly = A.artifactHeader(dir, undefined, undefined, 'run-1', undefined, { a: 'x', b: '' })
  assert.match(partly, /^a: x$/m)
  assert.doesNotMatch(partly, /^b: $/m, 'an empty value is dropped, not stated as blank')
}

// ══ 2. every step is told them ════════════════════════════════════════════
const workflow = {
  slug: 'params-demo', name: 'Params Demo',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'A', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'B', next: [] },
  ],
}

// On disk too: rehydrate reads the definition from CLAUDE_DIR/workflows rather
// than from the run, so section 3's restart needs it there.
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(
  join(process.env.CLAUDE_DIR, 'workflows', 'params-demo.json'),
  JSON.stringify({ name: workflow.name, steps: workflow.steps }),
)

{
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  let run = await runner.startRun({
    workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
    parameters: { jira_project: 'DEVOPS', severity: 'high' },
  })
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'completed')

  assert.deepEqual(run.parameters, { jira_project: 'DEVOPS', severity: 'high' },
    'the run record carries what it was given, so a reader can see what it ran with')

  for (const step of run.steps) {
    assert.match(step.input, BLOCK, `step ${step.stepId} was told the run parameters`)
    assert.match(step.input, /^severity: high$/m, `step ${step.stepId} got the values, not just the heading`)
    assert.equal(occurrences(step.input, '## Run parameters'), 1,
      `step ${step.stepId} was told them exactly once`)
  }
}

// ══ 3. THE TRAP: rehydrate strips the header by exact prefix match ═════════
// executeNode prepends the header, and rehydrate rebuilds lastInputs by
// slicing that same string back off. Build the header without the parameters
// and the strip silently misses, leaving the block in lastInputs to be
// compounded once per retry - so a run that restarts after a process restart
// is where a mismatch shows up.
{
  runner.setAgentCaller(async agentSlug => `output of ${agentSlug}`)
  let run = await runner.startRun({
    workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
    parameters: { jira_project: 'DEVOPS' },
  })
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'completed')

  runner._dropLive(run.id) // as a server restart would
  run = await runner.restartRun(run.id, 'b')
  run = await runner.waitForSettled(run.id, TIMEOUT)

  const restarted = run.steps.find(s => s.stepId === 'b')
  assert.equal(occurrences(restarted.input, '## Run parameters'), 1,
    'the block appears once after a restart through rehydrate, not twice')
  assert.match(restarted.input, /^jira_project: DEVOPS$/m,
    'and it is still there at all - a strip that overshot would have taken it')
}

// ══ 4. what a dispatched child inherits ═══════════════════════════════════
{
  const wfDir = join(process.env.CLAUDE_DIR, 'workflows')
  mkdirSync(wfDir, { recursive: true })

  // The child declares ONE of the parent's inputs, plus one the parent has no
  // value for but which is optional, plus projectDir - which must never cross.
  writeFileSync(join(wfDir, 'child-declares.json'), JSON.stringify({
    name: 'Child Declares',
    parameters: [
      { name: 'jira_project' },
      { name: 'projectDir' },
      { name: 'unrelated' },
    ],
    steps: [{ id: 'only', agentSlug: 'agent-child', label: 'Only', next: [] }],
  }))
  // A child that insists on something nobody stated.
  writeFileSync(join(wfDir, 'child-demands.json'), JSON.stringify({
    name: 'Child Demands',
    parameters: [{ name: 'must_have', required: true }],
    steps: [{ id: 'only', agentSlug: 'agent-child', label: 'Only', next: [] }],
  }))

  const dispatchFlow = routes => ({
    slug: 'dispatch-demo', name: 'Dispatch Demo',
    steps: [
      { id: 's', agentSlug: 'agent-s', label: 'Scan', next: ['d'] },
      {
        id: 'd', agentSlug: 'sdlc-auto-dispatcher', label: 'Dispatch', next: [],
        triggerWorkflow: { source: 'tickets.json', routeBy: 'work_type', routes },
      },
    ],
  })

  function scanWriting(tickets) {
    return async (agentSlug, input) => {
      if (agentSlug === 'agent-s') {
        const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
        writeFileSync(join(dir, 'tickets.json'), JSON.stringify(tickets))
      }
      return `output of ${agentSlug}`
    }
  }

  // ── 4a. only declared names cross; projectDir never does ────────────────
  runner.setAgentCaller(scanWriting([{ jira_key: 'CSUP-1', work_type: 'bug', summary: 'crash' }]))
  let parent = await runner.startRun({
    workflow: dispatchFlow({ bug: 'child-declares' }),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
    parameters: { jira_project: 'DEVOPS', severity: 'high', projectDir: '/parent/checkout' },
  })
  parent = await runner.waitForSettled(parent.id, TIMEOUT)
  assert.equal(parent.status, 'completed', parent.error ?? 'the dispatch step completed')

  const children = (await store.listRuns()).filter(r => r.parentRunId === parent.id)
  assert.equal(children.length, 1, 'one child per entry')
  const child = children[0]

  assert.deepEqual(child.parameters, { jira_project: 'DEVOPS' },
    'the child inherits the one input it declares: severity was never declared by it,'
    + ' and projectDir never crosses however it is declared')
  assert.notEqual(child.projectDir, '/parent/checkout',
    'the child works in its own directory, not the parent\'s')
  assert.match(child.projectDir, /CSUP-1/, 'which is named after its own entry')

  // ── 4b. an unsatisfiable child is reported, and does not strand the batch ─
  runner.setAgentCaller(scanWriting([
    { jira_key: 'CSUP-2', work_type: 'bug', summary: 'fine' },
    { jira_key: 'CSUP-3', work_type: 'feature', summary: 'needs more' },
  ]))
  let mixed = await runner.startRun({
    workflow: dispatchFlow({ bug: 'child-declares', feature: 'child-demands' }),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
    parameters: { jira_project: 'DEVOPS' },
  })
  mixed = await runner.waitForSettled(mixed.id, TIMEOUT)

  const dispatchStep = mixed.steps.find(s => s.stepId === 'd')
  assert.match(dispatchStep.output, /Could not dispatch CSUP-3 to child-demands: it needs must_have/,
    'the entry whose child demanded an unstated input says so, by name')
  assert.match(dispatchStep.output, /Dispatched CSUP-2 to child-declares/,
    'and the satisfiable entry still went - one bad route must not strand the batch')
  assert.equal(mixed.status, 'completed',
    'a partially dispatched batch is not a failed step')

  const spawned = (await store.listRuns()).filter(r => r.parentRunId === mixed.id)
  assert.equal(spawned.length, 1, 'exactly one child started; the unsatisfiable one never did')

  // ── 4c. every entry unsatisfiable IS a failure - nothing was produced ────
  runner.setAgentCaller(scanWriting([{ jira_key: 'CSUP-4', work_type: 'feature', summary: 'x' }]))
  let none = await runner.startRun({
    workflow: dispatchFlow({ feature: 'child-demands' }),
    initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true,
    parameters: {},
  })
  none = await runner.waitForSettled(none.id, TIMEOUT)
  assert.equal(none.status, 'failed',
    'a dispatch step that started nothing at all reports a failure, not a quiet success')
  assert.match(none.steps.find(s => s.stepId === 'd').error ?? '', /nothing could be started/)
}

console.log('run parameters: all assertions passed')
