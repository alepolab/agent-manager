/**

 * What survives a decision.
 *
 * Before this existed, nothing did. An approval note went into the runner's
 * in-memory `l.notes` and died with the process; a rejection was concatenated
 * into `run.error`. So a reviewer standing at the fourth gate of a runbook could
 * not see who had approved the first three or why, and no screen could report
 * how long any gate had waited — `run.question` is cleared the instant it is
 * answered, taking `askedAt` with it.
 *
 * The rule these tests protect is that the record is measured, never invented:
 * a decision with no question behind it is not recorded at all, rather than
 * recorded with a comfortable zero.
 *
 *   node scripts/test-run-decisions.mjs
 */
import assert from 'node:assert/strict'

const { recordDecision, humanWaitMs } = await import('../shared/utils/runDecisions.ts')

const MINUTE = 60_000

function runAtGate(askedAt, extra = {}) {
  return {
    id: 'r1',
    steps: [
      { stepId: 'fix', label: 'Implement Fix' },
      { stepId: 'ship', label: 'Push + PR' },
    ],
    question: { stepId: 'ship', text: 'Approve "Push + PR" to run it.', kind: 'approval', askedAt },
    blastRadius: 'money',
    ...extra,
  }
}

// ── 1. a decision is measured from the question it answers ───────────────────
{
  const run = runAtGate(Date.now() - 5 * MINUTE)
  const d = recordDecision(run, 'approved', 'sandeep', 'Checked the tax arithmetic against the invoice fixture.')

  assert.ok(d, 'a gate that was waiting produces a decision')
  assert.equal(d.stepId, 'ship')
  assert.equal(d.label, 'Push + PR', 'the label is captured, so the record reads without the workflow beside it')
  assert.equal(d.by, 'sandeep')
  assert.equal(d.verdict, 'approved')
  assert.match(d.note, /tax arithmetic/)
  assert.equal(d.blastRadius, 'money', 'the tier at the time is part of what was decided')
  // ~5 minutes, allowing for the clock moving between construction and call.
  assert.ok(d.waitedMs >= 4.9 * MINUTE && d.waitedMs <= 5.2 * MINUTE,
    `the wait is measured from askedAt, got ${d.waitedMs}ms`)
  assert.deepEqual(run.decisions, [d], 'and it lands on the run')
}

// ── 2. no question means no decision — never a fabricated zero ───────────────
// The failure mode worth preventing: a run with no gate open recording a
// decision with `waitedMs: 0` would put a number in the record that nothing
// measured, and a board summing those would under-report human latency.
{
  const run = { id: 'r2', steps: [], question: undefined }
  assert.equal(recordDecision(run, 'approved', 'sandeep'), null)
  assert.equal(run.decisions, undefined, 'nothing is appended when nothing was asked')
}

// ── 3. a clock artefact cannot produce a negative wait ───────────────────────
{
  const run = runAtGate(Date.now() + 10 * MINUTE)
  const d = recordDecision(run, 'approved', 'sandeep')
  assert.equal(d.waitedMs, 0, 'a question asked in the future clamps to zero rather than going negative')
}

// ── 4. send-back records where it went; reject records why ───────────────────
{
  const run = runAtGate(Date.now() - MINUTE)
  const sent = recordDecision(run, 'sent-back', 'qa-person', 'The oracle only covers one credit.', 'fix')
  assert.equal(sent.verdict, 'sent-back')
  assert.equal(sent.target, 'fix', 'the step it was returned to is on the record')

  const rejected = recordDecision(runAtGate(Date.now() - MINUTE), 'rejected', 'dev', 'Wrong base branch.')
  assert.equal(rejected.verdict, 'rejected')
  assert.equal(rejected.target, undefined, 'a rejection has no target; it ends the run')
}

// ── 5. append-only, oldest first ─────────────────────────────────────────────
// A four-gate runbook must read as a history, not as its last decision.
{
  const run = runAtGate(Date.now() - MINUTE)
  recordDecision(run, 'sent-back', 'qa-person', 'first', 'fix')
  run.question = { stepId: 'ship', text: 'again', kind: 'approval', askedAt: Date.now() - MINUTE }
  recordDecision(run, 'approved', 'dev', 'second')

  assert.equal(run.decisions.length, 2, 'the earlier decision is kept, not replaced')
  assert.deepEqual(run.decisions.map(d => d.note), ['first', 'second'], 'oldest first')
}

// ── 6. human latency counts the gate still open ──────────────────────────────
// The number the manager board exists to show: hours the pipeline spent waiting
// for people. A gate open right now has not been decided, so it is in no
// decision yet — and omitting it would report a stuck run as costing nothing.
{
  const run = runAtGate(Date.now() - 3 * MINUTE)
  recordDecision(run, 'approved', 'dev')            // ~3 min, clears nothing here
  run.question = { stepId: 'ship', text: 'open', kind: 'approval', askedAt: Date.now() - 2 * MINUTE }

  const total = humanWaitMs(run)
  assert.ok(total >= 4.9 * MINUTE, `decided wait plus the gate still open, got ${Math.round(total / 1000)}s`)

  const settled = { ...run, question: undefined }
  assert.ok(humanWaitMs(settled) < 3.2 * MINUTE, 'with nothing open, only the decided waits count')
  assert.equal(humanWaitMs({ id: 'x', steps: [] }), 0, 'a run that never stopped for anyone waited zero')
}

console.log('run decisions: waits are measured not invented, history is append-only, open gates still count')
