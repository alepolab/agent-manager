/**
 * Self-check for how a PIPELINE-REWORK names the step it sends the run back to.
 *
 * The defect, observed on run 2c051fa8 (2026-09-09): sdlc-fix-implementer ended
 * its second attempt with
 *
 *   PIPELINE-REWORK: step-04 sdlc-test-author — <what to change>
 *
 * naming the right step, decorated with its own step number. The runner matched
 * a target by EXACT equality against a step's label or agentSlug, so this
 * matched nothing and the run was marked failed 70.3 minutes and $7.96 in, with
 * Ticket Intake, Stand Up Stack and Failing Test already green and every
 * downstream step skipped. The information needed to route it was right there
 * in the string.
 *
 * Tolerance has a hard limit: a target that names more than one step must still
 * fail, because sending a run to an arbitrary one of two candidates is worse
 * than stopping.
 *
 *   node scripts/test-rework-target-matching.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'rework-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'rework-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
const { parseRework } = await import('../shared/utils/workflowGraph.ts')

const TIMEOUT = 5000
const workflow = {
  slug: 'rework', name: 'Rework',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: ['c'] },
    // The rework is emitted from Charlie, so BOTH Alpha and Bravo are
    // candidates: the emitting step is excluded from matching, and with only
    // two steps an "ambiguous" target could never actually be ambiguous.
    { id: 'c', agentSlug: 'agent-c', label: 'Charlie', next: [] },
  ],
}

// A rework RESTARTS the run at the target step, and a restart rebuilds
// scheduling state by reading the workflow back off disk — so the definition
// has to exist there, not only in this process.
mkdirSync(join(CLAUDE_DIR, 'workflows'), { recursive: true })
writeFileSync(join(CLAUDE_DIR, 'workflows', 'rework.json'), JSON.stringify(workflow, null, 2))

// The marker itself parses the same either way — the defect was never in the
// parser, it was in resolving the parsed target to a step.
assert.deepEqual(
  parseRework('PIPELINE-REWORK: step-04 sdlc-test-author — rewrite the assertion'),
  { target: 'step-04 sdlc-test-author', instruction: 'rewrite the assertion' },
  'the parser hands the decorated target through untouched; resolution is the runner\'s job',
)

/** Runs the workflow with Charlie emitting one rework at `target`, then succeeding. */
async function runWithRework(target) {
  let reworked = false
  runner.setAgentCaller(async (agentSlug) => {
    if (agentSlug !== 'agent-c') return `output of ${agentSlug}`
    if (reworked) return 'output of agent-c, second time'
    reworked = true
    return `did the work\nPIPELINE-REWORK: ${target} — try that again`
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  return runner.waitForSettled(started.id, TIMEOUT)
}

// ── 1. The documented form still works ────────────────────────────────────
// Exact label match is tried first and must not have been broken by making
// the fallback looser.
let run = await runWithRework('Alpha')
assert.equal(run.status, 'completed', 'an exact label target routes the run and it finishes')
assert.ok(run.steps.find(s => s.stepId === 'a').visits >= 2, 'Alpha ran again after the rework')

// ── 2. The real defect: a decorated slug resolves ─────────────────────────
run = await runWithRework('step-01 agent-a')
assert.equal(run.status, 'completed',
  'a target carrying the step number alongside the slug names exactly one step ' +
  'and must route the run, not kill it')
assert.ok(run.steps.find(s => s.stepId === 'a').visits >= 2,
  'the decorated target sent the run back to Alpha specifically')

// ── 3. A target naming nothing still fails, and says what to name ─────────
run = await runWithRework('some-agent-that-does-not-exist')
assert.equal(run.status, 'failed', 'an unresolvable target fails the run rather than guessing')
const emitter = run.steps.find(s => s.stepId === 'c')
assert.match(emitter.error, /is not a step of this run/)
assert.match(emitter.error, /agent-a/,
  'the rejection must list agent SLUGS: the rejected string is usually a slug, ' +
  'and listing only labels told the agent nothing it could correct')

// ── 4. An ambiguous target fails rather than picking one ──────────────────
// 'alpha bravo' contains the labels of two steps that are both candidates.
// Routing to whichever the filter happened to see first would be a silent
// wrong answer — worse than stopping.
run = await runWithRework('alpha bravo')
assert.equal(run.status, 'failed', 'an ambiguous target must fail loudly, never resolve arbitrarily')
assert.match(run.steps.find(s => s.stepId === 'c').error, /matches more than one step/)

console.log('OK  rework target matching: exact, decorated, unknown, ambiguous')
