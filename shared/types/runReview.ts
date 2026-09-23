/**
 * A decision an operator makes about the entries of one run artifact, and the
 * record of having made it.
 *
 * The unit is an ENTRY rather than a step because that is what the person is
 * actually deciding. A scan's Decision Gate escalates three drafts; approving
 * the step that consumes them approves all three, and the step downstream
 * starts one pipeline per entry. "Which of these three?" has no expression in
 * the run record at all without this, which is why the only way to answer it
 * used to be a slash command editing files behind the app's back.
 *
 * Entries are addressed by their INDEX in the artifact's array, never by a
 * field of their own. `draft_id` is optional in the drafter's output and is not
 * one of workflowGraph's ENTRY_KEY_FIELDS, so a decision keyed by it could not
 * be matched back to an entry that omitted it - and silently applying the wrong
 * decision to the wrong draft is the one failure this must not have.
 */

/** What the operator decided about one entry. There is no 'modified': a
 *  modified draft is an approved one whose text the operator changed, and
 *  recording it as a third state would leave "was a ticket created?"
 *  ambiguous. The edits are kept alongside, so the change is still visible. */
export type DraftDecision = 'approved' | 'skipped'

/** The fields an operator may change before approving. Deliberately narrow:
 *  these three are what a reviewer actually corrects. Project and issue type
 *  are not here - a draft filed against the wrong project is a drafting bug to
 *  send back, not something to fix by hand at the gate. */
export interface ReviewEdits {
  summary?: string
  description?: string
  priority?: string
}

/**
 * One entry of the artifact under review, flattened for the panel.
 *
 * The agents write snake_case; this is the camelCase view of it. `entry` keeps
 * the whole original so the panel can show the raw draft without a second
 * fetch, and so a field no reviewer has needed yet is not lost in translation.
 */
export interface ReviewItem {
  index: number
  /** Display name, from the same fields dispatch will name the entry by. */
  key: string
  /** The self-contained question the decision gate wrote. Absent on an entry
   *  from some other producer, in which case the panel shows the draft. */
  decisionPrompt?: string
  escalationCriteria?: string[]
  reason?: string
  summary?: string
  description?: string
  fields?: Record<string, unknown>
  acceptanceCriteria?: string[]
  entry: Record<string, unknown>
}

/** Everything the run page needs to render the gate. */
export interface ReviewQueue {
  artifact: string
  stepId: string
  stepLabel: string
  items: ReviewItem[]
}

/** One submitted decision. */
export interface ReviewDecision {
  index: number
  decision: DraftDecision
  edits?: ReviewEdits
}

/** What became of one entry, for the audit record. */
export interface ReviewOutcome {
  index: number
  key: string
  decision: DraftDecision
  edits?: ReviewEdits
  /** The issue this entry became, when one was created. */
  jiraKey?: string
  /** Why no issue was created for an approved entry. */
  error?: string
}

/**
 * The audit record, written beside the artifact it decided.
 *
 * It holds EVERY entry, including the skipped ones, because the artifact
 * itself is rewritten down to the approved entries and would otherwise be the
 * only surviving evidence - leaving no answer to "what else was escalated, and
 * who decided not to act on it?".
 */
export interface ReviewRecord {
  artifact: string
  reviewedBy?: string
  reviewedAt: number
  items: ReviewOutcome[]
}

export const REVIEW_DECISIONS_FILE = 'review-decisions.json'
export const TICKETS_CREATED_FILE = 'tickets-created.json'
