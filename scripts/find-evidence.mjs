/**
 * Search every run's evidence by what a file IS, not by remembering its name.
 *
 *   node scripts/find-evidence.mjs --kind qa --ticket CSUP-7519
 *   node scripts/find-evidence.mjs --name tz-matrix
 *   node scripts/find-evidence.mjs --binary            # what is big and unreadable
 *   node scripts/find-evidence.mjs --kinds             # counts per kind, per run
 *
 * Reads each run's `artifacts.json` when it has one, and CLASSIFIES ON THE FLY
 * when it does not — the thirteen runs that predate the index are searchable
 * here without re-finalizing them, which would drop agent-reported commits for
 * runs whose checkouts are gone (see reconcileFix). Nothing here writes.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const has = name => args.includes(`--${name}`)

const want = {
  kind: flag('kind'), ticket: flag('ticket')?.toUpperCase(),
  run: flag('run'), name: flag('name')?.toLowerCase(), step: flag('step')?.toLowerCase(),
  binary: has('binary'),
}

const { agentRunsRoot, runArtifactsDir } = await import('../server/utils/runArtifacts.ts')
const { classifyArtifact } = await import('../server/utils/artifactIndex.ts')

const root = agentRunsRoot()
let runIds
try {
  runIds = await readdir(root)
} catch {
  console.log(`no artifacts directory at ${root}`)
  process.exit(0)
}

/** The run's own index, or a live classification of the directory when it has none. */
async function rowsFor(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'artifacts.json'), 'utf8'))
  } catch { /* no index: classify what is on disk */ }
  const rows = []
  const walk = async (d, rel) => {
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name
      const full = join(d, e.name)
      if (e.isDirectory()) { await walk(full, name); continue }
      let bytes = 0
      try { bytes = (await stat(full)).size } catch { continue }
      const { kind, ticket } = classifyArtifact(name)
      rows.push({ name, kind, bytes, ...(ticket ? { ticket } : {}) })
    }
  }
  await walk(dir, '')
  return rows
}

const matches = r =>
  (!want.kind || r.kind === want.kind)
  && (!want.ticket || r.ticket === want.ticket)
  && (!want.name || r.name.toLowerCase().includes(want.name))
  && (!want.step || (r.step ?? '').toLowerCase().includes(want.step))
  && (!want.binary || r.binary === true)

let total = 0
let bytes = 0
for (const runId of runIds) {
  if (want.run && runId !== want.run) continue
  const dir = runArtifactsDir(runId)
  const rows = (await rowsFor(dir)).filter(matches)
  if (!rows.length) continue
  if (has('kinds')) {
    const counts = {}
    for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1
    const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')
    console.log(`${runId}  ${rows.length} file(s)  ${summary}`)
  } else {
    for (const r of rows) {
      console.log(`${r.kind.padEnd(11)} ${String(r.bytes).padStart(9)}  ${runId}/${r.name}${r.step ? `  <- ${r.step}` : ''}`)
    }
  }
  total += rows.length
  bytes += rows.reduce((n, r) => n + r.bytes, 0)
}
console.log(`\n${total} file(s), ${bytes} bytes across ${runIds.length} run(s).`)
