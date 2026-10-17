// Gate record events (verification.pass and the like): one JSON file per event under the run's
// artifacts and a channel line. Distinct from runEvents.ts, the telemetry stream.

/**
 * Named events a run records: `verification.pass` when QA approves Runbook V's
 * G5 gate, and whatever a workflow's other gated steps declare in `records`.
 *
 * Two outputs, both durable, neither of which fails the run: a file under the
 * run's artifacts (`events/<event>.json`, the thing a later reader or the
 * evidence bundle trusts), and one line on the run's notification channel
 * through the same path every other run message takes (notify.ts), so
 * whoever listens there for transitions hears this too. A posting failure is
 * logged and swallowed: the approval that raised the event has already
 * happened, and un-recording it would tell the person it had not.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runArtifactsDir } from './runArtifacts.ts'
import { runLink, baseUrl, sendToChannelNamed } from './notify.ts'
import { createLogger } from './log.ts'
import type { WorkflowRun } from '~~/shared/types/run'

const log = createLogger('notify')

export interface RunEvent {
  event: string
  runId: string
  ticketKey?: string
  stepId: string
  label: string
  /** GitHub login of whoever approved, or the runner's own name for an automatic one. */
  by: string
  at: number
  note?: string
}

export type EventSink = (event: RunEvent, run: WorkflowRun) => Promise<void>
const sinks: EventSink[] = []
/** Test seam, and the hook another module (an audit log, a webhook) registers on. */
export function onRunEvent(fn: EventSink): () => void {
  sinks.push(fn)
  return () => { const i = sinks.indexOf(fn); if (i >= 0) sinks.splice(i, 1) }
}

/** Events an approval has recorded on this process, so one gate approved twice records once. */
const recorded = new Set<string>()

export async function recordRunEvent(run: WorkflowRun, event: Omit<RunEvent, 'runId' | 'at' | 'ticketKey'> & { at?: number }): Promise<RunEvent | null> {
  const key = `${run.id}:${event.stepId}:${event.event}`
  if (recorded.has(key)) return null
  recorded.add(key)
  const full: RunEvent = { ...event, runId: run.id, ticketKey: run.ticketKey, at: event.at ?? Date.now() }
  try {
    const dir = join(runArtifactsDir(run.id), 'events')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${full.event}.json`), JSON.stringify(full, null, 2))
  } catch (err) {
    log.warn('could not write the run event', { runId: run.id, event: full.event, error: err instanceof Error ? err.message : String(err) })
  }
  const text = `${run.workflowName}: ${full.event}${run.ticketKey ? ` for ${run.ticketKey}` : ''} — "${full.label}" approved by ${full.by}${full.note ? `: ${full.note}` : ''}\n${runLink(run, baseUrl())}`
  for (const name of [run.notifyChannel, 'default']) {
    if (!name) continue
    try { await sendToChannelNamed(name, text); break } catch { /* no such channel, or it failed: the next, then nothing */ }
  }
  for (const fn of sinks) {
    try { await fn(full, run) } catch (err) { log.warn('a run event sink failed', { event: full.event, error: err instanceof Error ? err.message : String(err) }) }
  }
  log.info('run event recorded', { runId: run.id, event: full.event, by: full.by })
  return full
}
