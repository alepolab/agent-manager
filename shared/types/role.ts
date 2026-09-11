/**
 * Who a person is on this instance, and therefore what they see.
 *
 * Four roles, one verb each. The split is the CEO review's P3 turned on this
 * app itself: an operator configures the pipeline, everyone else operates
 * inside it, and a console that shows an actor controls they must not use is
 * describing the system rather than their job.
 *
 * `operator` is the floor for anyone not listed in `roles.json`, so adding
 * roles to a running instance changes nothing until a person is named. The
 * alternative — unlisted means least privilege — silently demotes colleagues
 * the moment the file appears, and this instance is shared.
 */
export type Role = 'developer' | 'qa' | 'manager' | 'operator'

export const ROLES: Role[] = ['developer', 'qa', 'manager', 'operator']

export const DEFAULT_ROLE: Role = 'operator'

/**
 * What a role may do. Named by the act, not by the route: `runEngine` is
 * "change a run's course" — stop it, restart a step, clone it, steer a
 * mid-flight agent — and `answerGate` is "decide at a gate the run is waiting
 * on". A reviewer holds the second and not the first, which is the whole
 * point: their job is to say yes or no, not to drive the pipeline.
 */
export interface Capabilities {
  /** Approve or send back at a gate. */
  answerGate: boolean
  /** Stop, restart a step, clone, or steer a running agent. */
  runEngine: boolean
  /** Start a run. */
  startRun: boolean
  /** Edit workflows, watches, agents, skills, commands, settings, team config. */
  configure: boolean
  /** Read every run, not only the ones addressed to them. */
  readAllRuns: boolean
}

const CAPABILITIES: Record<Role, Capabilities> = {
  developer: { answerGate: true, runEngine: false, startRun: true, configure: false, readAllRuns: true },
  qa: { answerGate: true, runEngine: false, startRun: false, configure: false, readAllRuns: true },
  manager: { answerGate: false, runEngine: false, startRun: false, configure: false, readAllRuns: true },
  operator: { answerGate: true, runEngine: true, startRun: true, configure: true, readAllRuns: true },
}

export function capabilitiesFor(role: Role): Capabilities {
  return CAPABILITIES[role] ?? CAPABILITIES[DEFAULT_ROLE]
}

export function can(role: Role, capability: keyof Capabilities): boolean {
  return capabilitiesFor(role)[capability]
}

/** The roles that hold a capability, so a refusal can name who to ask. */
export function rolesWith(capability: keyof Capabilities): Role[] {
  return ROLES.filter(r => capabilitiesFor(r)[capability])
}

/** The one-line description of each role, for the Team page and the role picker. */
export const ROLE_LABEL: Record<Role, string> = {
  developer: 'Decides at the diff gate on runs; cannot drive the pipeline.',
  qa: 'Verifies evidence and answers the verification gate.',
  manager: 'Reads progress across runs. Changes nothing.',
  operator: 'Runs the pipeline: workflows, watches, restarts, settings.',
}
