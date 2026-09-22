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
export type Role = 'product-owner' | 'developer' | 'qa' | 'architect' | 'designer' | 'security' | 'manager' | 'cto' | 'operator'

export const ROLES: Role[] = ['product-owner', 'developer', 'qa', 'architect', 'designer', 'security', 'manager', 'cto', 'operator']

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
  // A product owner owns STORY_GATE and SPEC_GATE: whether the story is ready,
  // and whether the acceptance rows mean the ticket is done. They hold
  // `startRun` because a change request entering the pipeline is their act, and
  // they are withheld `runEngine` for the same reason every reviewer is —
  // deciding is not driving.
  'product-owner': { answerGate: true, runEngine: false, startRun: true, configure: false, readAllRuns: true },
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
  // Security owns SECURITY_GATE, which is threshold-routed rather than tiered:
  // an authz, crypto, personal-data, payment or dependency change reaches them
  // however small its blast radius. Same shape as QA — accept or send back.
  security: { answerGate: true, runEngine: false, startRun: false, configure: false, readAllRuns: true },
  manager: { answerGate: false, runEngine: false, startRun: false, configure: false, readAllRuns: true },
  // A CTO answers only what crosses the escalation threshold, so they hold
  // `answerGate` where `manager` does not. Deliberately without `configure`:
  // the role exists to decide on expensive and irreversible changes, not to
  // own the pipeline's configuration, and an escalation path that also edits
  // the thing it escalates from is not an escalation path.
  cto: { answerGate: true, runEngine: false, startRun: false, configure: false, readAllRuns: true },
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

/**
 * The short label for a role, where a column is too narrow for the word:
 * the VIEW-AS picker, a step's owner chip, a builder node.
 *
 * Here rather than in `app.vue` because three surfaces now render it, and two
 * of them would otherwise invent their own abbreviations \u2014 which is how the
 * same role ends up reading `Mgr` in one place and `Manager` in another.
 */
export const SHORT_ROLE: Record<Role, string> = {
  operator: 'OPS',
  'product-owner': 'PO',
  developer: 'DEV',
  qa: 'QA',
  architect: 'ARCH',
  designer: 'DESIGN',
  security: 'SEC',
  manager: 'MGR',
  cto: 'CTO',
}

/**
 * The role's name as a person would say it, for a control with room for words.
 *
 * Separate from SHORT_ROLE because that one exists for columns too narrow for
 * the word, and separate from ROLE_LABEL because that is a sentence about the
 * job rather than a name for it. A picker needs the name.
 */
export const ROLE_NAME: Record<Role, string> = {
  operator: 'Operator',
  'product-owner': 'Product owner',
  developer: 'Developer',
  qa: 'QA',
  architect: 'Architect',
  designer: 'Designer',
  security: 'Security',
  manager: 'Manager',
  cto: 'CTO',
}

/** The one-line description of each role, for the Team page and the role picker. */
export const ROLE_LABEL: Record<Role, string> = {
  'product-owner': 'Decides whether a story is ready and what "done" means.',
  developer: 'Decides at the diff gate on runs; cannot drive the pipeline.',
  qa: 'Verifies evidence and answers the verification gate.',
  architect: 'Decides at schema, contract and migration gates; cannot drive the pipeline.',
  designer: 'Accepts user-facing output at the design gate.',
  security: 'Decides at the security gate on authz, crypto, data and dependency changes.',
  manager: 'Reads progress across runs. Changes nothing.',
  cto: 'Decides only what crosses the escalation threshold: cost, precedent, reversibility.',
  operator: 'Runs the pipeline: workflows, watches, restarts, settings.',
}
