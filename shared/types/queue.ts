/**
 * A queue of work that outlives the runs that execute it.
 *
 * A run is expensive: it holds a checkout, spends a budget and occupies one of
 * the instance's concurrency slots. So a project of forty tasks cannot BE forty
 * runs — the workspace lock allows one run per checkout and the capacity cap
 * allows N per instance, which between them mean a dozen tasks against one
 * repository can never exist as a dozen live runs.
 *
 * A queue task is the cheap half: a record of work that is going to happen,
 * with its order, its dependencies and the module it touches. Every task in a
 * project exists and is listed from the moment the project is created; runs are
 * minted from them one at a time as slots free. That is the difference between
 * "what are we doing" and "what is executing right now", and conflating the two
 * is why the whole project could not be seen before it was started.
 */

export type QueueTaskStatus =
  /** Waiting: either for its dependencies, or for a slot. */
  | 'pending'
  /** A run exists and is live. `runId` points at it. */
  | 'running'
  /** Its run finished successfully. */
  | 'done'
  /** Its run failed, was stopped, or died. `note` says which. */
  | 'failed'
  /** Deliberately not executed — human work, or cancelled. Never dispatched. */
  | 'skipped'

export interface QueueTask {
  /** Stable and human-chosen (`F1.1`), not generated: it is how a person refers to the work. */
  id: string
  title: string
  /** The prompt body a run is started from. Absent for a task nobody will dispatch. */
  detail?: string
  /** Position in the pull order. Lower goes first among eligible tasks. */
  order: number
  status: QueueTaskStatus
  /** Task ids that must reach `done` before this one may start. */
  deps: string[]
  /** Which workflow executes it. */
  workflowSlug: string
  /** The checkout it edits. Two tasks sharing one are serialised by the workspace lock. */
  projectDir?: string
  /** For display and for grouping; the repository name behind projectDir. */
  module?: string
  ticketKey?: string
  /** The run minted for it, once one exists. */
  runId?: string
  /** Why it is skipped, or how its run ended. Always present when not pending or running. */
  note?: string
  queuedAt: number
  startedAt?: number
  endedAt?: number
}

export interface TaskQueue {
  /** The project these tasks belong to, so two projects can share an instance. */
  project: string
  tasks: QueueTask[]
  createdAt: number
  updatedAt: number
}

/** What a dispatch attempt did, in words a page can show without interpreting. */
export interface DispatchResult {
  started: string[]
  /** Task id → why it was not started this time. Never an exception. */
  held: Record<string, string>
}
