#!/usr/bin/env node
// Will this change-brief.json open its gate by itself? The same checks the workflow runner makes
// (server/utils/workflowRunner.ts readyHandover), with Agent Manager's own parser, imported from
// the agent-manager clone in /src so the two can never disagree:
//
//   node /opt/pwmig/check-brief.mjs <run artifacts>/change-brief.json
//
// Prints "ok: …" and exits 0, or lists what to fix and exits 1. A brief the parser refuses stops the
// run for a person even when it says "ready": true (12__Purchase_Service's plan gate: no `leaves`).
import { readFileSync } from 'node:fs'

const AM = process.env.PWMIG_AM_SRC ?? '/src/agentmanager'
const { parseDecisionBrief, unresolvedQuestions } = await import(`${AM}/shared/utils/decisionBrief.ts`)
const file = process.argv[2]
if (!file) { console.error('usage: check-brief.mjs <change-brief.json>'); process.exit(2) }

let raw
try { raw = readFileSync(file, 'utf8') } catch { console.log(`NOT READY: ${file} does not exist`); process.exit(1) }
const problems = []
let ready
try { ready = JSON.parse(raw)?.ready } catch { /* parseDecisionBrief says so */ }
const parsed = parseDecisionBrief(raw)
if ('error' in parsed) problems.push(parsed.error.replaceAll('decision.json', 'change-brief.json'))
if (ready !== true) problems.push('`ready` is not true')
if ('brief' in parsed) {
  const open = unresolvedQuestions(parsed.brief)
  if (open.length) problems.push(`${open.length} open question(s) not resolved: ${open.map(q => q.question).join(' | ')}`)
}
if (problems.length) {
  console.log(`NOT READY: the gate would stop for a person.\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('ok: the gate will open by itself')
