/**
 * A send-back option names the step that should redo the work.
 *
 * ASECRM-295's brief offered "(b) Approve the pin, but send it back to drop
 * .agent/plan.md from the branch", whose `next` said "The fix step re-runs".
 * The developer wanted (b) and was shown a list of every finished step, with
 * nothing saying that "the fix step" is the one labelled Implement Fix.
 *
 *   node scripts/test-send-back-suggestion.mjs
 */
import assert from 'node:assert/strict'

const { parseDecisionBrief, suggestSendBack, sendBackCandidates } = await import('../shared/utils/decisionBrief.ts')

const step = (label, agentSlug, status = 'completed') => ({ stepId: label.toLowerCase().replace(/\W+/g, '-'), label, agentSlug, status })
const RUNBOOK_A = [
  step('Jira: In Progress', 'sdlc-jira-tracker'),
  step('Ticket Intake', 'sdlc-ticket-intake'),
  step('Stand Up Stack', 'sdlc-stack-provisioner', 'skipped'),
  step('Failing Test', 'sdlc-test-author'),
  step('Implement Fix', 'sdlc-fix-implementer'),
  step('Jira: Dev Done', 'sdlc-jira-tracker'),
  step('Verify + Regression', 'sdlc-verifier'),
  step('Security Review', 'sdlc-security-review'),
  step('Evidence Bundle + PR', 'sdlc-evidence-and-pr', 'pending'),
  step('PR Checks + Review', 'sdlc-pr-follow-up', 'pending'),
]
const candidates = sendBackCandidates(RUNBOOK_A, 'evidence-bundle-pr')
const opt = o => ({ key: 'x', label: '', next: '', delivers: 'd', leaves: 'l', ...o })
const at = o => suggestSendBack(opt(o), candidates)?.label

// ── what may be sent back to ─────────────────────────────────────────────
assert.deepEqual(candidates.map(s => s.label), RUNBOOK_A.slice(0, 8).map(s => s.label),
  'every settled step, skipped included; not the gate step, not what has not run')

// ── ASECRM-295, as written ───────────────────────────────────────────────
const brief295 = {
  question: 'Approve ASECRM-295: pin the two Claude CI workflows to a fixed commit?',
  situation: 'Two workflow files ran helper code by branch name.',
  options: [
    { key: 'a', label: 'Approve — merge the pin and the guard as they stand', next: 'The pipeline opens the pull request from fix/ASECRM-295-64098d36 into develop with both commits: the two-line pin and the guard test. Normal review and CI follow on the PR.', delivers: 'd', leaves: 'l' },
    { key: 'b', label: 'Approve the pin, but send it back to drop .agent/plan.md from the branch', next: 'The fix step re-runs and removes .agent/plan.md from version control — the planning note already exists in this run\'s artifacts, so nothing is lost. The two-line pin and the guard test are unchanged, and the tests are re-run.', delivers: 'd', leaves: 'l' },
    { key: 'c', label: 'Send back — pin to a release tag instead of a commit SHA', next: 'The run cannot do this on its own: alepolab/code-review-config publishes no tags and no releases, so somebody would first have to cut a release there.', delivers: 'd', leaves: 'l' },
  ],
}
const parsed = parseDecisionBrief(JSON.stringify(brief295))
assert.ok('brief' in parsed, 'the 295 brief parses')
const [a, b, c] = parsed.brief.options
assert.equal(suggestSendBack(b, candidates)?.label, 'Implement Fix',
  'THE CASE: "the fix step re-runs" is the step labelled Implement Fix')
assert.equal(suggestSendBack(a, candidates), undefined, 'approving sends nothing back')
assert.equal(suggestSendBack(c, candidates), undefined, 'and an option that names no work names no step, rather than a guess')

// ── the brief says it outright ───────────────────────────────────────────
const told = parseDecisionBrief(JSON.stringify({ ...brief295, options: [brief295.options[0], { ...brief295.options[2], sendBackTo: 'Failing Test' }] }))
assert.equal(told.brief.options[1].sendBackTo, 'Failing Test', '`sendBackTo` survives parsing')
assert.equal(suggestSendBack(told.brief.options[1], candidates)?.label, 'Failing Test', 'and wins over anything the prose says')
assert.equal(at({ label: 'Rework', sendBackTo: 'implement fix' }), 'Implement Fix', 'matched without regard to case')
assert.equal(at({ label: 'Rework', sendBackTo: 'sdlc-verifier' }), 'Verify + Regression', 'or by the agent that runs it')
assert.equal(at({ label: 'Send back to the fix step', sendBackTo: 'Deploy' }), 'Implement Fix',
  'a `sendBackTo` naming no step of this run falls back to the prose')

// ── the prose, one row per way a brief names the step ───────────────────
const rows = [
  ['Send back so Implement Fix narrows the change', 'Implement Fix', 'a step named by its label'],
  ['Send back to Implement Fix.', 'Implement Fix', 'a label ending the sentence'],
  ['Send back: the implementer reverts the second commit', 'Implement Fix', '"the implementer"'],
  ['Send back so the test author rewrites the oracle', 'Failing Test', '"the test author"'],
  ['Send back: rewrite the test so it checks criterion 4 only', 'Failing Test', '"rewrite the test"'],
  ['Send it back to intake to restate the scope', 'Ticket Intake', '"intake"'],
  ['Send back; the verify step re-runs the full suite', 'Verify + Regression', '"the verify step"'],
  ['Send back for another security review of the parser', 'Security Review', 'a label in lower case'],
  ['Send back: the fix step reverts it, then the test author widens the oracle', 'Implement Fix', 'two roles: the one named first'],
]
for (const [label, want, why] of rows) assert.equal(at({ label }), want, why)

// ── what must not be taken for a step ───────────────────────────────────
const withPlan = [...candidates, step('Plan', 'sdlc-ce-plan')]
assert.equal(suggestSendBack(opt({ label: 'Send back to drop .agent/plan.md', next: 'The fix step removes it.' }), withPlan)?.label, 'Implement Fix',
  'a step called Plan is not named by a file called plan.md')
assert.equal(at({ label: 'Approve, the implementer\'s fix is right' }), undefined, 'naming a role without sending back is not a send-back')
assert.equal(suggestSendBack(opt({ label: 'Send back to the fix step' }), candidates.filter(s => s.agentSlug !== 'sdlc-fix-implementer')), undefined,
  'a role this run has no step for suggests nothing')

// ── review of #129/#130 ──────────────────────────────────────────────────
// An approve option that mentions a re-run is not a send-back: taken for one,
// its step was pre-selected and a send-back spent on a step nobody asked to redo.
assert.equal(at({ label: 'Approve - merge the fix as it stands', next: 'The pull request opens; the full suite is re-run on the PR by CI, and Verify + Regression already passed.' }), undefined,
  'THE REVIEW FINDING: "re-run" in an approve option is not a send-back')
assert.equal(at({ label: 'Approve, then redo the docs in a follow-up' }), undefined, 'nor is "redo"')
// A send-back the option says it is not doing (review of d43131c): each was shown
// under the approve option as "Send back to: Implement Fix", and pre-selected.
for (const label of [
  'Approve as it stands - no need to send it back to the implementer',
  'Approve: nothing to send back; the implementer\'s fix is right',
  'Approve rather than sending it back to Implement Fix',
  'Approve - do not send it back',
  'Approve without sending anything back',
]) assert.equal(at({ label }), undefined, `THE REGRESSION: a negated send-back was taken for one: "${label}"`)
// The negation belongs to its own clause: a later, plain send-back still counts.
assert.equal(at({ label: 'Do not approve; send it back to Implement Fix' }), 'Implement Fix', 'a negation in another clause does not cancel the send-back')
assert.equal(at({ label: 'Not ready - send back so Implement Fix narrows the change' }), 'Implement Fix', 'nor does one before a spaced dash')
// Review of 4cca7e4: a comma or an unspaced dash starts a clause too, and the
// title, label and next are separate sentences. Each of these returned
// undefined, the negation before the comma or in the title cancelling the
// send-back after it.
for (const [o, want] of [
  [{ label: 'Do not merge, send it back to Implement Fix' }, 'Implement Fix'],
  [{ label: 'Not ready yet, so send it back to the implementer' }, 'Implement Fix'],
  [{ label: 'The test is not enough, send it back to the test author' }, 'Failing Test'],
  [{ label: 'Not yet—send it back to Implement Fix' }, 'Implement Fix'],
  [{ label: 'Not yet–send it back to Implement Fix' }, 'Implement Fix'],
  [{ title: 'Not ready', label: 'Send back so the implementer reverts the second commit' }, 'Implement Fix'],
  [{ label: 'Approve as is', next: 'Nothing is redone. Send it back to Implement Fix only if CI fails' }, 'Implement Fix'],
]) assert.equal(at(o), want, `THE REVIEW FINDING: a negation in an earlier clause cancelled the send-back: ${JSON.stringify(o)}`)
// Still negated within the clause after a comma.
assert.equal(at({ label: 'Approve as it stands, no need to send it back' }), undefined, 'a negation after the comma, in the send-back\'s own clause, still counts')

// The step named first wins, not the longest label.
assert.equal(at({ label: 'Send back so Implement Fix narrows it after Security Review signs off' }), 'Implement Fix', 'the step named first')
// The guard before a label, alone: "docs/Plan" is a path, not the step called Plan.
assert.equal(suggestSendBack(opt({ label: 'Send back; docs/Plan has the outline' }), withPlan), undefined, 'a label inside a path is not the step')
// The gate's own step is never a target, even when it ran before (a gate re-raised on a revisit).
const regated = sendBackCandidates([...RUNBOOK_A.slice(0, 8), { ...RUNBOOK_A[8], status: 'completed' }], 'evidence-bundle-pr')
assert.ok(!regated.some(s => s.stepId === 'evidence-bundle-pr'), 'the step the gate waits on is not offered, settled or not')

// ── when the brief names its send-back steps ────────────────────────────
// A brief whose options carry `sendBackTo` has said which ones send back; the
// others are not read for it. Each of these approve options said "send it
// back" only to say it was not needed, and was shown as a send-back.
{
  const named = opt({ key: 'b', label: 'Send back', sendBackTo: 'Implement Fix' })
  for (const label of [
    'Approve - sending it back to the implementer is not needed',
    'Approve; a send-back to Implement Fix is not warranted',
    'Approve; it is unnecessary to send it back to the implementer',
    'Approve as is; we could send it back to the implementer, but the fix is right',
  ]) {
    const a = opt({ key: 'a', label })
    assert.equal(suggestSendBack(a, candidates, [a, named]), undefined, `THE REVIEW FINDING: an option without \`sendBackTo\` in a brief that uses it is not a send-back: "${label}"`)
  }
  assert.equal(suggestSendBack(named, candidates, [named])?.label, 'Implement Fix', 'the option that names its step still does')
  // A brief that never uses `sendBackTo` is read from its prose, as before.
  const prose = opt({ key: 'b', label: 'Send back to Implement Fix' })
  assert.equal(suggestSendBack(prose, candidates, [opt({ key: 'a', label: 'Approve' }), prose])?.label, 'Implement Fix', 'no option names a step: the prose decides')
}

// ── Cmd/Ctrl+Enter follows the primary action ───────────────────────────
const { noteSubmitAction, sendBackPreselect } = await import('../app/utils/gateSubmit.ts')
const key = o => noteSubmitAction({ isReply: false, sendingBack: false, canRework: false, canApprove: true, ...o })
assert.equal(key({}), 'continue', 'at a plain gate it approves')
assert.equal(key({ sendingBack: true, canRework: true }), 'rework',
  'THE REVIEW FINDING: with Send back open, the shortcut sends back - it approved, the note typed for the send-back having satisfied approval')
assert.equal(key({ sendingBack: true, canRework: false }), null, 'and does nothing until a step and a note are chosen, never approving instead')
assert.equal(key({ canApprove: false }), null, 'an approval that needs a reason first is not sent by the shortcut either')
assert.equal(key({ isReply: true, sendingBack: true }), 'respond', 'a question is answered')

// ── which step "Send back…" opens on ──
const fix = { key: 'b', stepId: 'fix' }, verify = { key: 'c', stepId: 'verify' }
assert.equal(sendBackPreselect('(b)', [fix, verify]), 'fix', 'the recommended send-back option\'s step')
assert.equal(sendBackPreselect('B', [fix]), 'fix', 'matched however the brief spells the key')
assert.equal(sendBackPreselect('(a)', [fix]), 'fix', 'an approve recommendation with one send-back option: that option\'s step, the only one there is')
assert.equal(sendBackPreselect('(a)', [fix, verify]), '', 'an approve recommendation with two send-backs naming different steps: no guess')
assert.equal(sendBackPreselect(undefined, [fix, { key: 'd', stepId: 'fix' }]), 'fix', 'two options naming the same step: that step')
assert.equal(sendBackPreselect('(b)', []), '', 'no send-back option: nothing')

// The reviewer's scenario: (a) approve, (b) a "Not ready" send-back recommended,
// (c) a test-author send-back. With (b) read as no send-back, Send back opened
// on Failing Test, (c)'s step - the wrong one.
{
  const brief = { options: [
    opt({ key: 'a', label: 'Approve as it stands' }),
    opt({ key: 'b', title: 'Not ready', label: 'Send back so the implementer reverts the second commit' }),
    opt({ key: 'c', label: 'Send back so the test author rewrites the oracle' }),
  ], recommendation: { option: 'b', why: 'w' } }
  const targets = brief.options.flatMap(o => { const s = suggestSendBack(o, candidates, brief.options); return s ? [{ key: o.key, stepId: s.stepId }] : [] })
  assert.equal(sendBackPreselect(brief.recommendation.option, targets), 'implement-fix', 'THE REVIEW FINDING: Send back opens on the recommended option\'s step, Implement Fix')
}

console.log('send-back suggestion: all assertions passed')
