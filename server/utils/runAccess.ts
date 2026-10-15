import type { H3Event } from 'h3'
import type { WorkflowRun } from '../../shared/types/run'
import { can, rolesWith, type Capabilities } from '../../shared/types/role'
import { currentRole, currentUser } from './session'
import { getRun } from './workflowRunStore'
import { inScope, scopeFor, supervises } from './hierarchy'

/**
 * The gate every route under /api/runs/:id passes: may this person see this
 * run, and - given a capability - change it?
 *
 * Seeing follows the hierarchy (hierarchy.ts): your own runs and your team's,
 * or every run when you are not placed in it. A run outside that is answered
 * 404, not 403: whether a colleague outside your team has a run going is not
 * yours to learn from a status code.
 *
 * Changing it needs the capability by role, as before. The hierarchy opens a
 * second door only where the route asks for one, and only as narrow as it
 * names:
 *
 * - `owner-or-lead`: the run's starter or their lead - stopping, steering
 *   with a note, dismissing. An L1 developer may stop their own run though no
 *   developer holds runEngine.
 * - `lead`: the starter's lead alone - deciding at a gate for their team. Never
 *   the starter, whose work the gate exists to have someone else review.
 * - omitted: role only. Deleting a run (its evidence and audit trail with it),
 *   restarting from an arbitrary step (past a gate that rejected it) and test
 *   runs stay where they were, with the roles that hold the capability.
 *
 * Returns the run, or null when there is none, leaving the route's own "not
 * found" to answer as it always has.
 */
export type HierarchyGrant = 'owner-or-lead' | 'lead'

export async function requireRunAccess(event: H3Event, capability?: keyof Capabilities, through?: HierarchyGrant): Promise<WorkflowRun | null> {
  const id = getRouterParam(event, 'id')
  const run = id ? await getRun(id) : null
  const user = await currentUser(event)
  const scope = await scopeFor(user?.login)

  if (run && !inScope(scope, run.startedBy)) {
    throw createError({ statusCode: 404, message: 'Run not found' })
  }
  if (!capability) return run

  const role = await currentRole(event)
  if (can(role, capability)) return run
  // The hierarchy's door, only as wide as this route opened it.
  if (run && !scope.all && through) {
    const leads = await supervises(user?.login, run.startedBy)
    if (leads) return run
    if (through === 'owner-or-lead' && user?.login && user.login === run.startedBy) return run
  }

  throw createError({
    statusCode: 403,
    message: `Your role (${role}) cannot do this. Ask ${rolesWith(capability).join(' or ')}${!scope.all && through ? ', or your lead' : ''}.`,
  })
}

/** Runs this request may see, from a list. Every list of runs goes through this. */
export async function visibleRuns<T extends { startedBy?: string }>(event: H3Event, runs: T[]): Promise<T[]> {
  const scope = await scopeFor((await currentUser(event))?.login)
  return scope.all ? runs : runs.filter(r => inScope(scope, r.startedBy))
}

/** True when the caller leads this run's starter: the backstop at a gate. */
export async function leadsStarterOf(event: H3Event, run: WorkflowRun): Promise<boolean> {
  return supervises((await currentUser(event))?.login, run.startedBy)
}
