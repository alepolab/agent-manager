/**
 * A resumed call must not mistake the CLI's replay turn for its own answer.
 *
 * The defect this covers, observed on 2026-09-15 in run b2470236 (ASECRM-199):
 * the test-author step ran out of its 30-minute wall-clock budget while a
 * containerised Gradle build was running in the background. The runner retried
 * it with `resume`, which is the point of resuming — the step had already
 * written its oracle and only needed to run it. But resuming a session whose
 * process died holding a background task makes the CLI close that turn itself
 * first: "Continue from where you left off." answered by a `<synthetic>` "No
 * response requested." with no model call behind it, and a `result` emitted for
 * it BEFORE the queued instruction is read.
 *
 * agentCaller closed its input stream on that result, so the real instruction
 * ran in a session whose input was already gone, and the CLI then refused every
 * `run_in_background` call with "The user doesn't want to take this action right
 * now." The step could not restart the build it existed to run, and halted with
 * its oracle never executed — 80 turns and ~$2 of model time for nothing.
 *
 * Reproduced through the runner with a probe agent (a 60s budget, a live
 * background task): rejected before this fix, accepted after. The same resume
 * WITHOUT a stale background task has no replay turn at all, which is why the
 * rule may never fire on an ordinary result — a call whose only result was
 * ignored would hang until its deadline.
 *
 *   node scripts/test-agent-resume-replay.mjs
 */
import assert from 'node:assert/strict'

const { isResumeReplay, isReplayOnly, SYNTHETIC_MODEL } = await import('../server/utils/agentCaller.ts')

// ── the replay turn itself: resuming, first result, nothing but synthetic output ──
assert.equal(isResumeReplay({ resuming: true, resultsSoFar: 0, modelSpoke: false }), true,
  'the replay turn of a resumed call must not end the call')

// ── a real answer ends the call, even on a resume ──
assert.equal(isResumeReplay({ resuming: true, resultsSoFar: 0, modelSpoke: true }), false,
  'a first result with a real model turn behind it is the answer, not a replay')

// ── a resume with no replay turn still ends: the guard against hanging ──
// A session interrupted mid-FOREGROUND-tool resumes straight into the
// instruction, so its first result is the answer. Were that ignored, the step
// would sit until its wall-clock budget expired, turning a retry into a
// half-hour of nothing.
assert.equal(isResumeReplay({ resuming: true, resultsSoFar: 1, modelSpoke: false }), false,
  'only the FIRST result of a resumed call can be a replay')

// ── a fresh call has no replay turn to skip ──
for (const modelSpoke of [true, false]) {
  assert.equal(isResumeReplay({ resuming: false, resultsSoFar: 0, modelSpoke }), false,
    'a call that is not resuming always ends on its first result')
}

// ── the marker the caller matches on is the CLI's, not ours ──
// agentCaller decides `modelSpoke` by comparing the assistant message's model
// to this string. If Claude Code ever stops stamping synthetic messages this
// way, every result looks like a real turn and the behaviour falls back to
// what it was before this fix, which is the safe direction.
assert.equal(SYNTHETIC_MODEL, '<synthetic>')

// ── the replay was the ONLY result: that is a failure, not an empty answer ──
// The skip above assumes a real result follows the replay. A session that was
// already terminal when it was resumed emits the replay and then ends, so
// nothing is ever accepted and `result` stays the empty string it started as.
// The step used to record that as a green completion with no output and no
// model; parseAsk and parseSkip both read '' as falsy, so nothing downstream
// noticed, and `produces` only catches it for a step that declares artifacts.
assert.equal(isReplayOnly({ accepted: false, replayed: 1 }), true,
  'a resumed call whose only result was discarded as a replay ran nothing and must not return green')
assert.equal(isReplayOnly({ accepted: false, replayed: 3 }), true,
  'however many were discarded')

// ── and the cases that must stay legal ──
assert.equal(isReplayOnly({ accepted: true, replayed: 1 }), false,
  'a replay followed by a real result is the ordinary resumed call')
assert.equal(isReplayOnly({ accepted: true, replayed: 0 }), false,
  'a fresh call that answered')
assert.equal(isReplayOnly({ accepted: false, replayed: 0 }), false,
  'a call that never replayed anything has a different problem, reported elsewhere - this check must not claim it')

console.log('agent resume replay: ok')
