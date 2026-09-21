/**
 * Rebuild server/utils/runIndex.ts's index.jsonl from the run records and
 * artifacts that already exist on disk.
 *
 *   node scripts/rebuild-run-index.mjs            # report only
 *   node scripts/rebuild-run-index.mjs --write    # write index.jsonl
 *
 * A finishing run indexes itself — `finalizeRunArtifacts` calls
 * `updateRunIndex` on every terminal status. This script is for the runs that
 * finished BEFORE the index existed, and for rebuilding it from scratch after
 * a change to the row shape. It calls the same `buildRunIndexRow` the live path
 * does, so there is one definition of what a row contains, not two.
 *
 * Every row comes from `buildRunIndexRow`, the exact function a live run will
 * eventually call through `updateRunIndex` — this script is not a second,
 * drifting implementation of what a row contains.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const write = process.argv.includes('--write')

const { resolveClaudePath } = await import('../server/utils/claudeDir.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { buildRunIndexRow, updateRunIndex } = await import('../server/utils/runIndex.ts')

const recordsDir = resolveClaudePath('workflow-runs')
let files
try {
  files = (await readdir(recordsDir)).filter(f => f.endsWith('.json'))
} catch {
  console.log(`no run records in ${recordsDir}`)
  process.exit(0)
}

if (!files.length) {
  console.log(`no run records in ${recordsDir}`)
  process.exit(0)
}

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

let ok = 0
let skipped = 0
for (const file of files) {
  const id = file.replace(/\.json$/, '')
  const run = await readJson(join(recordsDir, file))
  if (!run || typeof run.id !== 'string') {
    console.error(`skip ${id}: no readable run record`)
    skipped += 1
    continue
  }
  const meta = (await readJson(join(runArtifactsDir(id), 'meta.json'))) ?? {}

  if (write) {
    try {
      await updateRunIndex(run, meta)
    } catch (e) {
      console.error(`skip ${id}: ${e.message}`)
      skipped += 1
      continue
    }
  }

  const row = await buildRunIndexRow(run, meta)
  console.log([
    (row.ticket ?? '-').padEnd(12),
    row.runId,
    row.status.padEnd(10),
    `${row.stepCount} steps`,
    row.costUsd !== undefined ? `$${row.costUsd.toFixed(2)}` : '(unmeasured)',
  ].join('  '))
  ok += 1
}

console.log(write
  ? `\n${ok} row(s) written to ${resolveClaudePath('workflow-runs', 'index.jsonl')}, ${skipped} skipped`
  : `\n${ok} run(s) would be indexed, ${skipped} skipped. Re-run with --write to build the index.`)
