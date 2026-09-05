import { listRuns } from '../../utils/workflowRunStore'

/**
 * Every workflow run, newest first, across all workflows.
 *
 * The per-workflow endpoint (GET /api/workflows/[slug]/runs) was the only way
 * to reach a run, so run history was discoverable only if you already knew
 * which workflow produced it — and a run started headlessly (scripts/run-ticket.mjs)
 * had no obvious home in the UI at all. `listRuns()` has always accepted an
 * optional slug; this simply exposes the unfiltered call.
 */
export default defineEventHandler(async () => listRuns())
