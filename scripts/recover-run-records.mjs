/**
 * Rebuild the run records of runs whose artifacts outlived them.
 *
 *   node scripts/recover-run-records.mjs            # report only
 *   node scripts/recover-run-records.mjs --write    # write the missing records
 *
 * Six runs on this instance have a full artifacts directory and no record. The
 * records lived under CLAUDE_DIR, and the documented redeploy sequence deletes
 * that volume to reseed baked config; the artifacts are in a volume of their
 * own and survived. So the evidence sits on disk while `/runs` shows nothing —
 * WPM-1358 and DEVOPS-23 among them, each with commits and an open pull
 * request.
 *
 * Every field written here is READ from the artifacts, never inferred:
 * `meta.json` is runner-owned (identity, watch, workflow, ticket, product,
 * cost, fix) and each `steps/step-NN-*.json` is the runner's own snapshot of
 * one step. What the artifacts do not carry is left absent rather than guessed
 * — `initialPrompt` above all, which existed only in the record. A recovered
 * record says so in `recovered`, so nothing downstream mistakes it for one the
 * runner wrote itself.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const write = process.argv.includes('--write')

const { resolveClaudePath } = await import('../server/utils/claudeDir.ts')
const { agentRunsRoot, runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const recordsDir = resolveClaudePath('workflow-runs')
const root = agentRunsRoot()
if (!existsSync(root)) {
  console.log(`no artifacts directory at ${root}`)
  process.exit(0)
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/** The step files in the order the runner wrote them: step-01, step-02, … */
function stepsOf(dir) {
  const stepsDir = join(dir, 'steps')
  if (!existsSync(stepsDir)) return []
  return readdirSync(stepsDir)
    .filter(f => /^step-\d+-.*\.json$/.test(f))
    // A retry or restart snapshot is a PREVIOUS attempt of a step that also has
    // a final file; including both would report the same step twice.
    .filter(f => !/-(retry|restart|no-verdict)-\d+\.json$/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map(f => ({ file: f, data: readJson(join(stepsDir, f)) }))
    .filter(s => s.data)
}

const found = []
for (const id of readdirSync(root)) {
  if (existsSync(join(recordsDir, `${id}.json`))) continue
  const dir = runArtifactsDir(id)
  const meta = readJson(join(dir, 'meta.json')) ?? {}
  const steps = stepsOf(dir)
  if (!steps.length) {
    console.log(`skip ${id}: no step artifacts to rebuild from`)
    continue
  }

  const times = steps.flatMap(s => [s.data.startedAt, s.data.completedAt]).filter(Boolean)
  const record = {
    id,
    // The slug is not in the artifacts; the NAME is. Kept distinct so nobody
    // reads a made-up slug as the workflow this run was dispatched from.
    workflowSlug: 'recovered',
    workflowName: meta.workflow ?? 'Unknown workflow',
    status: steps.some(s => s.data.status === 'failed') ? 'failed' : 'completed',
    autoRun: true,
    initialPrompt: '',
    watch: typeof meta.watch === 'string' ? meta.watch : 'direct-invocation',
    ...(meta.ticket ? { ticketKey: meta.ticket } : {}),
    ...(typeof meta.identity === 'string' ? { startedBy: meta.identity } : {}),
    ...(meta.product ? { product: { name: meta.product, repos: [], branches: {}, stack: { compose: '', topology_default: '' }, tests: {} } } : {}),
    ...(meta.blast_radius ? { blastRadius: meta.blast_radius } : {}),
    ...(meta.work_type ? { workType: meta.work_type } : {}),
    startedAt: times.length ? Math.min(...times) : Date.now(),
    ...(times.length ? { endedAt: Math.max(...times) } : {}),
    steps: steps.map(s => ({
      stepId: s.data.stepId,
      label: s.data.label,
      agentSlug: s.data.agentSlug,
      status: s.data.status,
      input: s.data.input ?? '',
      output: s.data.output ?? '',
      ...(s.data.error ? { error: s.data.error } : {}),
      ...(s.data.startedAt ? { startedAt: s.data.startedAt } : {}),
      ...(s.data.completedAt ? { completedAt: s.data.completedAt } : {}),
      ...(s.data.model ? { model: s.data.model } : {}),
      ...(s.data.usage ? { usage: s.data.usage } : {}),
      ...(s.data.monitorVerdict ? { monitorVerdict: s.data.monitorVerdict } : {}),
      ...(s.data.monitorNote ? { monitorNote: s.data.monitorNote } : {}),
      // Not in the artifact, and not guessable: the runner writes a step file
      // per completed visit, not a visit count.
      visits: 1,
    })),
    currentStepIds: [],
    nextStepIds: [],
    recovered: {
      at: Date.now(),
      from: dir,
      note: 'Rebuilt from run artifacts after the record was lost. initialPrompt and the workflow slug were never in the artifacts and are absent rather than guessed.',
    },
  }
  found.push({ id, record, ticket: meta.ticket ?? '-', steps: steps.length })
}

if (!found.length) {
  console.log('every run with artifacts already has a record')
  process.exit(0)
}

for (const f of found) {
  console.log(`${f.ticket.padEnd(12)} ${f.id}  ${f.steps} steps  ${f.record.status}`)
  if (!write) continue
  writeFileSync(join(recordsDir, `${f.id}.json`), JSON.stringify(f.record, null, 2))
  // A recovered record is a run the finalizer never saw: without this its meta
  // stays frozen at whatever the dead process last wrote, so it carries no
  // contract report, no provenance and no index row — the very reports that
  // exist to say an old run's evidence is incomplete.
  try {
    await finalizeRunArtifacts(f.record)
  } catch (e) {
    console.error(`  (artifacts not finalized for ${f.id}: ${e.message})`)
  }
}
console.log(write
  ? `\n${found.length} record(s) written to ${recordsDir}`
  : `\n${found.length} recoverable. Re-run with --write to rebuild them.`)
