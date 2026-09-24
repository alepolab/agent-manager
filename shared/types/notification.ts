import type { Role } from './role'

/** A tool-permission prompt from /cli still waiting on a person. */
export interface PendingPermissionSummary {
  id: string
  sessionId: string
  toolName: string
  toolInput: unknown
  workingDir: string
  /** The chat's project under ~/.claude/projects, for a link back to /cli. Absent until the SDK has written the session. */
  projectName?: string
  /** The message that started the turn that raised the prompt. */
  prompt?: string
  askedAt: number
  /** When it denies itself unanswered. */
  expiresAt: number
}

/**
 * One decision a person owes, as /notifications lists it.
 *
 * `mine` is a courtesy, not an authority: the routes that take the decision
 * refuse a person who may not take it, whatever this says.
 */
export type NotificationItem =
  | {
    kind: 'gate'
    /** `run:<runId>` — stable across polls, so the selection survives a refresh. */
    id: string
    runId: string
    /** The ticket key, else the first line of the run's prompt. */
    title: string
    workflowName: string
    /** What is being asked, in one line. */
    ask: string
    askedAt: number
    role?: Role
    mine: boolean
    blastRadius?: string
    /** Entry-by-entry review of an artifact (`awaiting_review`), not a single yes or no. */
    review: boolean
  }
  | {
    kind: 'permission'
    /** `permission:<permissionId>` */
    id: string
    title: string
    ask: string
    askedAt: number
    mine: boolean
    permission: PendingPermissionSummary
  }
