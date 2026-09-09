#!/usr/bin/env node
/**
 * PreToolUse hook — the test lock (plan action B3).
 *
 * Once a ticket session has edited a source file, the oracle is frozen. A
 * green test must be green because the code changed, never because the test
 * did. This is the mechanical version of the rule; the prompt-level version is
 * advisory and a capable agent can comply with its letter while defeating it.
 *
 * It closes three specific holes a naive file-path check leaves open:
 *
 *   1. Bash. An agent with Bash does not need Edit to rewrite a test:
 *      `sed -i`, `> file`, `tee`, `cp`, `mv`, `patch`, `git checkout --` all
 *      work. Edit-only enforcement is theatre.
 *   2. Oracle-adjacent config. conftest.py, jest.setup.js, a global mock or a
 *      fixture changes what the tests assert without living under tests/.
 *      The property we want is "the oracle is unchanged", not "no file under
 *      tests/ was touched".
 *   3. Deletion. Removing a failing test passes the suite too.
 *
 * Unlock is deliberately not self-service: a human comments the ticket key and
 * a reason, and the runner writes .agent/test-unlock.json. The unlock and its
 * reason then ride in the evidence bundle, so a reviewer always sees that the
 * oracle was touched and why.
 *
 * This file only ever DENIES; it never arms itself. .agent/source-edited is
 * written by test-lock-arm.mjs, the companion PostToolUse hook, after a real
 * source edit actually lands. Before that hook existed, hooks.json registered
 * PreToolUse only and nothing in a real session ever created the marker — the
 * lock enforced nothing outside its own tests, which armed it by hand. See
 * test-lock-arm.mjs for why arming belongs in PostToolUse, not here.
 *
 * Contract: tool call as JSON on stdin; exit 0 allows; exit 2 with a printed
 * reason denies. Internal errors allow — a broken hook must not wedge the estate.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { looksLikeOracle } from './oracle-paths.mjs'
import { commandSegments, segmentTokens } from './command-segments.mjs'

const STATE = '.agent/source-edited'
const UNLOCK = '.agent/test-unlock.json'

/**
 * Bash forms that write to a path without going through Edit/Write.
 *
 * Deliberately two coarse steps rather than one clever parse: does the command
 * contain something that mutates a file, and does it mention an oracle path?
 * Trying to parse each utility's argument grammar is where this kind of check
 * goes wrong — the first version of this function matched `sed -i`'s *script*
 * instead of its filename and let the most obvious bypass straight through.
 *
 * Matching is per COMMAND SEGMENT (see command-segments.mjs), so a mutation in
 * one command no longer convicts a path in another: `sed -i ... src/a.ts && cat
 * tests/b.test.ts` mutates source and merely reads a test, and is allowed. Every
 * real bypass puts the mutation and its target in the same segment - `sed -i
 * tests/x`, `> tests/x`, `git checkout -- tests/` - and those stay denied.
 */
const MUTATORS = [
  { re: /\bsed\b[^|;&]*\s-i\b/, what: 'sed -i' },
  // Not `2>&1` or `>&2`: duplicating a file descriptor writes to no file.
  // `out=$(node "$t" 2>&1)` over a loop of test files was denied as though it
  // rewrote them.
  { re: />>?\s*(?!&)[^>]/, what: 'shell redirection' },
  { re: /\btee\b/, what: 'tee' },
  { re: /\b(?:cp|mv|install)\b/, what: 'cp/mv' },
  { re: /\brm\b/, what: 'rm' },
  { re: /\bpatch\b/, what: 'patch' },
  { re: /\btruncate\b/, what: 'truncate' },
  // `git checkout`/`git switch` that CREATES a branch restores nothing, and
  // denying it stopped a session from even starting a branch for its fix.
  { re: /\bgit\s+(?:checkout|restore)\b(?![^\n]*\s-(?:b|B|c|C)\b)(?![^\n]*--orphan\b)/, what: 'git checkout/restore' },
  { re: /\b(?:dd|shred)\b/, what: 'dd/shred' },
]

function bashTargetsOracle(command) {
  if (!command) return null

  // Per SEGMENT, not per line. The mutation and the oracle path have to belong
  // to the same command for one to be doing anything to the other; matching
  // across a whole multi-command string convicted commands of each other's
  // arguments. This is still two coarse steps inside a segment - the reasoning
  // in MUTATORS about not parsing each utility's grammar is unchanged.
  for (const segment of commandSegments(command)) {
    const mutator = MUTATORS.find(m => m.re.test(segment))
    if (!mutator) continue

    const hit = segmentTokens(segment).find(t => looksLikeOracle(t))
    if (hit) return { what: mutator.what, path: hit }

    // A whole-suite reset that names the directory rather than a file.
    if (/\bgit\s+(?:checkout|restore)\b[^|;&\n]*\b(tests?|spec|specs)\b/i.test(segment)) {
      return { what: 'git restore of a test path', path: '(test directory)' }
    }
  }
  return null
}

function deny(message) {
  console.error(message)
  process.exit(2)
}

function main() {
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { process.exit(0) }
  let call
  try { call = JSON.parse(raw) } catch { process.exit(0) }

  const cwd = call.cwd || process.cwd()
  const tool = call.tool_name ?? ''
  const input = call.tool_input ?? {}

  // A human unlocked it. The unlock rides in the bundle; nothing to enforce.
  if (existsSync(join(cwd, UNLOCK))) process.exit(0)

  // The lock only arms once source has been edited — the oracle must be
  // writable before that, or the failing test could never be written.
  const armed = existsSync(join(cwd, STATE))
  if (!armed) process.exit(0)

  if (tool === 'Bash') {
    const hit = bashTargetsOracle(input.command ?? '')
    if (hit) {
      deny(
        `Blocked: this ${hit.what} would modify the oracle (${hit.path}) after source was edited.\n\n` +
        `The test lock is armed for this ticket session. A passing suite has to be\n` +
        `earned by the fix, not by rewriting what it is measured against — and a\n` +
        `shell is not an exemption from that.\n\n` +
        `If the test itself is genuinely wrong: stop, say so on the ticket, and ask a\n` +
        `human to unlock. The unlock and your reason go into the evidence bundle.`
      )
    }
    process.exit(0)
  }

  const target = input.file_path ?? input.path ?? ''
  if (looksLikeOracle(target)) {
    deny(
      `Blocked: ${target} decides what the oracle asserts, and source has already\n` +
      `been edited in this ticket session.\n\n` +
      `Case B's failure mode is exactly this: a green test that was made green by\n` +
      `editing the test. On a money path a passing test is not sufficient evidence,\n` +
      `and it is worth nothing at all if the agent could edit it.\n\n` +
      `If you believe the test is wrong, stop and say so rather than changing it.\n` +
      `A human unlocks with a reason, and both go into the evidence bundle.`
    )
  }

  process.exit(0)
}

try { main() } catch { process.exit(0) }
