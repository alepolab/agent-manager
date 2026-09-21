/**
 * A review step's refusal stops the run.
 *
 *   node scripts/test-review-verdict.mjs
 *
 * Five consecutive runs opened a pull request over their reviewer's explicit
 * refusal. CSUP-7524's QA step opened with "## Review Result: **FAIL** — 2
 * CRITICAL, 3 HIGH" and stated "the client commit doesn't exist"; the pipeline
 * then ran three more steps and opened three pull requests, and the run
 * finished `completed`. CSUP-7526, CSUP-7514, CSUP-7519 and SBN-4091 are the
 * same shape — SBN-4091's verification found "the branch the PR step would push
 * contains only failing tests and zero production code".
 *
 * Nothing was hidden: the verdict was the first line of each step's output. The
 * runner simply had no channel for it. `approval: true` asks a PERSON, which
 * does nothing on a run classified `auto`, and every enforceable outcome needed
 * a marker (PIPELINE-HALT, PIPELINE-REWORK) the reviewers never emit.
 *
 * So this drives the real runner and asks the only question that matters: can a
 * FAIL still reach the step that opens the pull request.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'verdict-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'verdict-artifacts-'))

const { parseReviewVerdict } = await import('../shared/utils/workflowGraph.ts')
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

const TIMEOUT = 8000

// ── the parser reads what reviewers actually write ───────────────────────────
assert.equal(parseReviewVerdict('## Review Result: **FAIL** — 2 CRITICAL'), 'FAIL',
  'the heading-and-bold form is the one five real runs used')
assert.equal(parseReviewVerdict('**Review Result: FAIL** — 2 HIGH'), 'FAIL')
assert.equal(parseReviewVerdict('## Review Result: WARNING\n\none pre-existing CRITICAL'), 'WARNING',
  'WARNING is a real third answer (CSUP-7495) and is not a refusal')
assert.equal(parseReviewVerdict('**VERDICT: FAIL** — one high'), 'FAIL', 'the security-review spelling')
assert.equal(parseReviewVerdict('Review Result: PASS'), 'PASS')
assert.equal(parseReviewVerdict('I will report a Review Result once the build is green'), null,
  'prose about a verdict is not a verdict')
assert.equal(parseReviewVerdict(''), null)
// The monitor's own marker shares the `VERDICT:` prefix and a different value
// set (CONTINUE/RETRY/ABORT). It is not a review result, and must not read as one.
assert.equal(parseReviewVerdict('VERDICT: RETRY'), null)
assert.equal(parseReviewVerdict('VERDICT: CONTINUE'), null)
// A reviewer that changes its mind mid-answer. The anchored form alone read
// this as PASS, because the second statement has prose in front of it - and a
// missed FAIL is the exact defect this parser exists to close, so FAIL wins
// wherever it appears. A false FAIL stops a run someone can restart.
assert.equal(parseReviewVerdict('Review Result: PASS\n\nActually wait, Review Result: FAIL'), 'FAIL',
  'a later FAIL must outrank an earlier PASS even when it is not at the start of a line')
assert.equal(parseReviewVerdict('Review Result: FAIL\nfixed since; Review Result: PASS'), 'FAIL',
  'and the safe direction is chosen deliberately: a FAIL anywhere is a FAIL')

// A quoted example is not a verdict: an agent that pastes the required format
// back (the runner hands it that very line) must not stop its own run.
assert.equal(parseReviewVerdict('```\nReview Result: FAIL\n```\n\nReview Result: PASS'), 'PASS',
  'a fenced example of the format is a demonstration, not a refusal')
assert.equal(parseReviewVerdict('I must answer with `Review Result: FAIL` when it breaks.\n\nReview Result: PASS'), 'PASS',
  'and neither is an inline-code mention')
// The unquoted discussion case stays a FAIL, deliberately: see parseReviewVerdict.
assert.equal(parseReviewVerdict('The earlier Review Result: FAIL has been addressed.\n\nReview Result: PASS'), 'FAIL',
  'prose that names a FAIL still fails closed - a run a person restarts beats a PR over a refusal')

// ── the runner enforces it ───────────────────────────────────────────────────
const workflow = {
  slug: 'verdict-wf',
  name: 'Verdict',
  steps: [
    { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['review'] },
    { id: 'review', agentSlug: 'agent-qa', label: 'Verify', next: ['ship'], verdict: true },
    { id: 'ship', agentSlug: 'agent-ship', label: 'Evidence, Docs & Pull Request', next: [] },
  ],
}

async function runWith(reviewOutput) {
  for (const r of await (await import('../server/utils/workflowRunStore.ts')).listRuns('verdict-wf')) {
    if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  }
  runner.setAgentCaller(async slug => (slug === 'agent-qa' ? reviewOutput : `out ${slug}`))
  const started = await runner.startRun({
    workflow, initialPrompt: 'CSUP-0: go', watch: 'direct-invocation', autoRun: true,
  })
  return runner.waitForSettled(started.id, TIMEOUT)
}

const stepOf = (run, id) => run.steps.find(s => s.stepId === id)

// A FAIL stops the run before anything ships.
{
  const r = await runWith('## Review Result: **FAIL** — 2 CRITICAL\n\nThe client commit does not exist.')
  assert.equal(r.status, 'failed', 'a refused change must not finish as a completed run')
  assert.equal(stepOf(r, 'review').status, 'failed')
  assert.match(stepOf(r, 'review').error ?? '', /Review verdict FAIL/)
  assert.notEqual(stepOf(r, 'ship').status, 'completed',
    'the step that opens the pull request must never run after a FAIL — this is the whole defect')
}

// Silence is not approval - but a format slip gets asked again before the run
// dies, because failing a sound review over a missing line is its own defect.
{
  let asked = 0
  runner.setAgentCaller(async (slug, input) => {
    if (slug !== 'agent-qa') return `out ${slug}`
    asked += 1
    if (asked === 1) return 'Looks mostly fine. A few notes below.\n\n- naming\n- a TODO'
    assert.match(input, /did not state a verdict/, 'the second ask must say what was missing')
    return 'Review Result: PASS'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'CSUP-0: go', watch: 'direct-invocation', autoRun: true })
  const r = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(asked, 2, 'a step that stated no verdict is asked once more while it has a visit left')
  assert.equal(r.status, 'completed', 'and the restated verdict stands')
}

// Silence with no visit left stops the run.
{
  const oneShot = {
    slug: 'verdict-once', name: 'Verdict once',
    steps: [
      { id: 'review', agentSlug: 'agent-qa', label: 'Verify', next: ['ship'], verdict: true, maxVisits: 1 },
      { id: 'ship', agentSlug: 'agent-ship', label: 'Evidence, Docs & Pull Request', next: [] },
    ],
  }
  runner.setAgentCaller(async slug => (slug === 'agent-qa' ? 'Looks fine to me.' : `out ${slug}`))
  const started = await runner.startRun({ workflow: oneShot, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const r = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(r.status, 'failed',
    'silence with nothing left to ask must stop the run; "unreadable means continue" is how a FAIL shipped')
  assert.match(stepOf(r, 'review').error ?? '', /owns a verdict and stated none/)
  assert.notEqual(stepOf(r, 'ship').status, 'completed')
}

// PASS and WARNING carry on, and WARNING is not quietly upgraded.
for (const [output, label] of [['Review Result: PASS\n\nall green', 'PASS'], ['## Review Result: WARNING\n\none pre-existing issue', 'WARNING']]) {
  const r = await runWith(output)
  assert.equal(r.status, 'completed', `a ${label} verdict must let the run finish`)
  assert.equal(stepOf(r, 'ship').status, 'completed', `and ${label} must reach the shipping step`)
}

// The step is told the contract it is held to — enforcing an unstated format
// would be a trap, and the input is where the agent learns of it.
{
  let seen = ''
  runner.setAgentCaller(async (slug, input) => {
    if (slug === 'agent-qa') { seen = input; return 'Review Result: PASS' }
    return `out ${slug}`
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'CSUP-0: go', watch: 'direct-invocation', autoRun: true })
  await runner.waitForSettled(started.id, TIMEOUT)
  assert.match(seen, /Review Result: PASS/, 'the verdict step must be given the required format')
  assert.match(seen, /silence is not approval/i)
}

// ── a monitor's RETRY with no visit left is still a refusal ──────────────────
// It used to fall through to markCompleted: the step recorded
// `monitorVerdict: 'RETRY'` and `status: 'completed'` at once, and published the
// output the monitor had just rejected. Running out of budget is not approval.
{
  const monitored = {
    slug: 'retry-cap-wf',
    name: 'Retry cap',
    steps: [
      { id: 'work', agentSlug: 'agent-work', label: 'Implement', next: ['after'], monitorSlug: 'agent-mon', maxVisits: 1 },
      { id: 'after', agentSlug: 'agent-after', label: 'Ship', next: [] },
    ],
  }
  runner.setAgentCaller(async slug => (slug === 'agent-mon' ? 'Not good enough.\nVERDICT: RETRY' : `out ${slug}`))
  const started = await runner.startRun({
    workflow: monitored, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
  })
  const r = await runner.waitForSettled(started.id, TIMEOUT)
  assert.equal(r.status, 'failed', 'a monitor that still wants another attempt has not approved anything')
  assert.equal(stepOf(r, 'work').status, 'failed')
  assert.match(stepOf(r, 'work').error ?? '', /another attempt .* and there is none left/)
  assert.notEqual(stepOf(r, 'after').status, 'completed', 'and the rejected output must not be published downstream')
}

console.log('review verdict: FAIL stops the run before the PR step, silence fails too, and a capped RETRY is not a pass')
