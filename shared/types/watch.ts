export type TicketDisposition =
  | 'new'         // seen, not yet dispatched
  | 'dispatched'  // a run is in flight for it
  | 'done'        // its run completed
  | 'failed'      // its run failed, attempts remain
  | 'escalated'   // attempts exhausted — never picked up again

export interface TicketRef {
  key: string
  summary: string
  description: string
  updatedAt: number
}

export interface TicketState {
  key: string
  watchId: string
  disposition: TicketDisposition
  attempts: number
  lastRunId?: string
  lastError?: string
  firstSeenAt: number
  updatedAt: number
}

export interface Watch {
  id: string
  /** Human label for the operator view. */
  name: string
  /** Which workflow to run for a ticket this watch picks up. */
  workflowSlug: string
  intervalSeconds: number
  /** New watches start disabled: a mistyped query must not dispatch on tick one. */
  enabled: boolean
  maxConcurrentRuns: number
  dailyDispatchCap: number
  /** Opaque to the scheduler; the source interprets it. */
  query?: string
  projectDir?: string
  autoRun: boolean
  /** Runs this watch dispatches are attributed to, and use the identity of, this developer. */
  createdBy?: string
}
