/**
 * How far along a working step is, against what that kind of step usually
 * takes - the line under each run in Home's "Running now".
 *
 * On 6 Oct, ASECRM-386's Implement Fix had run two hours with 421 replies.
 * Alone those numbers say nothing; against a typical 86 replies and 20
 * minutes they say it is five times the usual size.
 *
 *   node scripts/test-step-progress.mjs
 */
import assert from 'node:assert/strict'

const { stepNorms, stepProgress, runningStepsProgress, MIN_SAMPLES, QUIET_SEC } = await import('../shared/utils/stepProgress.ts')

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 6, 6, 0, 0)
const done = (agentSlug, replies, minutes) => ({ stepId: 's', label: 'L', agentSlug, status: 'completed', input: '', output: '', visits: 1, assistantMessages: replies, startedAt: T0, completedAt: T0 + minutes * MIN })

// ── norms ────────────────────────────────────────────────────────────────
const fixes = [[60, 12], [80, 18], [86, 20], [90, 25], [120, 40], [100, 34]].map(([r, m]) => done('sdlc-fix-implementer', r, m))
const runs = [
  { steps: fixes.slice(0, 3) },
  { steps: [...fixes.slice(3), done('sdlc-jira-tracker', 0, 0), { ...done('sdlc-fix-implementer', 999, 999), status: 'failed' }] },
  { steps: [done('sdlc-verifier', 100, 20), done('sdlc-verifier', 110, 25)] },
]
const norms = stepNorms(runs)
assert.deepEqual(norms['sdlc-fix-implementer'], { n: 6, replies: 88, minutes: 23, minutesP75: 34 }, 'medians and the 75th percentile, over completed steps only')
assert.equal(norms['sdlc-jira-tracker'], undefined, 'a step the runner did itself, with no replies, sets no norm')
assert.equal(norms['sdlc-verifier'], undefined, `fewer than ${MIN_SAMPLES} completed steps is no "usual"`)

// ── progress, the four runs working on 6 Oct ────────────────────────────
const now = T0 + 121 * MIN
const working = (label, agentSlug, replies, minutes, quietSec = 5) => ({ stepId: label, label, agentSlug, status: 'running', assistantMessages: replies, startedAt: now - minutes * MIN, lastActivityAt: now - quietSec * 1000 })
const N = { 'sdlc-fix-implementer': { n: 129, replies: 86, minutes: 20, minutesP75: 34 }, 'sdlc-pr-follow-up': { n: 45, replies: 62, minutes: 9, minutesP75: 13 } }
for (const [step, stage, words] of [
  [working('Implement Fix', 'sdlc-fix-implementer', 421, 121), 'far-over', '5× the usual size'],
  [working('Implement Fix', 'sdlc-fix-implementer', 69, 15), 'most', 'most of the way'],
  [working('Implement Fix', 'sdlc-fix-implementer', 33, 1), 'early', 'early on'],
  [working('PR Checks + Review', 'sdlc-pr-follow-up', 8, 2), 'starting', 'just started'],
  [working('Implement Fix', 'sdlc-fix-implementer', 50, 9), 'halfway', 'about halfway'],
  [working('Implement Fix', 'sdlc-fix-implementer', 130, 30), 'over', 'past the usual size'],
]) {
  const p = stepProgress(step, N, now)
  assert.equal(p.stage, stage, `${step.assistantMessages} of ~${N[step.agentSlug].replies}: ${stage}`)
  assert.equal(p.words, words)
}
const long = stepProgress(working('Implement Fix', 'sdlc-fix-implementer', 421, 121), N, now)
assert.equal(long.minutes, 121); assert.equal(long.replies, 421); assert.equal(long.norm.replies, 86)

// ── what is not estimated ───────────────────────────────────────────────
const unknown = stepProgress(working('Stand Up Stack', 'sdlc-stack-provisioner', 40, 6), N, now)
assert.equal(unknown.words, undefined, 'no norm: elapsed time and replies, and no guess')
assert.equal(unknown.minutes, 6)
// Replies carry the estimate, not the clock: a quota pause stretches minutes with nothing done.
assert.equal(stepProgress(working('Implement Fix', 'sdlc-fix-implementer', 20, 90), N, now).stage, 'early', 'ninety minutes with 20 replies is early on, not over')

// ── quiet ──────────────────────────────────────────────────────────────
assert.equal(stepProgress(working('Implement Fix', 'sdlc-fix-implementer', 69, 15, 30), N, now).quietSec, undefined, 'a step active seconds ago is not called quiet')
assert.equal(stepProgress(working('Implement Fix', 'sdlc-fix-implementer', 69, 15, 127), N, now).quietSec, 127, `quiet past ${QUIET_SEC}s is mentioned`)

// ── only the steps that are working, every one of them ─────────────────
const wave = { steps: [done('sdlc-ticket-intake', 20, 2), working('Verify + Regression', 'sdlc-verifier', 30, 5), working('Security Review', 'sdlc-security-review', 10, 5), { ...working('Evidence', 'sdlc-evidence-and-pr', 0, 0), status: 'pending' }] }
assert.deepEqual(runningStepsProgress(wave, N, now).map(p => p.label), ['Verify + Regression', 'Security Review'], 'a parallel wave shows each working step')

console.log('step progress: all assertions passed')
