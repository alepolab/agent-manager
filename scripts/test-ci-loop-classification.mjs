/**
 * Self-check for the fix-it loop's prompt contract in app/utils/templates.ts.
 *
 * The loop itself is engine behaviour and is tested in test-workflow-runner.mjs.
 * What this file pins is the half that lives in prose: which failures an agent
 * may send back, and what it has to prove before it does. A red check that never
 * reached this branch's code would otherwise send the run back to rewrite a fix
 * that was never wrong - spending an allowance, a fix step and a full re-verify
 * on a registry outage. Run b2470236 is the case this is written from: both of
 * PR #784's red checks were `pull access denied`.
 *
 *   node scripts/test-ci-loop-classification.mjs
 */
import assert from 'node:assert/strict'
import { agentTemplates as AGENT_TEMPLATES } from '../app/utils/templates.ts'

const body = (id) => {
  const t = AGENT_TEMPLATES.find(a => a.id === id)
  assert.ok(t, `${id} is not an agent template`)
  return t.body
}

// ── 1. PR follow-up classifies every red check before it touches anything ─
{
  const pr = body('sdlc-pr-follow-up')
  for (const cls of ['environmental', 'pre-existing', 'caused by this change'])
    assert.ok(pr.includes(cls), `PR follow-up must name the "${cls}" class`)

  // Verbatim, because an agent matches these against a log by eye. A paraphrase
  // ("registry problems") gives it nothing to compare an actual line to.
  for (const marker of ['pull access denied', 'unauthorized', 'manifest unknown', 'ContainerFetchException', 'no space left on device'])
    assert.ok(pr.includes(marker), `the environmental markers must be quoted verbatim; missing "${marker}"`)

  assert.match(pr, /never sent back/, 'an environmental failure is excluded from send-backs in as many words')
  assert.match(pr, /never counts?\s+against your cycles/, 'and does not consume a fix cycle')
  assert.match(pr, /b2470236/, 'the real case is cited, so the rule reads as evidence rather than as an assertion')
  assert.match(pr, /merge-base/, '"pre-existing" is proved against the base, not claimed')
}

// ── 2. ... and reports what it classified and what it sent back ───────────
{
  const pr = body('sdlc-pr-follow-up')
  assert.match(pr, /^CLASSIFIED: /m, 'the report carries the classification')
  assert.match(pr, /^SENT BACK: /m, 'and whether a send-back was raised')
  assert.ok(pr.includes('PIPELINE-ASK:'), 'PR follow-up can still ask a person')
  assert.match(pr, /PIPELINE-REWORK: Implement Fix/, 'and can now send work back to the implementer')
}

// ── 3. The verifier proves a failure is new before sending it back ────────
{
  const v = body('sdlc-verifier')
  assert.match(v, /PIPELINE-REWORK: Implement Fix/, 'a regression this change caused goes back to the fix step')
  assert.match(v, /merge-base/, 'pre-existing is shown, not assumed')
  assert.match(v, /worktree/, 'and shown without resetting the run\'s own checkout')
  assert.match(v, /locked/, 'a test it believes is simply wrong is a finding: the implementer cannot edit it either')
}

// ── 4. The PR step survives running twice ─────────────────────────────────
// A send-back re-runs everything after the fix step, so this step opens a PR on
// a branch that already has one. `gh pr create` fails there, and a second PR for
// one branch is worse than the error.
{
  const e = body('sdlc-evidence-and-pr')
  assert.match(e, /gh pr list --head/, 'it looks for an existing PR first')
  assert.match(e, /gh pr edit <n> --body-file/, 'and updates that one instead of opening another')
}

// ── 5. The standing rule says what the runner actually does now ───────────
// It used to tell every agent that a third send-back "fails the run". It pauses
// and asks - an agent told otherwise withholds send-backs it should raise.
{
  const rules = body('sdlc-pr-follow-up')
  assert.match(rules, /asks the developer/, 'the third send-back asks rather than fails')
  assert.match(rules, /per kind of problem/, 'and the budget is per trigger, not per run')
  for (const t of AGENT_TEMPLATES.filter(a => a.id.startsWith('sdlc-')))
    assert.ok(!/a third disagreement fails the run/.test(t.body), `${t.id} still carries the old "fails the run" wording`)
}

console.log('✓ ci loop classification contract')
