/**
 * Starts the watch scheduler with the server.
 *
 * T3 built `watchScheduler.ts` against two seams — `setWatchSource` (which
 * watches to poll) and `setRunStarter` (how to turn a ticket into a run) —
 * because neither `watchConfig.ts` (this task) nor a real dispatch path
 * existed yet. This plugin is where both get wired to the real thing and
 * the scheduler is actually started.
 *
 * Guard: skipped entirely when `WATCHER_DISABLED=1`. Every `scripts/test-*.mjs`
 * script imports `server/utils/*.ts` modules directly and never loads
 * `server/plugins/*.ts` — Nitro is the only thing that does that, on real
 * server boot — so in isolation this guard is unreachable-in-tests by
 * construction. It exists for the case that matters in practice: running
 * the real server (dev, CI smoke boot, or a future test that boots Nitro
 * itself) without wanting a live setInterval poll loop and its outbound
 * dispatch calls. See task-4-report.md for how this was verified against a
 * live timer, not just read from source.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolveClaudePath } from '../utils/claudeDir.ts'
import { listWatches } from '../utils/watchConfig.ts'
import { setWatchSource, setRunStarter, startScheduler } from '../utils/watchScheduler.ts'
import { findActiveRun } from '../utils/workflowRunStore.ts'
import { startRun } from '../utils/workflowRunner.ts'
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
 * Turns one ticket into a workflow run. Two outcomes are NOT a failed
 * attempt and must not throw:
 *   - the workflow already has a run in flight (the API route's own 409
 *     case) — the design's error-handling section calls this "already in
 *     flight, not a failure"; returning the existing run id lets the
 *     ticket's dispatch resolve as `dispatched` against that run so
 *     `reconcile` can settle it normally once it finishes.
 *   - the run genuinely starts — returns its id the same way.
 * Anything else (missing workflow, no steps) throws, which `runCycle`
 * already isolates per-ticket.
 */
async function realRunStarter(watch: Watch, ticket: TicketRef): Promise<{ runId: string }> {
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
    autoRun: watch.autoRun,
    projectDir: watch.projectDir,
  })
  return { runId: run.id }
}

export default defineNitroPlugin(() => {
  if (process.env.WATCHER_DISABLED === '1') return

  setWatchSource(listWatches)
  setRunStarter(realRunStarter)
  startScheduler()
})
