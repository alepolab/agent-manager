/**
 * The real `RunStarter` for `watchScheduler.ts`'s dispatch seam — turns one
 * ticket into a workflow run.
 *
 * Lives in `server/utils/` rather than `server/plugins/watcher.ts` (where it
 * used to live) so it can be imported directly by `scripts/test-*.mjs`, the
 * same way every other watcher module already is. `server/plugins/*.ts`
 * pulls in Nitro's `defineNitroPlugin` global and can only be loaded by
 * Nitro itself on real server boot (see that file's own docstring on why
 * its test scripts never import `server/plugins/*.ts`) — nothing in this
 * file needs that, so it does not live there. `server/plugins/watcher.ts`
 * now just imports `realRunStarter` from here and wires it via
 * `setRunStarter`.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolveClaudePath } from './claudeDir.ts'
import { findActiveRun } from './workflowRunStore.ts'
import { startRun } from './workflowRunner.ts'
import type { Watch, TicketRef } from '../../shared/types/watch.ts'

interface WorkflowFile {
  slug: string
  name: string
  steps: { id: string, agentSlug: string, label: string, next?: string[], monitorSlug?: string, maxVisits?: number }[]
}

/** Reads a workflow definition straight off disk — the same file
 *  `GET /api/workflows/[slug]` reads — rather than looping the dispatch
 *  path back through HTTP for something the server process can just read. */
async function loadWorkflow(slug: string): Promise<WorkflowFile | null> {
  const path = resolveClaudePath('workflows', `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(await readFile(path, 'utf-8'))
    return { slug, ...data } as WorkflowFile
  } catch {
    return null
  }
}

function promptFor(ticket: TicketRef): string {
  return `${ticket.key}: ${ticket.summary}\n\n${ticket.description}`
}

/**
 * The one place a ticket is judged genuinely undispatchable, before it is
 * ever handed to `startRun`. Deliberately narrow — validate what makes a
 * ticket undispatchable, not stylistic preferences about its content:
 *
 *   - no key: `watchStateStore.ts` indexes every attempt/dispatch/failure by
 *     `ticket.key`. A keyless ticket cannot be tracked, deduped, or
 *     escalated — it is not "a ticket with a rough edge", it is nothing the
 *     per-ticket isolation this watcher exists for can act on.
 *   - nothing for the run prompt: `promptFor` (below) IS the run's entire
 *     input. A ticket with a key but no summary AND no description would
 *     dispatch a run with nothing for the agent to act on — a `startRun`
 *     that "succeeds" but is silently useless.
 *
 * A ticket missing only one of summary/description is NOT rejected — there
 * is still something to put in the prompt, so that is a gap in the source
 * ticket's quality, not a reason this watcher can refuse to dispatch it.
 *
 * Returns a human-readable reason (recorded verbatim as `lastError` by
 * `watchStateStore.recordFailure`, via `runCycle`'s existing catch block) or
 * `null` when the ticket is fine to dispatch.
 */
export function validateTicket(ticket: TicketRef): string | null {
  if (!ticket.key?.trim()) {
    return 'ticket has no key — nothing to dispatch or track state against'
  }
  if (!ticket.summary?.trim() && !ticket.description?.trim()) {
    return `ticket '${ticket.key}' has no summary or description — nothing to put in the run prompt`
  }
  return null
}

/**
 * Turns one ticket into a workflow run. Two outcomes are NOT a failed
 * attempt and must not throw:
 *   - the workflow already has a run in flight (the API route's own 409
 *     case) — the design's error-handling section calls this "already in
 *     flight, not a failure"; returning the existing run id lets the
 *     ticket's dispatch resolve as `dispatched` against that run so
 *     `reconcile` can settle it normally once it finishes.
 *   - the run genuinely starts — returns its id the same way.
 * Anything else — an undispatchable ticket (`validateTicket`), a missing
 * workflow, no steps — throws, which `runCycle` (watchScheduler.ts) already
 * isolates per-ticket: one ticket's throw costs only that ticket, never the
 * rest of the cycle.
 */
export async function realRunStarter(watch: Watch, ticket: TicketRef): Promise<{ runId: string }> {
  const invalidReason = validateTicket(ticket)
  if (invalidReason) {
    throw new Error(invalidReason)
  }

  const active = await findActiveRun(watch.workflowSlug)
  if (active) return { runId: active.id }

  const workflow = await loadWorkflow(watch.workflowSlug)
  if (!workflow) {
    throw new Error(`workflow '${watch.workflowSlug}' not found`)
  }
  if (!workflow.steps?.length) {
    throw new Error(`workflow '${watch.workflowSlug}' has no steps`)
  }

  const run = await startRun({
    workflow: { slug: workflow.slug, name: workflow.name, steps: workflow.steps },
    initialPrompt: promptFor(ticket),
    // The runner's own fact for "what triggered this" — the watch that
    // dispatched it, never left to the agent to self-report.
    watch: watch.id,
    autoRun: watch.autoRun,
    projectDir: watch.projectDir,
  })
  return { runId: run.id }
}
