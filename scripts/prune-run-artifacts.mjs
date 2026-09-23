/**
 * Report — and, with `--write`, remove — the disposable files inside run
 * artifact directories: `.bak` (an agent's own backup-before-edit of
 * meta.json — two real runs on this instance have one beside a live
 * meta.json, meaning something rewrote it after the run finished), `*.tmp`
 * (an interrupted write), and anything matching `*superseded*` (a step's own
 * marker for an artifact a retry replaced). Nothing else is ever a pruning
 * candidate — a review of 13 real runs found 1,218 files / 46.9 MB with 556
 * of 584 distinct names appearing in exactly one run, so a broader pattern
 * risks deleting the one copy of something a reviewer needs.
 *
 *   node scripts/prune-run-artifacts.mjs                        # report only
 *   node scripts/prune-run-artifacts.mjs --write                # delete the three classes above
 *   node scripts/prune-run-artifacts.mjs --older-than-days 30   # list (never deletes) runs past retention
 *
 * Follows recover-run-records.mjs / rebuild-run-index.mjs: report by
 * default, reuse the runner's own helpers rather than re-measuring by hand,
 * and never act on `--older-than-days` — retention is a decision for a
 * person, this only supplies the list they'd decide from.
 */
import { readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const write = args.includes('--write')
const olderThanIdx = args.indexOf('--older-than-days')
const olderThanDays = olderThanIdx !== -1 ? Number(args[olderThanIdx + 1]) : undefined

const { agentRunsRoot, runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { readRunIndex } = await import('../server/utils/runIndex.ts')

/** The only three classes this script ever touches — see the header comment
 *  for why nothing broader is in scope. */
const PRUNABLE = [/\.bak$/i, /\.tmp$/i, /superseded/i]
const isPrunable = name => PRUNABLE.some(p => p.test(name))

async function walk(dir) {
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(full))
    else if (entry.isFile() && isPrunable(entry.name)) files.push(full)
  }
  return files
}

const root = agentRunsRoot()
let runIds
try {
  runIds = await readdir(root)
} catch {
  console.log(`no artifacts directory at ${root}`)
  process.exit(0)
}

let totalBytes = 0
let totalCount = 0
for (const runId of runIds) {
  const dir = runArtifactsDir(runId)
  const files = await walk(dir)
  if (!files.length) continue
  let runBytes = 0
  const sized = []
  for (const file of files) {
    let bytes = 0
    try { bytes = (await stat(file)).size } catch { continue }
    runBytes += bytes
    sized.push({ file, bytes })
  }
  console.log(`${runId}  ${sized.length} file(s)  ${runBytes} bytes${write ? '' : ' (report only)'}`)
  for (const { file, bytes } of sized) console.log(`  ${write ? 'removed' : 'would remove'}  ${bytes.toString().padStart(8)}  ${file}`)
  // Reported before any removal, on every invocation — even with --write —
  // so a run interrupted mid-delete still leaves a printed record of what it
  // intended, matching the report-then-act order the task description asks for.
  if (write) for (const { file } of sized) await rm(file, { force: true })
  totalBytes += runBytes
  totalCount += sized.length
}
console.log(`\n${totalCount} file(s), ${totalBytes} bytes ${write ? 'removed' : 'would be removed'} across ${runIds.length} run(s) checked.`)
if (!write && totalCount) console.log('Re-run with --write to delete them.')

if (olderThanDays !== undefined) {
  // Age is read from the run index (startedAt/endedAt), the runner's own
  // measured record of when a run happened — never a directory's mtime, which
  // any later write (a `.bak` among them) resets. A run with no index row
  // (never finalized, or the index predates it) is skipped rather than
  // guessed at from the filesystem.
  const rows = await readRunIndex()
  const byId = new Map(rows.map(r => [r.runId, r]))
  const old = []
  for (const runId of runIds) {
    const row = byId.get(runId)
    if (!row) continue
    const at = row.endedAt ?? row.startedAt
    const ageDays = (Date.now() - new Date(at).getTime()) / 86400000
    if (ageDays > olderThanDays) old.push({ runId, ticket: row.ticket ?? '-', ageDays: Math.round(ageDays) })
  }
  console.log(`\n${old.length} run(s) older than ${olderThanDays} day(s) (listed only — this script never deletes a run):`)
  for (const r of old) console.log(`  ${r.ticket.padEnd(12)} ${r.runId}  ${r.ageDays}d`)
}
