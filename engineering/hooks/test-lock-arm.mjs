#!/usr/bin/env node
/**
 * PostToolUse hook — arms the test lock (plan action B3) after a real
 * source edit.
 *
 * test-lock.mjs (PreToolUse) has always correctly *denied* once armed. What
 * it never had was a way to *become* armed in a real session: hooks.json
 * registered PreToolUse only, and nothing but the hook's own tests ever
 * created .agent/source-edited — by hand, before asserting the deny. So in
 * production the marker was never written and the lock denied nothing: an
 * agent could edit src/a.c, then edit the failing test to make it pass, and
 * nothing stopped it. This hook is the missing arm.
 *
 * Why PostToolUse, not a self-arm inside test-lock.mjs's own PreToolUse pass:
 *   - Arming on the *intent* to edit (PreToolUse) would arm even when the
 *     edit then fails — bad path, permission denied, the model backs out —
 *     and a false arm blocks the *next* legitimate test-writing edit for a
 *     reason that never actually happened.
 *   - PostToolUse fires only once the tool has actually completed. A failed
 *     tool call is routed to the separate PostToolUseFailure event instead
 *     (confirmed by pattern-matching a real registration:
 *     ~/.claude/plugins/cache/claude-plugins-official/claude-security/*\/hooks/hooks.json
 *     registers PostToolUseFailure distinctly from PostToolUse; the
 *     security-guidance plugin's hooks.json separately confirms PostToolUse
 *     itself is real and commonly matched on "Edit|Write|MultiEdit|NotebookEdit").
 *     So a PostToolUse[Edit|Write] firing is itself proof the write landed,
 *     and tool_input.file_path is exactly the path that changed — no need to
 *     re-read the filesystem to confirm.
 *   - PostToolUse is available in this Claude Code version, so the
 *     PreToolUse-self-arm fallback the brief allows for is not needed here.
 *
 * Scope, deliberately: only Edit|Write arms here. A Bash command can also
 * write a source file (`sed -i`, heredoc redirection, `tee`, ...) without
 * arming this hook. That gap is left open on purpose rather than guessing
 * which Bash-mutated path is "source" the way test-lock.mjs's `bashTargets*`
 * checks do for denial: a wrong guess here would arm on an innocuous command
 * and lock out the failing-test-authoring step this whole control exists to
 * protect — a false arm is a new, self-inflicted failure mode, whereas not
 * arming on a Bash-only source edit merely leaves today's (already-known,
 * already-documented) gap exactly where it was. The Bash *deny* side, once
 * armed by some other Edit/Write, is unaffected and still fully enforced.
 *
 * Contract: tool call as JSON on stdin. Always exits 0 — this hook only ever
 * has a side effect (write the marker), never a verdict, so there is nothing
 * for it to deny. Any internal error is swallowed for the same fail-open
 * reason every hook here follows: a broken hook must not wedge the estate.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { looksLikeOracle, isExemptPath } from './oracle-paths.mjs'

const STATE = '.agent/source-edited'

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { return }

  let call
  try { call = JSON.parse(raw) } catch { return }

  const tool = call.tool_name ?? ''
  if (tool !== 'Edit' && tool !== 'Write') return

  const cwd = call.cwd || process.cwd()
  const target = call.tool_input?.file_path ?? call.tool_input?.path ?? ''
  if (!target) return

  // Writing the plan, the unlock file, or workflow-run evidence must never
  // arm the lock — same exemptions the plan gate (B2) grants, for the same
  // reason: a control must not be able to lock itself, or its own evidence
  // trail, out.
  if (isExemptPath(target)) return

  // Editing a test/oracle path is not a "source edit" — nothing to arm yet.
  // (This also means writing the failing test itself, before any source
  // edit, correctly never arms the lock.)
  if (looksLikeOracle(target)) return

  try {
    const agentDir = join(cwd, '.agent')
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(cwd, STATE), JSON.stringify({ path: target, armedAt: new Date().toISOString() }) + '\n')
  } catch {
    // Can't write .agent/ — fail open, same as every other hook here. Worst
    // case this degrades to today's already-known gap, not below it.
  }
}

try { main() } catch { /* fail open */ }
process.exit(0)
