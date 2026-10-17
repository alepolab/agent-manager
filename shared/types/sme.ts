/**
 * Subject-matter-expert routing: who a gate is handed to, and the record of
 * that hand-over on the run.
 *
 * Roles (shared/types/role.ts) say which KIND of person may answer a gate.
 * This says which PERSON is asked first. The two stay separate on purpose: a
 * role is an authorisation, an assignment is a courtesy. The routes that take a
 * decision still enforce the role; the assignee is who the Home "needs you" list
 * and the notifications name, and who the SLA clock runs against.
 *
 * Pure types only - imported by the Vue pages, the server and the plain-node
 * tests, so nothing here may touch the filesystem.
 */

/** What a gate is for, as far as routing cares. */
export type GateKind = 'review' | 'plan' | 'qa' | 'verification' | 'other'

/** The directory entry for one product, read from the registry's `owners`. */
export interface ProductOwners {
  /** GitHub logins asked in turn for review and plan gates. */
  product_sme?: string[]
  /** The architect, asked when a tier calls for a specialist and none is named. */
  architect?: string
  /** Asked for QA and verification gates. */
  qa_lead?: string
}

/**
 * One person covering for another, for one product or all of them, between
 * two dates. Kept in `<CLAUDE_DIR>/sme-delegations.json` as a plain array.
 */
export interface SmeDelegation {
  /** GitHub login of the person who is away. */
  from: string
  /** GitHub login of the person who answers in their place. */
  to: string
  /** Registry product key; absent means every product. */
  product?: string
  /** ISO date or timestamp from which the delegation applies (inclusive). */
  fromDate: string
  /** ISO date or timestamp after which it no longer applies (inclusive). */
  until: string
}

/** The record left on a run when a gate is routed to a person. */
export interface SmeAssignment {
  /** The gated step's id. */
  gate: string
  /** GitHub login of the person asked. */
  assignee: string
  assignedAt: number
  /** When the gate is overdue: assignedAt + the SLA (4h; business hours ignored for now). */
  dueAt: number
  /** The person this was delegated away from, when a delegation chose `assignee`. */
  delegatedFrom?: string
  /** How the assignee was chosen, for the gate text and for a reader of the record. */
  via: 'product_sme' | 'specialist' | 'qa_lead' | 'operator' | 'architect'
  /** A due-time notification has been sent; set once so a tick never repeats it. */
  notifiedDueAt?: number
  /** The escalation to the pod lead has been sent; set once. */
  escalatedAt?: number
  /** The pod lead the escalation went to. */
  escalatedTo?: string
}

/** The SLA, in milliseconds: four hours, wall clock. */
export const SME_SLA_MS = 4 * 60 * 60 * 1000

/** How long after assignment an unanswered gate escalates to the pod lead. */
export const SME_ESCALATION_MS = 24 * 60 * 60 * 1000

/** Open gates one person may hold before routing moves on to the next. */
export const DEFAULT_SME_WIP_CAP = 4
