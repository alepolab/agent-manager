/**
 * Run the light-model pass over evidence indexes that never got one.
 *
 *   node scripts/enhance-evidence-index.mjs            # every run with an index
 *   node scripts/enhance-evidence-index.mjs --run <id>
 *   node scripts/enhance-evidence-index.mjs --build    # write a rules index first for runs with none
 *
 * A run finalizes without waiting for interpretation (see finalizeRunArtifacts),
 * so a process that exits promptly leaves the rules classification in place.
 * This is how that gets picked up later — and how the runs that predate the
 * index get one at all, with --build.
 *
 * Reads and writes only `artifacts.json` and the `artifacts` key of meta.json.
 * Nothing here re-finalizes a run: reconciliation would drop agent-reported
 * commits for runs whose checkouts are gone.
 */
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const only = args.includes('--run') ? args[args.indexOf('--run') + 1] : undefined
const build = args.includes('--build')

const { agentRunsRoot, runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { enhanceArtifactIndex, writeArtifactIndex } = await import('../server/utils/artifactIndex.ts')
const { readRunIndex } = await import('../server/utils/runIndex.ts')
const { lightAgentEnabled } = await import('../server/utils/lightAgent.ts')

if (!lightAgentEnabled()) {
  console.log('AGENT_LIGHT_INTERPRET=0 — interpretation is off; nothing to do.')
  process.exit(0)
}

const root = agentRunsRoot()
let runIds
try {
  runIds = await readdir(root)
} catch {
  console.log(`no artifacts directory at ${root}`)
  process.exit(0)
}

// A run record is needed only to attribute files to steps; without one the
// rules index still classifies, it just cannot say which step wrote what.
const rows = await readRunIndex().catch(() => [])
const known = new Map(rows.map(r => [r.runId, r]))

let touched = 0
for (const runId of runIds) {
  if (only && runId !== only) continue
  const dir = runArtifactsDir(runId)
  if (!existsSync(dir)) continue
  if (build && !existsSync(join(dir, 'artifacts.json'))) {
    // Steps are unknown here (the index row carries no step windows), so this
    // writes classification without provenance rather than inventing it.
    const summary = await writeArtifactIndex(dir, { id: runId, steps: [] })
    console.log(`${runId}  built index: ${Object.entries(summary.kinds).map(([k, n]) => `${k}:${n}`).join(' ')}`)
  }
  const changed = await enhanceArtifactIndex(dir)
  const ticket = known.get(runId)?.ticket ?? '-'
  if (changed) {
    console.log(`${runId}  ${ticket}  ${changed} file(s) reclassified by the light agent`)
    touched += 1
  }
}
console.log(`\n${touched} run(s) updated of ${runIds.length} checked.`)
