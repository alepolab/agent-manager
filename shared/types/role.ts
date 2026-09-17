/**
 * Who a person is on this instance, and therefore what they see.
 *
 * Six roles, one verb each. The split is the CEO review's P3 turned on this
 * app itself: an operator configures the pipeline, everyone else operates
 * inside it, and a console that shows an actor controls they must not use is
 * describing the system rather than their job.
 *
 * `architect` and `designer` carry the same capability rows as `developer` and
 * `qa`, which is the shape peer reviewers are supposed to have: what separates
 * them is not which acts they may perform but which gates carry their name,
 * and that lives in `WorkflowStep.gateRole`, enforced by `requireGateRole`.
 * Duplicating gate ownership into this table as a `decideArchitecture` /
 * `acceptDesign` capability would mean keeping two sources of the same truth in
 * step, and a drift between them produces a 403 that names the wrong owner.
 *
 * A role earns a row here only when some workflow declares a gate that is that
 * role's alone. A role whose removal would change no refusal anywhere is not a
 * role; it is a navigation entry.
 *
 * `operator` is the floor for anyone not listed in `roles.json`, so adding
 * roles to a running instance changes nothing until a person is named. The
 * alternative — unlisted means least privilege — silently demotes colleagues
 * the moment the file appears, and this instance is shared.
 */
export type Role = 'developer' | 'qa' | 'architect' | 'designer' | 'manager' | 'operator'

export const ROLES: Role[] = ['developer', 'qa', 'architect', 'designer', 'manager', 'operator']

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
  // An architect starts spikes and contract-first work, so they hold `startRun`
  // like a developer. `configure` is withheld on purpose: it covers workflows,
  // agents, settings AND `roles.json`, so handing it over is promotion to
  // operator under another name, and two owners of the pipeline is none.
  architect: { answerGate: true, runEngine: false, startRun: true, configure: false, readAllRuns: true },
  // A designer accepts what a run produced; they do not own a scope that
  // generates runs. Exactly QA's position, and the friction is the point.
  designer: { answerGate: true, runEngine: false, startRun: false, configure: false, readAllRuns: true },
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
  architect: 'Decides at schema, contract and migration gates; cannot drive the pipeline.',
  designer: 'Accepts user-facing output at the design gate.',
  manager: 'Reads progress across runs. Changes nothing.',
  operator: 'Runs the pipeline: workflows, watches, restarts, settings.',
}
