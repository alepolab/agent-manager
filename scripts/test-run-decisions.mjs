/**
 * Self-check for the "awaiting review" gate: a run stops on the ENTRIES of an
 * artifact, a person decides about each one, and the decision binds on every
 * step that reads that file.
 *
 *   node scripts/test-run-decisions.mjs
 *
 * The dimension that varies is the DECISION MIX, not one reported example. A
 * fix that special-cased "approve everything" — which is what the old approval
 * button did, and what /review-drafts could not express — passes a single
 * happy-path test and still dispatches three pipelines when the operator asked
 * for two. So every row below states an approve/skip pattern and asserts what
 * survives in the artifact, in the audit record, and in what actually ran.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'decisions-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'decisions-artifacts-'))
// Posting stays off for every row but the one that turns it on: creation must
// be provable without a Jira, and the default must never post.
delete process.env.JIRA_POST_ENABLED

const runner = await import('../server/utils/workflowRunner.ts')
const review = await import('../server/utils/runReview.ts')
const artifacts = await import('../server/utils/runArtifacts.ts')

const TIMEOUT = 5000

/** The scan pipeline's real shape: a gate fanning out to an approval-gated
 *  creator and a dispatcher, both reading the same escalated file. */
const flow = {
  slug: 'review-demo',
  name: 'Review Demo',
  steps: [
    { id: 'g', agentSlug: 'agent-g', label: 'Decision Gate', next: ['esc'] },
    { id: 'esc', agentSlug: 'agent-esc', label: 'Create Jira (Escalated)', next: ['disp'], approval: true, runWhen: { artifact: 'escalated-drafts.json' } },
    { id: 'disp', agentSlug: 'agent-disp', label: 'Dispatch Escalated', next: [], runWhen: { artifact: 'escalated-drafts.json' } },
  ],
}

const draft = (n, extra = {}) => ({
  draft_id: `DRAFT-00${n}`,
  summary: `Finding ${n}`,
  description: `The body of finding ${n}`,
  severity: n === 1 ? 'high' : 'medium',
  fields: { project: 'SEC', issue_type: 'Bug', priority: 'High', component: `mod/${n}.py` },
  acceptance_criteria: [`criterion ${n}`],
  gate: { verdict: 'escalated', reason: 'blast radius is money', decision_prompt: `Create a ticket for finding ${n}?`, escalation_criteria: ['blast_money'] },
  ...extra,
})

const calls = []
function gateWriting(entries) {
  return async (agentSlug, input) => {
    calls.push(agentSlug)
    if (agentSlug === 'agent-g') {
      const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(dir, 'escalated-drafts.json'), JSON.stringify(entries, null, 2))
    }
    return `output of ${agentSlug}`
  }
}

const readArtifact = (runId, name) => {
  const path = artifacts.resolveRunArtifact(runId, name)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

/** Starts a run and drives it to the gate. */
async function gatedRun(entries) {
  calls.length = 0
  runner.setAgentCaller(gateWriting(entries))
  let run = await runner.startRun({ workflow: flow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'awaiting_review', 'a gate over an artifact raises awaiting_review')
  assert.equal(run.question.artifact, 'escalated-drafts.json')
  return run
}

// ── 1. The decision mix decides what survives ────────────────────────────
// Each row: what was escalated, what the operator said, and what must remain.
const MIXES = [
  {
    name: 'approves every draft',
    entries: [draft(1), draft(2), draft(3)],
    decide: ['approved', 'approved', 'approved'],
    survives: ['DRAFT-001', 'DRAFT-002', 'DRAFT-003'],
    escRan: true,
  },
  {
    name: 'approves some',
    entries: [draft(1), draft(2), draft(3)],
    decide: ['approved', 'skipped', 'approved'],
    survives: ['DRAFT-001', 'DRAFT-003'],
    escRan: true,
  },
  {
    name: 'approves exactly one',
    entries: [draft(1), draft(2), draft(3)],
    decide: ['skipped', 'approved', 'skipped'],
    survives: ['DRAFT-002'],
    escRan: true,
  },
  {
    name: 'skips every draft',
    entries: [draft(1), draft(2), draft(3)],
    decide: ['skipped', 'skipped', 'skipped'],
    survives: [],
    escRan: false,
  },
  {
    name: 'skips the only draft',
    entries: [draft(1)],
    decide: ['skipped'],
    survives: [],
    escRan: false,
  },
  {
    name: 'approves the only draft',
    entries: [draft(1)],
    decide: ['approved'],
    survives: ['DRAFT-001'],
    escRan: true,
  },
]

for (const row of MIXES) {
  const run = await gatedRun(row.entries)
  const queue = await review.loadReviewQueue(run)
  assert.equal(queue.items.length, row.entries.length, `${row.name}: every entry is offered`)
  assert.equal(queue.items[0].decisionPrompt, row.entries[0].gate.decision_prompt, `${row.name}: the gate's own prompt is what is shown`)
  assert.equal(queue.stepLabel, 'Create Jira (Escalated)', `${row.name}: the panel names the step being gated`)

  const submitted = row.decide.map((decision, index) => ({ index, decision }))
  const result = await review.applyReviewDecisions(run, submitted, 'a-reviewer')
  const approvedCount = row.decide.filter(d => d === 'approved').length
  assert.equal(result.approved, approvedCount, `${row.name}: approved count`)
  assert.equal(result.skipped, row.entries.length - approvedCount, `${row.name}: skipped count`)

  // The artifact now holds exactly the approved entries. This is the lever:
  // both remaining steps read this file.
  const after = readArtifact(run.id, 'escalated-drafts.json')
  assert.deepEqual(after.map(e => e.draft_id), row.survives, `${row.name}: the artifact holds exactly the approved entries`)

  // The audit keeps EVERY entry, including the ones dropped from the artifact.
  // Without it the skipped drafts would have no surviving record at all.
  const record = readArtifact(run.id, 'review-decisions.json')
  assert.equal(record.artifact, 'escalated-drafts.json')
  assert.equal(record.reviewedBy, 'a-reviewer', `${row.name}: the record says who decided`)
  assert.equal(record.items.length, row.entries.length, `${row.name}: the audit keeps every entry`)
  assert.deepEqual(record.items.map(i => i.decision), row.decide, `${row.name}: with the decision made about each`)
  // Named positionally, and deliberately so: `draft_id` is NOT one of
  // workflowGraph's ENTRY_KEY_FIELDS, so this is exactly what a dispatch step
  // will call the same entries in the run log. Adding draft_id to that list
  // would read better here and cost more than it is worth — "DRAFT-001"
  // satisfies the Jira-key shape, so a dispatched child would claim a ticketKey
  // for an issue that does not exist. Once the create step has stamped
  // `jira_key`, that wins and both places name the real ticket.
  assert.deepEqual(record.items.map((i, n) => i.key), row.entries.map((_, n) => `entry ${n + 1}`),
    `${row.name}: named as dispatch would name them`)

  // Resume exactly as the route does, and let the run settle.
  let settled = await runner.continueRun(run.id, undefined, { grantApproval: result.approved > 0 })
  settled = await runner.waitForSettled(settled.id, TIMEOUT)
  assert.equal(settled.status, 'completed', `${row.name}: the run completes either way`)

  const esc = settled.steps.find(s => s.stepId === 'esc')
  const disp = settled.steps.find(s => s.stepId === 'disp')
  if (row.escRan) {
    assert.equal(esc.status, 'completed', `${row.name}: the approved branch runs`)
    assert.equal(disp.status, 'completed', `${row.name}: and so does what it feeds`)
  } else {
    // The heart of it. Approving the step would have waived its runWhen and run
    // it over the file the operator just emptied — the approval overriding the
    // decision it was carrying out.
    assert.equal(esc.status, 'skipped', `${row.name}: approving nothing must not run the step`)
    assert.match(esc.skipReason, /escalated-drafts\.json/, `${row.name}: the reason names the file`)
    assert.match(esc.skipReason, /empty array/, `${row.name}: and what was found in it`)
    assert.equal(disp.status, 'skipped', `${row.name}: nothing downstream of it dispatches either`)
    assert.ok(!calls.includes('agent-esc'), `${row.name}: the skipped step never reached its agent`)
  }
}

// ── 2. Refusals: a review that does not decide everything is not a review ──
{
  const run = await gatedRun([draft(1), draft(2)])
  const refusals = [
    { name: 'an entry left undecided', submitted: [{ index: 0, decision: 'approved' }], code: 400, match: /every entry must be decided; 2 was not/ },
    { name: 'an index past the end', submitted: [{ index: 0, decision: 'approved' }, { index: 9, decision: 'skipped' }], code: 400, match: /names no entry of escalated-drafts\.json, which holds 2/ },
    { name: 'a negative index', submitted: [{ index: -1, decision: 'approved' }, { index: 1, decision: 'skipped' }], code: 400, match: /names no entry/ },
    { name: 'the same entry twice', submitted: [{ index: 0, decision: 'approved' }, { index: 0, decision: 'skipped' }], code: 400, match: /entry 1 was decided twice/ },
    { name: 'a decision that is neither', submitted: [{ index: 0, decision: 'maybe' }, { index: 1, decision: 'skipped' }], code: 400, match: /must be "approved" or "skipped"/ },
    { name: 'no decisions at all', submitted: [], code: 400, match: /decisions is required/ },
  ]
  for (const r of refusals) {
    await assert.rejects(
      () => review.applyReviewDecisions(run, r.submitted, 'a-reviewer'),
      (err) => err.statusCode === r.code && r.match.test(err.message),
      `${r.name} must be refused`,
    )
  }
  // Nothing was written by any of them: a refused review leaves the run exactly
  // where it was, still gated, still holding both drafts.
  assert.deepEqual(readArtifact(run.id, 'escalated-drafts.json').map(e => e.draft_id), ['DRAFT-001', 'DRAFT-002'])
  assert.equal(readArtifact(run.id, 'review-decisions.json'), null, 'a refused review writes no audit record')
  assert.equal((await runner.stopRun(run.id)).status, 'stopped')
}

// ── 3. A second submission cannot decide the same run twice ───────────────
{
  const run = await gatedRun([draft(1), draft(2)])
  await review.applyReviewDecisions(run, [{ index: 0, decision: 'approved' }, { index: 1, decision: 'skipped' }], 'a-reviewer')
  let settled = await runner.continueRun(run.id, undefined, { grantApproval: true })
  settled = await runner.waitForSettled(settled.id, TIMEOUT)

  await assert.rejects(
    () => review.applyReviewDecisions(settled, [{ index: 0, decision: 'approved' }], 'a-reviewer'),
    (err) => err.statusCode === 409 && /is not waiting on a decision/.test(err.message),
    'a run that has already been decided refuses a second review',
  )
  // And the first decision still stands: one entry, not two, not re-filtered.
  assert.deepEqual(readArtifact(run.id, 'escalated-drafts.json').map(e => e.draft_id), ['DRAFT-001'])
}

// ── 4. Modify: the ticket that gets filed is the text that was approved ───
{
  const run = await gatedRun([draft(1), draft(2)])
  await review.applyReviewDecisions(run, [
    { index: 0, decision: 'approved', edits: { summary: 'Validate the payment amount', priority: 'Highest', description: 'Rewritten body' } },
    { index: 1, decision: 'skipped' },
  ], 'a-reviewer')

  const [kept] = readArtifact(run.id, 'escalated-drafts.json')
  assert.equal(kept.summary, 'Validate the payment amount', 'the edited summary is what survives')
  assert.equal(kept.description, 'Rewritten body', 'and the edited description')
  assert.equal(kept.fields.priority, 'Highest', 'and the edited priority')
  assert.equal(kept.fields.project, 'SEC', 'while the fields nobody edited are untouched')

  // The edits are in the audit too, so what changed at the gate is visible
  // later without diffing the draft against a ticket.
  const record = readArtifact(run.id, 'review-decisions.json')
  assert.equal(record.items[0].edits.summary, 'Validate the payment amount')
  assert.equal(record.items[1].edits, undefined, 'a skipped entry carries no edits')
  assert.equal((await runner.stopRun(run.id)).status, 'stopped')
}

// ── 5. With posting off, nothing is filed and the run says so ─────────────
{
  const run = await gatedRun([draft(1)])
  const result = await review.applyReviewDecisions(run, [{ index: 0, decision: 'approved' }], 'a-reviewer')
  assert.deepEqual(result.created, [], 'no issue key is invented when posting is disabled')
  assert.match(result.lines[0], /JIRA_POST_ENABLED is not 1/, 'and the reason is stated, not swallowed')
  assert.equal(readArtifact(run.id, 'escalated-drafts.json')[0].jira_key, undefined, 'so no entry claims a ticket that does not exist')
  assert.equal(readArtifact(run.id, 'tickets-created.json'), null, 'and nothing is recorded as created')
  assert.equal((await runner.stopRun(run.id)).status, 'stopped')
}

// ── 6. A gate over an artifact that vanished is an error, not "nothing" ───
{
  const run = await gatedRun([draft(1)])
  const { rmSync } = await import('node:fs')
  rmSync(artifacts.resolveRunArtifact(run.id, 'escalated-drafts.json'))
  await assert.rejects(
    () => review.loadReviewQueue(run),
    (err) => err.statusCode === 409 && /was not written/.test(err.message),
    'a gate whose file has gone must not read as "nothing to decide"',
  )
  assert.equal((await runner.stopRun(run.id)).status, 'stopped')
}

console.log('run decisions: the decision mix binds on every step that reads the file')
