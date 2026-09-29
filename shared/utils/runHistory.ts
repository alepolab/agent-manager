import type { RunStep, SendBack, StepCheck, WorkflowRun } from '../types/run'

/**
 * Append-only history the run stack draws: every monitor verdict per visit,
 * and every agent-raised send-back. In `shared/` because the runner writes it
 * and the tests exercise it without a server.
 */

export function recordCheck(rec: RunStep, verdict: StepCheck['verdict'], note: string, at = Date.now()): StepCheck {
  const check: StepCheck = { visit: rec.visits, verdict, note, at }
  rec.checks = [...(rec.checks ?? []), check]
  return check
}

/**
 * Automatic send-backs allowed per trigger before the run stops and asks.
 *
 * Per trigger rather than per run: a red check and a proven regression are
 * different problems with different fixes, and one spending the other's
 * allowance means a routine second CI failure lands on a person. Shared so
 * the builder and the run stack can say the same number the runner enforces.
 */
export const REWORK_LIMIT = 2

export function recordSendBack(run: WorkflowRun, s: Omit<SendBack, 'at'>, at = Date.now()): SendBack {
  const entry: SendBack = { ...s, at }
  run.sendBacks = [...(run.sendBacks ?? []), entry]
  return entry
}
