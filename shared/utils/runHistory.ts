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

export function recordSendBack(run: WorkflowRun, s: Omit<SendBack, 'at'>, at = Date.now()): SendBack {
  const entry: SendBack = { ...s, at }
  run.sendBacks = [...(run.sendBacks ?? []), entry]
  return entry
}
