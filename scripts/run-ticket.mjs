#!/usr/bin/env node
/**
 * Drive one ticket through a saved workflow, headless.
 *
 *   node scripts/run-ticket.mjs --brief briefs/DEVOPS-23.md [--workflow <slug>] [--wait-min 90]
 *
 * The brief is a plain markdown file: everything a human would tell an engineer
 * before handing them the ticket. It becomes the run's initial prompt verbatim.
 * Keeping it in a file rather than inline in this script is deliberate — an
 * earlier ad-hoc version of this harness carried the prompt inline, and a
 * classification instruction in it went stale against the bundle schema without
 * anyone noticing until a real run recorded the wrong value.
 *
 * Prints the run id and artifacts directory immediately, then a per-step table
 * when the run settles. Exit 0 if the run completed, 1 otherwise — so this is
 * usable from CI, where "the pipeline halted" must not read as success.
 *
 * The artifacts directory is resolved through runArtifacts.ts rather than
 * rebuilt here, for the same reason: a second copy of that path is a second
 * thing to forget to update.
 */
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const briefPath = arg('brief')
if (!briefPath) {
  console.error('Usage: node scripts/run-ticket.mjs --brief <file.md> [--workflow <slug>] [--wait-min 90]')
  process.exit(2)
}

const workflowSlug = arg('workflow', 'runbook-a-ticket-to-evidence-backed-pr')
const waitMin = Number(arg('wait-min', '90'))
const claudeDir = process.env.CLAUDE_DIR || join(homedir(), '.claude')

const brief = readFileSync(briefPath, 'utf8')
const wfPath = join(claudeDir, 'workflows', `${workflowSlug}.json`)
let wf
try {
  wf = JSON.parse(readFileSync(wfPath, 'utf8'))
} catch {
  console.error(`No workflow at ${wfPath}. Create it from the Runbook A template first.`)
  process.exit(2)
}

const runner = await import('../server/utils/workflowRunner.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const projectDir = arg('project-dir', process.env.RUN_PROJECT_DIR)

// The ticket this run is for. Taken from --ticket, else inferred from the
// brief's filename (briefs/DEVOPS-15.md -> DEVOPS-15), which is how every
// brief in this repo is named. Runner-owned: stated here, never read back
// from anything an agent wrote. Absent means "do not notify" - which is the
// right default for an ad-hoc run against a scratch brief.
const ticketKey = arg('ticket') || (basename(briefPath).match(/^([A-Z]+-\d+)/)?.[1] ?? undefined)
if (ticketKey) console.log(`TICKET=${ticketKey}`)

// Pre-flight: refuse to start on a dirty target repository.
//
// A run that begins on top of uncommitted work cannot produce an honest
// result. Its oracle stage is asked to write a test that fails against the
// current tree, but the capability may already be sitting there unstaged; and
// if any later step commits broadly, that pre-existing work is attributed to
// this run for good. Both happened on DEVOPS-15: a runaway intake step wrote
// the entire implementation and died, and the next run started on its
// leftovers.
//
// --allow-dirty is deliberate rather than a force flag with a scary name:
// re-running a ticket against a tree you have intentionally staged is a real
// workflow, and it should be one word, said out loud, in the command line.
const { workingTreeDirty } = await import('../server/utils/gitFacts.ts')
const dirty = await workingTreeDirty(projectDir)
if (dirty?.length && !process.argv.includes('--allow-dirty')) {
  console.error(`Refusing to start: ${projectDir} has ${dirty.length} uncommitted path(s).`)
  for (const f of dirty.slice(0, 20)) console.error(`  ${f}`)
  if (dirty.length > 20) console.error(`  ... and ${dirty.length - 20} more`)
  console.error('\nCommit, stash, or discard them first — or pass --allow-dirty if this is intended.')
  process.exit(2)
}

const run = await runner.startRun({
  workflow: { slug: workflowSlug, name: wf.name, steps: wf.steps },
  initialPrompt: brief,
  // This harness invokes the workflow directly, off the CLI - not by a
  // registered watch. 'direct-invocation' is the reserved literal the
  // evidence bundle schema requires for exactly that case.
  watch: 'direct-invocation',
  ...(ticketKey ? { ticketKey } : {}),
  autoRun: true,
  ...(projectDir ? { projectDir } : {}),
})

console.log(`RUN_ID=${run.id}`)
console.log(`ARTIFACTS=${runArtifactsDir(run.id)}`)

const settled = await runner.waitForSettled(run.id, waitMin * 60 * 1000)

console.log(`\nSTATUS=${settled.status}`)
for (const s of settled.steps) {
  const secs = s.startedAt && s.completedAt ? `${Math.round((s.completedAt - s.startedAt) / 1000)}s` : ''
  const parts = [
    String(s.label).padEnd(24),
    String(s.status).padEnd(10),
    secs.padEnd(7),
    `model=${s.model ?? '-'}`,
  ]
  if (s.monitorVerdict) parts.push(`monitor=${s.monitorVerdict}`)
  if (s.error) parts.push(`\n      ${s.error}`)
  console.log('  ' + parts.join(' '))
}

// A halted or failed run is not a success. CI must be able to tell the
// difference without parsing this table.
process.exit(settled.status === 'completed' ? 0 : 1)
