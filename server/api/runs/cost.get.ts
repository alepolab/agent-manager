import { listRuns } from '../../utils/workflowRunStore.ts'
import { aggregateCost } from '../../utils/costReport.ts'

/**
 * Cost aggregated across runs - a week's spend, a workflow's spend, made
 * visible without opening a bundle. Query params (all optional):
 *   workflowSlug - only that workflow's runs (same filter listRuns already
 *     supports; a static route wins over the `[id]` sibling for the literal
 *     path "cost", so this and GET /api/runs/[id] never collide).
 *   since - only runs started at or after this instant. Accepts an ISO
 *     timestamp or epoch milliseconds; an unparsable value is ignored rather
 *     than silently matching nothing.
 *
 * See costReport.ts for how an unmeasured step or an unpriced model is
 * handled - excluded from cost_usd, never guessed, and always visible via
 * totals.unmeasured_step_count / unpriced_step_count / totals.complete.
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const workflowSlug = typeof query.workflowSlug === 'string' ? query.workflowSlug : undefined

  let sinceMs: number | undefined
  if (typeof query.since === 'string' && query.since.trim()) {
    const asNumber = Number(query.since)
    const parsed = Number.isFinite(asNumber) ? asNumber : Date.parse(query.since)
    if (Number.isFinite(parsed)) sinceMs = parsed
  }

  const runs = (await listRuns(workflowSlug)).filter(r => sinceMs === undefined || r.startedAt >= sinceMs)
  return aggregateCost(runs)
})
