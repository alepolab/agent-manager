/**
 * Self-check for the two budgets that bound an agent call, and for the run
 * record that has to explain when one of them runs out.
 *
 * Three real defects sit behind this file, all observed on 2026-09-09:
 *
 *  1. Three agents that do genuinely iterative work — stack-provisioner,
 *     test-author, fix-implementer — were left at maxTurns 60 while every
 *     other iterative agent had already been raised to 80. All three of that
 *     day's `error_max_turns` hits were theirs, and no agent at 80 ever hit
 *     one.
 *
 *  2. `maxTurns` was the ONLY bound in the system — there is no timeout
 *     anywhere in the runner. A turn budget does not bound wall-clock: one
 *     turn can sit inside a single Bash command indefinitely. A real
 *     stack-provisioner ran 47.4 minutes before its turns ran out.
 *
 *  3. A run whose step failed recorded `error: (none)`. The step record and
 *     the container log both carried the real reason; the run itself, which
 *     is what the UI and the run JSON show, carried nothing. The most
 *     expensive failures explained themselves least.
 *
 *   node scripts/test-agent-budgets.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'budgets-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'budgets-artifacts-'))

const { resolveMaxDurationMs, DEFAULT_MAX_DURATION_MS, resolveMaxTurns } =
  await import('../server/utils/agentToolPolicy.ts')
const { agentTemplates: AGENT_TEMPLATES } = await import('../app/utils/templates.ts')
const { AgentResultError } = await import('../server/utils/agentCaller.ts')
const runner = await import('../server/utils/workflowRunner.ts')

const TIMEOUT = 5000

// ── 1. The wall-clock budget resolves like the turn budget ────────────────
// Same validation rule, so the two budgets cannot drift into behaving
// differently for the same malformed frontmatter.
assert.equal(resolveMaxDurationMs({ maxDurationMs: 90_000 }), 90_000,
  'a positive integer overrides the default')
for (const bad of [0, -5, 2.5, '600000', null, undefined, NaN]) {
  assert.equal(resolveMaxDurationMs({ maxDurationMs: bad }), DEFAULT_MAX_DURATION_MS,
    `maxDurationMs ${String(bad)} must fall back to the default, never be trusted`)
}
assert.equal(resolveMaxDurationMs(undefined), DEFAULT_MAX_DURATION_MS,
  'absent frontmatter resolves to the default rather than throwing')

// The default has to clear the longest step that has ever SUCCEEDED here
// (10.5 minutes) by a real margin, and still end a runaway well inside the
// 47.4-minute one that prompted this. Both edges are asserted: a default
// tightened under the observed need would fail working steps, and one
// loosened past the observed runaway would not have caught it.
assert.ok(DEFAULT_MAX_DURATION_MS >= 20 * 60_000,
  'the default must clear the longest observed successful step (10.5m) with margin')
assert.ok(DEFAULT_MAX_DURATION_MS < 47 * 60_000,
  'the default must be tight enough to have ended the 47.4-minute provisioner runaway')

// ── 2. Every iterative SDLC agent carries the same turn budget ────────────
// Named individually rather than looped: the point is not "these agents have
// some budget" but "these three were the stragglers at 60, and all three of
// that day's turn-budget hits were theirs".
for (const id of ['sdlc-stack-provisioner', 'sdlc-test-author', 'sdlc-fix-implementer']) {
  const agent = AGENT_TEMPLATES.find(t => t.id === id)
  assert.ok(agent, `${id} must exist in the templates`)
  assert.equal(agent.frontmatter.maxTurns, 80,
    `${id} does iterative work and must carry the same 80-turn budget as the ` +
    'verifier, trace-capture and pr-follow-up, not the 60 it hit repeatedly')
}
// The cheap agents must NOT have been swept up by a blanket raise.
for (const [id, want] of [['sdlc-jira-tracker', 1], ['sdlc-step-monitor', 20], ['sdlc-ticket-intake', 30]]) {
  assert.equal(AGENT_TEMPLATES.find(t => t.id === id).frontmatter.maxTurns, want,
    `${id} is a cheap single-purpose step and must stay at ${want}`)
}

// ── 3. Every SDLC agent still declares maxTurns explicitly ────────────────
// An omitted budget silently inherits DEFAULT_MAX_TURNS (10) and is invisible
// in the template — the exact shape of an earlier DEVOPS-15 failure.
for (const t of AGENT_TEMPLATES.filter(t => t.id.startsWith('sdlc-'))) {
  assert.equal(resolveMaxTurns(t.frontmatter), t.frontmatter.maxTurns,
    `${t.id} must declare a budget the resolver accepts, not fall through to the default`)
}

const workflow = {
  slug: 'budgets', name: 'Budgets',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Alpha', next: ['b'] },
    { id: 'b', agentSlug: 'agent-b', label: 'Bravo', next: [] },
  ],
}

// ── 4. A failed run explains ITSELF, not just its step ────────────────────
// This is the `error: (none)` defect. The step's error was always recorded;
// the run's was not, and the run is what the UI reads.
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug === 'agent-b') throw new Error('agent-b hit the wall')
  return `output of ${agentSlug}`
})
let failed = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
failed = await runner.waitForSettled(failed.id, TIMEOUT)
assert.equal(failed.status, 'failed', 'the run fails when a step does')
assert.ok(failed.error, 'a failed run must record a reason of its own, never `(none)`')
assert.match(failed.error, /hit the wall/,
  "the run's reason must carry the failing step's actual message, not a generic one")
assert.match(failed.error, /Bravo/,
  'and must name WHICH step failed, since a run has many')

// ── 5. A wall-clock timeout is retried, exactly as a spent turn budget is ─
// The runner had one out-of-budget recovery path and it matched only
// `error_max_turns`. A timeout carries subtype `error_max_duration` and must
// take the same path: record the attempt, retry from the log tail. Without
// the widened check this run ends `failed` on the first throw.
let attempts = 0
runner.setAgentCaller(async (agentSlug) => {
  if (agentSlug !== 'agent-b') return `output of ${agentSlug}`
  attempts += 1
  if (attempts === 1) {
    throw new AgentResultError(
      'Claude Code ran past its wall-clock budget of 30 minutes and was stopped',
      { input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 0 },
      'error_max_duration',
    )
  }
  return 'output of agent-b on the retry'
})
let timedOut = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
timedOut = await runner.waitForSettled(timedOut.id, TIMEOUT)
assert.equal(attempts, 2, 'a timed-out step is retried rather than ending the run')
assert.equal(timedOut.status, 'completed',
  'a run whose step timed out once and then succeeded must complete, not fail')
const bravo = timedOut.steps.find(s => s.stepId === 'b')
assert.equal(bravo.status, 'completed', 'the retried step ends completed')
assert.ok(bravo.visits >= 2, 'the retry is recorded as a second visit')

console.log('OK  agent budgets: turn budget, wall-clock budget, run-level error')
