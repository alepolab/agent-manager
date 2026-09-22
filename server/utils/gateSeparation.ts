import { listRoles } from './roles.ts'
import type { WorkflowRun } from '../../shared/types/run'

/**
 * The same person must not answer both sides of a review.
 *
 * `requireGateRole` asks whether this gate is yours by ROLE. This asks whether
 * it is yours given what you already decided on this run. The runbook states
 * the rule for one pair and nothing enforced it:
 *
 *   "VERIFY_GATE — Owner: QA, and never the same actor that answered
 *    IMPL_GATE." (.agents/workflows/runbook-a/resources/phase-gates.md)
 *
 * Role separation alone cannot carry this. `roles.json` defaults every
 * unlisted login to `operator`, and an operator may answer any gate, so on an
 * instance where nobody has been assigned a role the developer who approved
 * the implementation is also the person accepting its verification — which is
 * the single review the runbook puts in someone else's hands on purpose.
 *
 * THE BACKSTOP IS THE POINT, not an exception to it. A two-person team with
 * nobody else holding the reviewing role must still be able to finish a run:
 * a control that deadlocks the work it governs gets switched off, and then
 * there is no control. So separation is enforced only when the instance can
 * actually satisfy it — when someone else holds the role this gate wants.
 * When it cannot, the answer is allowed and the reason is returned to the
 * caller to put on the record, so "one person did both" is a visible fact
 * about that run rather than a silent one.
 */
export interface SeparationCheck {
  /** Set when the same actor answered the paired gate and nobody else could. */
  sameActorNote?: string
}

/** Which earlier gate each gate must not share an actor with. */
const PAIRED_WITH: Partial<Record<string, string>> = {
  verify: 'impl',
}

export async function checkGateSeparation(run: WorkflowRun, me: string | undefined): Promise<SeparationCheck> {
  const kind = run.question?.gateKind
  const pairedKind = kind ? PAIRED_WITH[kind] : undefined
  if (!pairedKind) return {}

  if (!me) return {}

  // Whoever answered the paired gate on THIS run. Decisions carry the gate
  // kind precisely so this does not have to re-derive it from a step label.
  const paired = (run.decisions ?? []).find(d => d.gateKind === pairedKind && d.verdict === 'approved')
  if (!paired || paired.by !== me) return {}

  const want = run.question?.role
  if (!want) return {}

  // Could anyone else answer? Only the people explicitly listed count: an
  // unlisted login defaults to `operator`, and counting those would mean every
  // instance looks staffed and the refusal blocks work nobody else can do.
  const roles = await listRoles()
  const others = Object.entries(roles)
    .filter(([login, role]) => login !== me && (role === want || role === 'operator'))
    .map(([login]) => login)

  if (others.length) {
    const message = `You approved "${paired.label}" on this run, so this verification is not yours to accept as well. `
      + `Ask ${others.slice(0, 3).join(', ')}${others.length > 3 ? ' or another ' + want : ''}.`
    // A plain Error carrying statusCode, not createError: this module is
    // imported directly by scripts/test-gate-separation.mjs under plain node,
    // and h3 is not resolvable there. The route turns it into a 403.
    throw Object.assign(new Error(message), { statusCode: 403 })
  }

  return {
    sameActorNote: `answered by the same person who approved "${paired.label}"; `
      + `no other ${want} or operator is listed on this instance`,
  }
}
