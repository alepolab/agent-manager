import { agentManagerSettings } from './appSettings.ts'
import type { WorkflowRun } from '../../shared/types/run'

/**
 * How many runs this instance will carry at once.
 *
 * The workspace lock (workspace.ts) stops two runs corrupting one checkout.
 * It says nothing about the total, and the two are different hazards: forty
 * runs against forty different directories pass the lock forty times and are
 * still forty concurrent agent pipelines, each with its own token and minute
 * budget, all on one machine's CPU and one account's rate limit. Nothing
 * between "start a run" and "start one per ticket on the board" refused.
 *
 * A ceiling rather than a queue, deliberately. There is no `queued` run
 * status — a run is running, paused, or settled — so a queue would mean a new
 * state in the store, the runner, the type and every surface that renders a
 * status, to hold work that a person can equally well start when a slot frees.
 * The honest small thing is to refuse, and to say what is occupying the slots.
 */

/** `paused` counts: it holds a checkout and a budget and will resume. */
export const LIVE_STATUSES: WorkflowRun['status'][] = ['running', 'paused']

export const isLive = (r: Pick<WorkflowRun, 'status'>): boolean =>
  LIVE_STATUSES.includes(r.status)

/**
 * The configured ceiling, or null for none.
 *
 * `AGENT_MAX_CONCURRENT_RUNS` wins over the setting, matching how the run
 * budget already resolves: an operator edits the instance on the settings
 * page, and a deployment that must hold a harder line does it in env where
 * the page cannot raise it.
 */
export function maxConcurrentRuns(): number | null {
  const fromEnv = Number(process.env.AGENT_MAX_CONCURRENT_RUNS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv)
  const configured = Number(agentManagerSettings().maxConcurrentRuns)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null
}

export interface CapacityVerdict {
  ok: boolean
  /** Runs counted as live at the moment of the check. */
  live: number
  limit: number | null
  /** Why not, naming what to do about it. Empty when ok. */
  reason?: string
}

/**
 * Whether one more run may start.
 *
 * Takes the run list rather than reading it, so the caller decides how fresh
 * the answer is and the rule stays testable without a store.
 */
export function capacityFor(runs: Pick<WorkflowRun, 'status'>[]): CapacityVerdict {
  const limit = maxConcurrentRuns()
  const live = runs.filter(isLive).length
  if (limit === null || live < limit) return { ok: true, live, limit }
  return {
    ok: false,
    live,
    limit,
    reason: `This instance allows ${limit} run${limit === 1 ? '' : 's'} at once and ${live} ${live === 1 ? 'is' : 'are'} already live.`
      + ' Wait for one to settle, stop one, or raise the limit under Settings → Run capacity.',
  }
}

/** One line for a header or a badge: "3 of 5 running", or "3 running" with no cap. */
export function describeCapacity(runs: Pick<WorkflowRun, 'status'>[]): string {
  const { live, limit } = capacityFor(runs)
  return limit === null ? `${live} live` : `${live} of ${limit} live`
}
