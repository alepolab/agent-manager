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

console.log('send-back suggestion: all assertions passed')
