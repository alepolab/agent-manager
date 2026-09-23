/**
 * Reading the entries a run is gated on, and recording what a person decided
 * about them.
 *
 * Here rather than in the two route files because this is the whole feature and
 * a route is a thin place: the validation rules, the order the writes happen
 * in, and what "approved nothing" means to the run are all load-bearing, and
 * none of them are testable through a Nitro handler under plain node.
 *
 * The decision takes effect by REWRITING THE ARTIFACT down to the approved
 * entries. Every step that acts on those drafts - the one that files the
 * tickets and the one that dispatches a pipeline per entry - reads that same
 * file, so filtering it is what makes "two of these three" bind on all of them
 * at once, with no workflow definition changed and no per-step notion of
 * approval invented.
 */

import { readArtifactEntries, writeArtifactJson } from './runArtifacts.ts'
import { createIssuesFrom, recordCreatedTickets } from './jiraCreate.ts'
import { entryKey } from '../../shared/utils/workflowGraph.ts'
import { REVIEW_DECISIONS_FILE } from '../../shared/types/runReview.ts'
import type { ReviewDecision, ReviewItem, ReviewOutcome, ReviewQueue, ReviewRecord } from '../../shared/types/runReview.ts'
import type { FetchLike } from './jiraTicketSource.ts'
import type { WorkflowRun } from '../../shared/types/run'

/** Carries the status the route should answer with, the way RestartError does,
 *  so the rules live with the logic instead of being re-derived per route. */
export class ReviewError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
    this.name = 'ReviewError'
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : undefined

const objOf = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : undefined

/**
 * The artifact a run is gated on, and its entries.
 *
 * A gate raised over a file that has since become unreadable is an error, never
 * an empty list: answering "nothing to decide" would let the operator continue
 * past drafts nobody ever saw, which is the silent nothing this whole gate
 * exists to prevent.
 */
async function gatedEntries(run: WorkflowRun): Promise<{ artifact: string, entries: Record<string, unknown>[] }> {
  if (run.status !== 'awaiting_review' || !run.question?.artifact) {
    throw new ReviewError(409, `This run is ${run.status}; it is not waiting on a decision`)
  }
  const artifact = run.question.artifact
  const read = await readArtifactEntries(run.id, artifact)
  if (read === null) throw new ReviewError(409, `${artifact} was not written, so there is nothing to decide`)
  if ('error' in read) throw new ReviewError(409, read.error)
  return { artifact, entries: read.entries }
}

/** What the run page renders: one reviewable item per entry. */
export async function loadReviewQueue(run: WorkflowRun): Promise<ReviewQueue> {
  const { artifact, entries } = await gatedEntries(run)
  const items: ReviewItem[] = entries.map((entry, index) => {
    const gate = objOf(entry.gate) ?? {}
    return {
      index,
      key: entryKey(entry, index),
      decisionPrompt: str(gate.decision_prompt),
      escalationCriteria: strs(gate.escalation_criteria),
      reason: str(gate.reason),
      summary: str(entry.summary),
      description: str(entry.description),
      fields: objOf(entry.fields),
      acceptanceCriteria: strs(entry.acceptance_criteria),
      entry,
    }
  })
  return {
    artifact,
    stepId: run.question!.stepId,
    stepLabel: run.steps.find(s => s.stepId === run.question?.stepId)?.label ?? run.question!.stepId,
    items,
  }
}

/**
 * Every entry must be decided exactly once.
 *
 * A partial submission is refused rather than read as "skip the rest": an entry
 * nobody ruled on is an entry nobody saw, and quietly dropping it is the
 * failure the gate exists to prevent. An index that names no entry is refused
 * for a different reason - it means the client is deciding about a different
 * file than the one on disk.
 */
function validate(submitted: ReviewDecision[], entries: Record<string, unknown>[], artifact: string): void {
  if (!Array.isArray(submitted) || !submitted.length) throw new ReviewError(400, 'decisions is required')
  const seen = new Set<number>()
  for (const d of submitted) {
    if (!Number.isInteger(d?.index) || d.index < 0 || d.index >= entries.length) {
      throw new ReviewError(400, `decision ${JSON.stringify(d?.index)} names no entry of ${artifact}, which holds ${entries.length}`)
    }
    if (d.decision !== 'approved' && d.decision !== 'skipped') {
      throw new ReviewError(400, `entry ${d.index + 1} has decision ${JSON.stringify(d.decision)}; it must be "approved" or "skipped"`)
    }
    if (seen.has(d.index)) throw new ReviewError(400, `entry ${d.index + 1} was decided twice`)
    seen.add(d.index)
  }
  if (seen.size !== entries.length) {
    const undecided = entries.map((_, i) => i).filter(i => !seen.has(i)).map(i => i + 1)
    throw new ReviewError(400, `every entry must be decided; ${undecided.join(', ')} ${undecided.length === 1 ? 'was' : 'were'} not`)
  }
}

export interface ReviewResult {
  artifact: string
  approved: number
  skipped: number
  created: string[]
  lines: string[]
}

/**
 * Applies the decisions: edits, then tickets, then the audit record, then the
 * filtered artifact.
 *
 * That order is deliberate. The audit is written BEFORE the artifact is
 * filtered, so if anything below it fails, the record of what was escalated and
 * what was decided already exists on disk - the filtered file is the only other
 * surviving evidence, and it holds the approved entries alone.
 *
 * Does NOT resume the run. The caller does that, because whether the step's
 * approval is granted depends on `approved` being non-zero and that is a
 * decision about the runner, not about these files.
 */
export async function applyReviewDecisions(
  run: WorkflowRun,
  submitted: ReviewDecision[],
  reviewedBy?: string,
  fetchImpl?: FetchLike,
): Promise<ReviewResult> {
  const { artifact, entries } = await gatedEntries(run)
  validate(submitted, entries, artifact)

  const byIndex = new Map(submitted.map(d => [d.index, d]))
  const approved: { index: number, entry: Record<string, unknown> }[] = []
  for (const d of submitted) {
    if (d.decision !== 'approved') continue
    const entry = entries[d.index]!
    // Applied before creation, so the ticket that gets filed is the text the
    // operator actually approved rather than the draft they corrected.
    if (typeof d.edits?.summary === 'string' && d.edits.summary.trim()) entry.summary = d.edits.summary.trim()
    if (typeof d.edits?.description === 'string' && d.edits.description.trim()) entry.description = d.edits.description
    if (typeof d.edits?.priority === 'string' && d.edits.priority.trim()) {
      const fields = objOf(entry.fields) ?? {}
      fields.priority = d.edits.priority.trim()
      entry.fields = fields
    }
    approved.push({ index: d.index, entry })
  }

  const created = fetchImpl
    ? await createIssuesFrom(run, approved, fetchImpl)
    : await createIssuesFrom(run, approved)
  await recordCreatedTickets(run.id, created)
  const createdByIndex = new Map(created.map(o => [o.index, o]))

  const outcomes: ReviewOutcome[] = entries.map((entry, index) => {
    const d = byIndex.get(index)!
    const made = createdByIndex.get(index)
    return {
      index,
      key: entryKey(entry, index),
      decision: d.decision,
      ...(d.edits ? { edits: d.edits } : {}),
      ...(made?.jiraKey ? { jiraKey: made.jiraKey } : {}),
      ...(made?.error ? { error: made.error } : {}),
    }
  })
  const record: ReviewRecord = {
    artifact,
    ...(reviewedBy ? { reviewedBy } : {}),
    reviewedAt: Date.now(),
    items: outcomes,
  }
  await writeArtifactJson(run.id, REVIEW_DECISIONS_FILE, record)
  await writeArtifactJson(run.id, artifact, approved.map(a => a.entry))

  return {
    artifact,
    approved: approved.length,
    skipped: entries.length - approved.length,
    created: created.filter(o => o.jiraKey).map(o => o.jiraKey!),
    lines: created.map(o => o.line),
  }
}
