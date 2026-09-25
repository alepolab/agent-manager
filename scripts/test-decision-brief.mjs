/**
 * A step's question reaches a person with a brief they can decide from.
 *
 * ASECRM-220's step asked "should the developer step (a) fix the
 * `trouble-ticket` 0.3062-vs-0.32 ratchet breach … or (c) narrow the oracle to
 * criterion 4 only?" and the developer could not answer: the inbox showed that
 * one line, and nothing said what criteria 2-4 were, what trouble-ticket was,
 * or what any option would lead to.
 *
 *   node scripts/test-decision-brief.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'brief-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'brief-artifacts-'))

const { parseDecisionBrief, referencedCriteria } = await import('../shared/utils/decisionBrief.ts')

const good = {
  question: 'Which scope should the developer step take?',
  situation: 'The test the step wrote checks every module against 50% coverage, which needs tests across ~1,400 files.',
  criteria: [
    { ref: 'criterion 1', text: 'A fresh JaCoCo run for all 8 below-threshold modules is captured and compared against coverage-floors.properties.' },
    { ref: 'criterion 2', text: 'A targeted structural scan is commissioned for pipeline and subscriber.' },
    { ref: 'criterion 3', text: 'At least one follow-up ticket is filed per module with a concrete gap found.' },
    { ref: 'criterion 4', text: 'ratchetCoverageFloors shows no regression after any follow-up work lands.' },
  ],
  findings: ['trouble-ticket (the trouble-ticket backend module) measures 30.6% against a committed floor of 32%, so its build check fails today.'],
  options: [
    { key: 'a', label: 'Fix the breach, file follow-ups', next: 'Adds tests to trouble-ticket and fixes the ratchet bug.', delivers: 'Criteria 1, 3 and 4 met.', leaves: 'Seven modules stay under 50%; verification fails.' },
    { key: 'c', label: 'Narrow the test to criterion 4', next: 'Rewrites the test to check only for regression.', delivers: 'A ticket that can close green.', leaves: 'The 50% goal moves to the follow-ups.' },
  ],
  recommendation: { option: 'a', why: 'It fixes the live breach.' },
}

// ── Parsing ──────────────────────────────────────────────────────────────────
{
  const ok = parseDecisionBrief(JSON.stringify(good))
  assert.ok('brief' in ok, JSON.stringify(ok))
  assert.equal(ok.brief.options.length, 2)
  assert.equal(ok.brief.recommendation.option, 'a')

  // The exact failure: criteria named, their text nowhere.
  const bare = parseDecisionBrief(JSON.stringify({ ...good, criteria: [], situation: 'Criteria 2–3 are Jira filings, not code.' }))
  assert.ok('error' in bare)
  assert.match(bare.error, /criteria 1, 2, 3, 4 are mentioned but their text is not in `criteria`/)

  // An option that does not say what it leads to.
  const vague = parseDecisionBrief(JSON.stringify({ ...good, options: [{ key: 'a', label: 'Fix it' }, good.options[1]] }))
  assert.match(vague.error, /option a is missing `next`, `delivers`, `leaves`/)

  assert.match(parseDecisionBrief(null).error, /was not written/)
  assert.match(parseDecisionBrief('{not json').error, /not valid JSON/)
  assert.match(parseDecisionBrief(JSON.stringify({ ...good, options: [good.options[0]] })).error, /at least two/)

  assert.deepEqual([...referencedCriteria('criteria 2–3 and criterion 4')].sort(), [2, 3, 4])
  assert.deepEqual([...referencedCriteria('criteria 1, 3 and 5')].sort(), [1, 3, 5])
  assert.deepEqual([...referencedCriteria('no criteria here')], [])
}

// ── Through the runner: sent back once for a brief, then paused with it ──────
{
  const runner = await import('../server/utils/workflowRunner.ts')
  runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
  const workflow = { slug: 'brief', name: 'Brief', steps: [{ id: 'w', agentSlug: 'agent-w', label: 'Failing Test', next: [], maxVisits: 3 }] }
  const inputs = []
  runner.setAgentCaller(async (_slug, input) => {
    inputs.push(input)
    const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
    // First visit asks bare, as ASECRM-220's step did; the second writes the brief.
    if (inputs.length > 1) writeFileSync(join(dir, 'decision.json'), JSON.stringify(good))
    return 'report of the work\n\nPIPELINE-ASK: Which scope should the developer step take?'
  })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, 8000)

  assert.equal(inputs.length, 2, 'the step was sent back once for its brief')
  assert.match(inputs[1], /decision\.json was not written/, 'told exactly what was missing')
  assert.match(inputs[1], /"criteria"/, 'and the shape to write')
  assert.equal(run.status, 'paused')
  assert.equal(run.question.kind, 'question')
  assert.equal(run.question.brief.situation, good.situation, 'the brief rides on the question')
  assert.equal(run.question.brief.criteria.length, 4)
  const dir = join(process.env.AGENT_RUNS_DIR, run.id, 'artifacts')
  assert.ok(!existsSync(join(dir, 'decision.json')), 'filed away, so the next question cannot reuse it')
  assert.ok(readdirSync(dir).some(f => /^decision-\d+\.json$/.test(f)))
  await runner.stopRun(run.id)
}

// ── A step that never writes one still asks, after the one send-back ─────────
{
  const runner = await import('../server/utils/workflowRunner.ts')
  const workflow = { slug: 'brief2', name: 'Brief 2', steps: [{ id: 'w', agentSlug: 'agent-w', label: 'Ask', next: [], maxVisits: 3 }] }
  let calls = 0
  runner.setAgentCaller(async () => { calls++; return 'PIPELINE-ASK: Which one?' })
  const started = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
  const run = await runner.waitForSettled(started.id, 8000)
  assert.equal(calls, 2, 'sent back once, not forever')
  assert.equal(run.status, 'paused', 'a question with no brief beats a run that cannot ask')
  assert.equal(run.question.brief, undefined)
  await runner.stopRun(run.id)
}

console.log('ok - a step question carries a brief a person can decide from')
