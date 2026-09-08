/**
 * What the /runs page says a live run is doing.
 *
 *   node scripts/test-run-activity.mjs
 *
 * The page exists to answer "what is happening right now" without opening
 * every run, so these four answers are the whole feature: which step to name,
 * how far along it is, how long the agent has been silent, and whether that
 * silence is worth flagging. Each has a way of being subtly wrong that still
 * renders — a paused run showing no step at all, a never-measured heartbeat
 * drawn as "0s ago", or a warning that fires on every ordinary docker build.
 */
import assert from 'node:assert/strict'
import { currentStep, stepsDone, quietSeconds, isQuiet, QUIET_WARN_SECONDS, shortDuration } from '../app/utils/runActivity.ts'

const step = (stepId, status, extra = {}) => ({ stepId, label: stepId, agentSlug: `agent-${stepId}`, status, visits: 1, ...extra });
const run = (status, steps, currentStepIds = []) => ({ status, steps, currentStepIds });

// A running step is the answer whenever there is one.
{
  const r = run('running', [step('a', 'completed'), step('b', 'running'), step('c', 'pending')])
  assert.equal(currentStep(r)?.stepId, 'b')
}

// A PAUSED run has no running step. Naming nothing is the failure this guards:
// the run is stopped in front of a specific step, and that step is the answer.
{
  const r = run('paused', [step('a', 'completed'), step('b', 'pending'), step('c', 'pending')], ['b'])
  assert.equal(currentStep(r)?.stepId, 'b', 'a paused run names the step it stopped in front of')
}

// With neither, the first unsettled step still renders something truthful.
{
  const r = run('paused', [step('a', 'completed'), step('b', 'skipped'), step('c', 'pending')])
  assert.equal(currentStep(r)?.stepId, 'c')
}

// `skipped` is progress - the run passed it. A failed step is not.
{
  const r = run('running', [step('a', 'completed'), step('b', 'skipped'), step('c', 'failed'), step('d', 'running')])
  assert.equal(stepsDone(r), 2, 'completed and skipped count; failed does not')
}

// Never-measured is null, not zero: a fabricated heartbeat is worse than none.
{
  assert.equal(quietSeconds(step('a', 'running'), Date.now()), null)
  assert.equal(quietSeconds(undefined, Date.now()), null)
  const now = 1_000_000
  assert.equal(quietSeconds(step('a', 'running', { lastActivityAt: now - 45_000 }), now), 45)
}

// The warning fires only past the threshold, and only on a running run.
{
  const now = 10_000_000
  const busy = step('a', 'running', { lastActivityAt: now - (QUIET_WARN_SECONDS - 1) * 1000 })
  const silent = step('a', 'running', { lastActivityAt: now - (QUIET_WARN_SECONDS + 1) * 1000 })
  assert.equal(isQuiet(run('running', [busy]), busy, now), false, 'an ordinary slow tool call does not trip it')
  assert.equal(isQuiet(run('running', [silent]), silent, now), true)
  assert.equal(isQuiet(run('paused', [silent]), silent, now), false,
    'a paused run is waiting on a person, not stalled - the card says so in words')
  assert.equal(isQuiet(run('running', [step('a', 'running')]), step('a', 'running'), now), false,
    'no telemetry is not silence')
}

assert.equal(shortDuration(45_000), '45s')
assert.equal(shortDuration(6 * 60_000), '6m')
assert.equal(shortDuration(-5), '0s')

console.log('run activity: all assertions passed')
