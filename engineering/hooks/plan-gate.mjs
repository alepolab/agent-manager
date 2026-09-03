#!/usr/bin/env node
/**
 * PreToolUse hook — the plan gate (plan action B2).
 *
 * Denies Edit and Write until .agent/plan.md exists and passes a structural
 * check. Plan-before-code becomes a property of the session rather than a
 * habit the agent may or may not have.
 *
 * In a headless run the structural check IS the acceptance — no human is there
 * to accept it — and the plan then rides in the evidence bundle for the
 * reviewer. That is why the check is structural and specific: it is the only
 * thing standing between "wrote a plan" and "wrote the word plan".
 *
 * Wire in settings.json:
 *   { "hooks": { "PreToolUse": [ { "matcher": "Edit|Write",
 *       "hooks": [ { "type": "command",
 *                    "command": "node ~/.claude/plugins/.../hooks/plan-gate.mjs" } ] } ] } }
 *
 * Contract: read the tool call on stdin as JSON; exit 0 to allow; print a
 * reason and exit 2 to deny. Any internal error allows — a broken hook must
 * not wedge every session in the estate.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PLAN_PATH = '.agent/plan.md'

/** Sections the plan must actually contain, and what each one is for. */
const REQUIRED = [
  { heading: /^#+\s*cause/im, name: 'Cause', why: 'what is actually wrong, not what to type' },
  { heading: /^#+\s*change/im, name: 'Change', why: 'the intended edit, before making it' },
  { heading: /^#+\s*oracle/im, name: 'Oracle', why: 'what will fail first and prove the fix' },
  { heading: /^#+\s*blast[\s-]?radius/im, name: 'Blast radius', why: 'the self-label the classifier checks against' },
  { heading: /^#+\s*deployment truths/im, name: 'Deployment truths', why: 'the estate facts considered — two-node AAA and the like' },
]

function main() {
  let input = ''
  try { input = readFileSync(0, 'utf8') } catch { process.exit(0) }

  let call
  try { call = JSON.parse(input) } catch { process.exit(0) }

  const cwd = call.cwd || process.cwd()
  const target = call.tool_input?.file_path ?? call.tool_input?.path ?? ''

  // The plan itself, and everything else under .agent/, must be writable —
  // otherwise the gate forbids satisfying the gate.
  if (target.includes('.agent/')) process.exit(0)

  const planFile = join(cwd, PLAN_PATH)
  if (!existsSync(planFile)) {
    console.error(
      `Blocked: ${PLAN_PATH} does not exist yet.\n\n` +
      `Write the plan before the code. It needs these sections:\n` +
      REQUIRED.map(r => `  ## ${r.name} — ${r.why}`).join('\n') +
      `\n\nThis is the plan gate (B2). The plan travels into the evidence bundle,\n` +
      `so a reviewer sees what you intended as well as what you did.`
    )
    process.exit(2)
  }

  let plan = ''
  try { plan = readFileSync(planFile, 'utf8') } catch { process.exit(0) }

  const missing = REQUIRED.filter(r => !r.heading.test(plan))
  if (missing.length) {
    console.error(
      `Blocked: ${PLAN_PATH} is missing ${missing.length} required section(s):\n` +
      missing.map(r => `  ## ${r.name} — ${r.why}`).join('\n') +
      `\n\nA plan that names no oracle and no blast radius cannot be reviewed as a plan.`
    )
    process.exit(2)
  }

  // A heading with nothing under it is a heading, not a plan.
  for (const r of REQUIRED) {
    const m = plan.match(new RegExp(r.heading.source + String.raw`([\s\S]*?)(?=^#+\s|\Z)`, 'im'))
    if (m && m[1] !== undefined && m[1].trim().length < 15) {
      console.error(
        `Blocked: the "${r.name}" section of ${PLAN_PATH} is empty.\n` +
        `It is there for a reason: ${r.why}.`
      )
      process.exit(2)
    }
  }

  process.exit(0)
}

try { main() } catch { process.exit(0) }
