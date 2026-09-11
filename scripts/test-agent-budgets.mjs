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

const { resolveMaxDurationMs, DEFAULT_MAX_DURATION_MS, DEFAULT_MAX_TURNS, resolveMaxTurns } =
  await import('../server/utils/agentToolPolicy.ts')
const { agentTemplates: AGENT_TEMPLATES } = await import('../app/utils/templates.ts')
const { AgentResultError } = await import('../server/utils/agentCaller.ts')
const runner = await import('../server/utils/workflowRunner.ts')

const TIMEOUT = 5000

// ── 1. The wall-clock budget resolves like the turn budget ────────────────
// Same validation rule, so the two budgets cannot drift into behaving
// differently for the same malformed frontmatter.
assert.equal(resolveMaxDurationMs({ maxDurationMs: 90_000 }), 90_000,
  'a positive integer is honoured')
for (const bad of [0, -5, 2.5, '600000', null, undefined, NaN]) {
  assert.equal(resolveMaxDurationMs({ maxDurationMs: bad }), DEFAULT_MAX_DURATION_MS,
    `maxDurationMs ${String(bad)} must fall back to the default (now: none), never be trusted`)
}
assert.equal(resolveMaxDurationMs(undefined), DEFAULT_MAX_DURATION_MS,
  'absent frontmatter resolves to the default rather than throwing')


// ── 2. There is no default budget, and nothing in the pipeline declares one ──
// Removed on the operator's decision. The history this file records is the
// argument for it: every budget here was set from a guess, hit real work, and
// was raised after the fact — stragglers at 60 that produced every turn-budget
// failure of 2026-09-09, then a 30-minute ceiling drawn from a provisioner that
// had actually died on TURNS while working, not on time while hung.
//
// A budget that fires does not save the spend. It discards what the step had
// done and re-attempts it from a log tail, which costs more than the turns it
// refused. What still bounds a run: the RUN budget, which pauses and asks for
// another allowance rather than failing, and the operator's Stop.
assert.equal(DEFAULT_MAX_TURNS, undefined, 'no default turn budget: a step runs until it finishes')
assert.equal(DEFAULT_MAX_DURATION_MS, undefined, 'no default wall-clock ceiling either')
assert.equal(resolveMaxTurns(undefined), undefined, 'absent frontmatter means absent, not a substituted number')
assert.equal(resolveMaxDurationMs(undefined), undefined)

// Declaring one still works — the mechanism is opt-in, not deleted.
assert.equal(resolveMaxTurns({ maxTurns: 12 }), 12, 'a declared turn budget is still honoured')
assert.equal(resolveMaxDurationMs({ maxDurationMs: 90_000 }), 90_000, 'a declared ceiling is still honoured')

// The jira tracker is the one agent that legitimately declares one: moving a
// ticket is a single turn by nature, not a guess about how long work takes.
assert.equal(AGENT_TEMPLATES.find(t => t.id === 'sdlc-jira-tracker').frontmatter.maxTurns, 1,
  'a one-shot step may still say it is one-shot')

// Every other pipeline agent declares nothing at all. A budget reintroduced
// here is a step that can fail for a reason unrelated to its work.
for (const t of AGENT_TEMPLATES.filter(t => t.id.startsWith('sdlc-') && t.id !== 'sdlc-jira-tracker')) {
  assert.equal(t.frontmatter.maxTurns, undefined,
    `${t.id} must not declare a turn budget: they were removed deliberately`)
  assert.equal(t.frontmatter.maxDurationMs, undefined,
    `${t.id} must not declare a wall-clock ceiling`)
}

// ── 3. Every SDLC agent still declares maxTurns explicitly ────────────────
// An omitted budget silently inherits DEFAULT_MAX_TURNS and is invisible
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
