/**
 * The index behind "From Performance scan" in the inbox: which scan run filed
 * which ticket, read from each scan run's tickets-created.json.
 *
 * The inbox is polled, so each file is read once and kept until its mtime
 * changes; a poll costs one stat per scan run, never a Jira call.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkflowRun } from '../../shared/types/run.ts'
import { isScanWorkflow, type ScanRunInfo } from '../../shared/utils/scanOrigin.ts'
import { runArtifactsDir } from './runArtifacts.ts'

const filed = new Map<string, { mtimeMs: number, keys: string[] }>()

async function ticketsFiledBy(runId: string): Promise<string[]> {
  const path = join(runArtifactsDir(runId), 'tickets-created.json')
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    filed.delete(runId)
    return []
  }
  const hit = filed.get(runId)
  if (hit && hit.mtimeMs === mtimeMs) return hit.keys
  let keys: string[] = []
  try {
    const entries = JSON.parse(await readFile(path, 'utf-8'))
    if (Array.isArray(entries)) {
      keys = entries.map(e => e?.jira_key).filter((k): k is string => typeof k === 'string' && !!k)
    }
  } catch { /* half-written or not JSON: nothing filed yet */ }
  filed.set(runId, { mtimeMs, keys })
  return keys
}

export interface ScanOriginIndex {
  scans: Map<string, ScanRunInfo>
  /** Ticket key to the scan run that filed it; the most recent scan wins. */
  filedBy: Map<string, string>
}

export async function scanOriginIndex(runs: WorkflowRun[]): Promise<ScanOriginIndex> {
  const scanRuns = runs.filter(r => isScanWorkflow(r.workflowSlug)).sort((a, b) => a.startedAt - b.startedAt)
  const scans = new Map<string, ScanRunInfo>(scanRuns.map(r => [r.id, { id: r.id, workflowName: r.workflowName, startedAt: r.startedAt }]))
  const filedBy = new Map<string, string>()
  const lists = await Promise.all(scanRuns.map(r => ticketsFiledBy(r.id)))
  scanRuns.forEach((r, i) => { for (const key of lists[i]!) filedBy.set(key, r.id) })
  return { scans, filedBy }
}

/** For tests. */
export function _resetScanOrigins() { filed.clear() }
