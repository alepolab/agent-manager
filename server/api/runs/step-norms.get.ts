import { isTestRun } from '../../../shared/types/run.ts'
import { stepNorms, type StepNorm } from '../../../shared/utils/stepProgress.ts'
import { listRuns } from '../../utils/workflowRunStore'

/**
 * What each kind of step usually takes - median replies and minutes per
 * agent, from completed steps of real runs - so Home can say how far along a
 * working step is (shared/utils/stepProgress.ts).
 *
 * Cached for ten minutes: it reads every run record, and a median over
 * hundreds of completed steps does not move between two page loads.
 */
const TTL_MS = 10 * 60_000
let cached: { at: number, norms: Record<string, StepNorm> } | null = null

export default defineEventHandler(async () => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.norms
  const norms = stepNorms((await listRuns()).filter(r => !isTestRun(r)))
  cached = { at: Date.now(), norms }
  return norms
})
