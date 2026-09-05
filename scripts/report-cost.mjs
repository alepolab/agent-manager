#!/usr/bin/env node
/**
 * Read cost back out of workflow runs, headless - no server, no browser.
 *
 *   node scripts/report-cost.mjs                              # every run, aggregated
 *   node scripts/report-cost.mjs --workflow runbook-a-ticket-to-evidence-backed-pr
 *   node scripts/report-cost.mjs --since 2026-09-01            # runs started on/after this date
 *   node scripts/report-cost.mjs --since 1756684800000         # ...or epoch ms
 *   node scripts/report-cost.mjs --run <runId>                 # one run, per-step breakdown
 *   node scripts/report-cost.mjs --json                        # raw JSON instead of a table
 *
 * Reads straight through server/utils/workflowRunStore.ts and costReport.ts -
 * the same functions the API routes call - so this and the app can never
 * quietly disagree about what a run cost. Nothing here re-derives a number;
 * see costReport.ts's COST_NOTE for the two caveats every figure below
 * carries (cache tokens folded into input_tokens; unmeasured/unpriced steps
 * excluded from cost_usd, never assumed free).
 *
 * Exit 0 on success, 2 on a bad argument or an unknown run id.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = name => process.argv.includes(`--${name}`)

const claudeDir = process.env.CLAUDE_DIR || join(homedir(), '.claude')
process.env.CLAUDE_DIR ??= claudeDir

const { listRuns, getRun } = await import('../server/utils/workflowRunStore.ts')
const { summarizeRunCost, aggregateCost } = await import('../server/utils/costReport.ts')

const asJson = has('json')
const money = n => `$${n.toFixed(4)}`

function printSteps(steps) {
  for (const s of steps) {
    const tokens = s.input_tokens === null
      ? 'usage=unmeasured'
      : `in=${s.input_tokens} out=${s.output_tokens}`
    const cost = s.cost_usd === null ? `cost=unknown(${s.excludedReason})` : `cost=${money(s.cost_usd)}`
    console.log(`    ${String(s.label).padEnd(24)} model=${(s.model ?? '-').padEnd(28)} ${tokens.padEnd(24)} ${cost}`)
  }
}

function printTotals(totals) {
  console.log(`  tokens: in=${totals.input_tokens} out=${totals.output_tokens}`)
  console.log(`  cost:   ${money(totals.cost_usd)}${totals.complete ? '' : '  (PARTIAL - see below)'}`)
  console.log(`  steps:  measured=${totals.measured_step_count} unmeasured=${totals.unmeasured_step_count} unpriced=${totals.unpriced_step_count}`)
  if (!totals.complete) {
    console.log('  NOTE: cost_usd excludes unmeasured/unpriced steps - it is a real but PARTIAL total, not the whole spend.')
  }
}

const runId = arg('run')

if (runId) {
  const run = await getRun(runId)
  if (!run) {
    console.error(`No run found with id ${runId}`)
    process.exit(2)
  }
  const summary = summarizeRunCost(run)
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`RUN ${summary.runId}  (${summary.workflowName}, ${summary.status})`)
    console.log(`  wall_clock=${summary.wall_clock_min}min  attempts=${summary.attempts}`)
    printSteps(summary.steps)
    printTotals(summary.totals)
    console.log(`\n${summary.note}`)
  }
  process.exit(0)
}

const workflowSlug = arg('workflow')
const sinceArg = arg('since')
let sinceMs
if (sinceArg) {
  const asNumber = Number(sinceArg)
  sinceMs = Number.isFinite(asNumber) ? asNumber : Date.parse(sinceArg)
  if (!Number.isFinite(sinceMs)) {
    console.error(`--since value is not a valid date or epoch ms: ${sinceArg}`)
    process.exit(2)
  }
}

const runs = (await listRuns(workflowSlug)).filter(r => sinceMs === undefined || r.startedAt >= sinceMs)
const aggregate = aggregateCost(runs)

if (asJson) {
  console.log(JSON.stringify(aggregate, null, 2))
} else {
  console.log(`${aggregate.run_count} run(s)${workflowSlug ? ` for workflow ${workflowSlug}` : ''}${sinceArg ? ` since ${sinceArg}` : ''}`)
  for (const r of aggregate.runs) {
    console.log(`\n${new Date(r.startedAt).toISOString()}  ${r.workflowName.padEnd(28)} ${r.status.padEnd(12)} ${money(r.totals.cost_usd)}${r.totals.complete ? '' : ' (partial)'}`)
  }
  console.log('\nTOTAL')
  printTotals(aggregate.totals)
  console.log(`\n${aggregate.note}`)
}
process.exit(0)
