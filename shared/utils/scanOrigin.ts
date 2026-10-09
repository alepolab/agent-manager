/**
 * Which scan a ticket came from, so a gate in the inbox can say "From
 * Performance scan" instead of leaving the reader to guess why the ticket
 * exists. Pure: the index is built from disk in server/utils/scanOrigins.ts.
 */

/** A scan run, as much of it as a label needs. */
export interface ScanRunInfo { id: string, workflowName: string, startedAt: number }

/** Where a ticket came from: the scan run that filed it. */
export interface ScanOrigin { runId: string, label: string, at: number }

/** The scan workflows: `scan-functional-to-dispatch` and its siblings. */
export function isScanWorkflow(slug: string | undefined): boolean {
  return !!slug && slug.startsWith('scan-')
}

/** "Scan Performance — Findings to Dispatch" reads as "Performance scan". */
export function scanLabel(workflowName: string): string {
  const head = (workflowName.split(' — ')[0] ?? workflowName).trim()
  const kind = head.replace(/^scan\s+/i, '').trim()
  return kind && kind !== head ? `${kind} scan` : head
}

const TRIGGER = 'workflow-trigger:'

/**
 * The scan behind `run`: the scan that dispatched it, else the scan that filed
 * its ticket. A run started by hand for a scan-filed ticket carries no trigger,
 * so the ticket key is the only way back to its scan.
 */
export function scanOriginOf(
  run: { watch?: string, ticketKey?: string },
  scans: ReadonlyMap<string, ScanRunInfo>,
  filedBy: ReadonlyMap<string, string>,
): ScanOrigin | undefined {
  const parent = run.watch?.startsWith(TRIGGER) ? scans.get(run.watch.slice(TRIGGER.length)) : undefined
  const scan = parent ?? (run.ticketKey ? scans.get(filedBy.get(run.ticketKey) ?? '') : undefined)
  return scan ? { runId: scan.id, label: scanLabel(scan.workflowName), at: scan.startedAt } : undefined
}
