/**
 * A step that ends its turn to wait for a background job is told, on its
 * retry, that no notification will come, and how to wait instead.
 *
 * ASECRM-293's verifier started a 28-minute regression build and ended with
 * "I'll wait for the background notification that the regression build
 * container has finished" on each of its three visits.
 *
 *   node scripts/test-ended-to-wait.mjs
 */
import assert from 'node:assert/strict'

const { endedToWait } = await import('../server/utils/workflowRunner.ts')

for (const t of [
  "I'll wait for the background notification that the regression build container has finished before proceeding.",
  'The full backend regression build is still running in the background (it took ~28 minutes previously). I\'ll pause here and pick up as soon as it completes.',
  'Waiting for the background task to finish.',
]) assert.equal(endedToWait(`lots of work\n\n${t}`), true, t)

for (const t of [
  'VERDICT: PASS - 412 tests, 0 failures. regression.xml written.',
  'The build ran in the foreground and finished in 28 minutes.',
  'Once the migration completes the column is non-null.',
]) assert.equal(endedToWait(t), false, t)

console.log('ok - a step that ended its turn to wait is recognised')
process.exit(0)
