import type { H3Event } from 'h3'
import type { WorkflowRun } from '../../shared/types/run'
import { currentRole } from './session'

/**
 * 403 unless this gate is the caller's to answer.
 *
 * `requireCapability(event, 'answerGate')` asks whether you may answer *a* gate.
 * This asks whether you may answer *this* one. Both are needed: developer and QA
 * both hold `answerGate`, so without this a developer could accept QA's
 * verification of their own change — which is the single review the runbook puts
 * in someone else's hands on purpose.
 *
 * Two deliberate escapes:
 *
 * - A gate with no `role` is anyone's, for a workflow that never declared one.
 *   Refusing those would break every existing run mid-flight, and a gate nobody
 *   can answer is worse than one anybody can.
 * - An operator may always answer. They are the backstop for a role nobody on
 *   this instance holds; without it, a two-person team with no QA would have a
 *   run stuck at gate 3 forever and no way to move it that was not a lie about
 *   who decided.
 */
export async function requireGateRole(event: H3Event, run: WorkflowRun): Promise<void> {
  const want = run.question?.role
  if (!want) return

  const role = await currentRole(event)
  if (role === want || role === 'operator') return

  throw createError({
    statusCode: 403,
    // Names the owner, not just the refusal: "forbidden" against a control you
    // were shown is indistinguishable from a bug, and the person reading this
    // needs to know who to go and ask.
    message: `This gate is ${want}'s decision to make. Your role is ${role}. Ask ${want}, or an operator.`,
  })
}
