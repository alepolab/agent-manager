/**
 * Write the human-readable summary for a finished run, or for all of them.
 *
 *   node scripts/run-summary.mjs                 # every run that has a record
 *   node scripts/run-summary.mjs <run-id>        # just that one
 *   node scripts/run-summary.mjs --print <id>    # to stdout, write nothing
 *
 * The runner writes RUN-SUMMARY.md by itself when a run finishes. This is for
 * the runs that finished before it did, and for re-rendering after the template
 * changes — neither of which is worth a re-run of the pipeline.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const printOnly = args.includes('--print')
const ids = args.filter(a => !a.startsWith('--'))

const { resolveClaudePath } = await import('../server/utils/claudeDir.ts')
const { renderRunSummary, writeRunSummary, SUMMARY_FILE } = await import('../server/utils/runSummary.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const dir = resolveClaudePath('workflow-runs')
const wanted = ids.length
  ? ids
  : (await readdir(dir)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))

if (!wanted.length) {
  console.log(`no run records in ${dir}`)
  process.exit(0)
}

let written = 0
for (const id of wanted) {
  let run
  try {
    run = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))
  } catch {
    console.error(`skip ${id}: no run record in ${dir}`)
    continue
  }
  if (printOnly) {
    let meta = {}
    try { meta = JSON.parse(await readFile(join(runArtifactsDir(id), 'meta.json'), 'utf8')) } catch { /* optional */ }
    console.log(renderRunSummary(run, meta))
    continue
  }
  try {
    const path = await writeRunSummary(run)
    written += 1
    console.log(`${run.ticketKey ?? run.workflowSlug} -> ${path}`)
  } catch (e) {
    // The artifacts directory can be gone while the record survives; that is a
    // fact about this run, not a reason to abandon the rest.
    console.error(`skip ${id}: ${e.message}`)
  }
}
if (!printOnly) console.log(`\n${written} ${SUMMARY_FILE} written`)
