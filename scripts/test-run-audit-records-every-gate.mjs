// Approving one gate and landing straight on the next must still be recorded.
//
// Both handlers gated their audit write on `before.status !== run.status`. A
// run stays `paused` across two consecutive approval gates - only
// question.stepId moves - so the second approval wrote nothing, dropping
// exactly the "who approved this" record these routes exist to keep.
//
// respond.post.ts had a second bug on the same line: it took the step id from
// currentStepIds[0], which the runner sets to [] on the gate path, so the
// event recorded no step at all - in the handler for answering a question,
// where question.stepId is the authoritative one.
//
// These are route handlers, so they are pinned by reading the source, the way
// test-manual-run-ticket-key.mjs pins the fields a start passes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const routes = {
  'continue.post.ts': readFileSync(new URL('../server/api/runs/[id]/continue.post.ts', import.meta.url), 'utf8'),
  'respond.post.ts': readFileSync(new URL('../server/api/runs/[id]/respond.post.ts', import.meta.url), 'utf8'),
}

for (const [name, src] of Object.entries(routes)) {
  assert.doesNotMatch(src, /if \(before && before\.status !== run\.status\)/,
    `${name}: the audit write is gated on the status alone again; two consecutive gates both leave the run paused, so the second approval goes unrecorded`)
  assert.match(src, /before\.question\?\.stepId !== run\.question\?\.stepId/,
    `${name}: the gate does not compare the question, which is the thing that actually moves between two gates`)
  assert.match(src, /stepId: before\.question\?\.stepId \|\| before\.currentStepIds\[0\]/,
    `${name}: the audited step id does not prefer the question's own step`)
  assert.match(src, /appendRunAudit\(id, \{/, `${name}: no audit write at all`)
}

// The predicate itself, over the states these routes actually see. Written out
// rather than described, because every row here was a real transition.
const shouldAudit = (before, after) =>
  before.question?.stepId !== after.question?.stepId || before.status !== after.status

const gate = (stepId) => ({ stepId, kind: 'approval' })

for (const [why, before, after, expected] of [
  ['approving a gate and landing on the NEXT gate - the regression',
    { status: 'paused', question: gate('a') }, { status: 'paused', question: gate('b') }, true],
  ['approving the last gate, so the run resumes',
    { status: 'paused', question: gate('a') }, { status: 'running', question: undefined }, true],
  ['answering a question and landing on another question',
    { status: 'paused', question: { stepId: 'a', kind: 'question' } },
    { status: 'paused', question: { stepId: 'b', kind: 'question' } }, true],
  ['a review gate resuming',
    { status: 'awaiting_review', question: gate('esc') }, { status: 'running', question: undefined }, true],
  ['continuing a paused run that had no question',
    { status: 'paused', question: undefined }, { status: 'running', question: undefined }, true],
  ['a call that changed nothing',
    { status: 'paused', question: gate('a') }, { status: 'paused', question: gate('a') }, false],
  ['a running run that stayed running',
    { status: 'running', question: undefined }, { status: 'running', question: undefined }, false],
]) {
  assert.equal(shouldAudit(before, after), expected, why)
}

console.log('run audit records every gate: all checks passed')
