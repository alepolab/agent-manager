import type { WorkflowRun } from '../types/run'

/**
 * A run as a list needs it: everything a row, a count or a filter reads, and
 * none of what only the run's own page shows.
 *
 * GET /api/runs returned every step's full prompt and output, monitor notes and
 * preflight for every run - 17.6 MB for 234 runs, 11 MB of it `steps[].input`
 * - and /runs fetched it every 5 s while anything was live. The run's page
 * reads the full record from GET /api/runs/:id, so nothing is lost: it is
 * loaded when a run is opened, not with the list.
 *
 * The shape stays a WorkflowRun so list code needs no second type; the dropped
 * step fields come back empty, and `initialPrompt` keeps its first line, which
 * is all a headline or a filter reads.
 */
export function summariseRun(run: WorkflowRun): WorkflowRun {
  const { preflight: _preflight, ...rest } = run
  return {
    ...rest,
    initialPrompt: (run.initialPrompt ?? '').split('\n')[0]!.slice(0, 300),
    steps: run.steps.map(({ input: _input, output: _output, monitorNote: _note, checks: _checks, ...s }) => ({ ...s, input: '', output: '' })),
  }
}
