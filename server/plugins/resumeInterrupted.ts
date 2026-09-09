/**
 * Picks up runs the previous process left mid-step.
 *
 * A container rebuild used to cost whatever step was in flight: the run froze
 * as `interrupted`, and a person had to notice and restart it, which re-ran
 * that step from turn one. Five rebuilds in one afternoon did exactly that to
 * two runs, which is what "the workflow keeps failing and nothing happens"
 * looked like from the outside. With the session resume in the runner this
 * costs seconds instead of a step.
 *
 * RESUME_ON_BOOT=0 turns it off.
 *
 * The delay is deliberate: teamSeed rewrites the workflow files at boot, and a
 * resume that reads one mid-write would rebuild a run against half a workflow.
 * ponytail: a fixed delay, not a handshake — make it a signal if seeding ever
 * grows slow enough to matter.
 */
import { resumeInterruptedRuns } from '../utils/workflowRunner.ts'

export default defineNitroPlugin(() => {
  if (process.env.RESUME_ON_BOOT === '0') return
  setTimeout(() => {
    resumeInterruptedRuns()
      .then((r) => {
        if (r.resumed.length || r.paused.length) {
          console.log(`[resume] ${r.resumed.length} run(s) resumed, ${r.paused.length} paused for a person, ${r.skipped.length} left alone`)
        }
      })
      .catch(err => console.error('[resume] could not resume interrupted runs:', err?.message ?? err))
  }, 5000)
})
