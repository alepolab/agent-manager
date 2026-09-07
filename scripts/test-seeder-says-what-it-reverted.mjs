#!/usr/bin/env node
/**
 * Proven on the running instance: an edit to a shipped sdlc-* agent is silently
 * reverted at the next boot.
 *
 *   before restart: sdlc-verifier marker=1
 *   after  restart: sdlc-verifier marker=0
 *
 * The reverting is correct — it is how a team standard stays a standard. The
 * SILENCE is the defect. Nothing said the edit had been replaced: not the UI,
 * not the boot line, and not the filesystem, which afterwards looks exactly as
 * though the edit was never made.
 *
 * Two things are pinned here:
 *  1. teamSync reports what it OVERWROTE (drifted), distinct from what it
 *     created (missing), and teamSeed names those items on boot.
 *  2. A plugin agent overrides a shipped template of the same id. Without that,
 *     `promote` is a trap: it opens a PR, reports success, and the boot revert
 *     still happens because the agent loop skipped any id matching a shipped
 *     template.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

const sync = read('server/utils/teamSync.ts')
const seed = read('server/plugins/teamSeed.ts')

check('TeamStatus carries what was reverted',
  /reverted: \{ kind: 'agent' \| 'skill' \| 'command', name: string \}\[\]/.test(sync),
  'the caller cannot report a loss the reconciler never told it about')

check('reverted is returned, not just computed',
  /\n    reverted,/.test(sync),
  'an accumulator that never reaches the return value is dead code')

// The ordering is the subtle part: applying sets state to 'ok', so a check
// written after the write can never see 'drifted' and the list is always empty.
for (const [kind, re] of [
  ['skill', /if \(apply && state === 'drifted'\) reverted\.push\(\{ kind: 'skill', name \}\)[\s\S]{0,600}?await cp\(/],
  ['command', /if \(apply && state === 'drifted'\) reverted\.push\(\{ kind: 'command'[\s\S]{0,200}?await writeFile\(to, next\)/],
  ['agent', /if \(apply && state === 'drifted'\) reverted\.push\(\{ kind: 'agent', name: id \}\)\n\s*if \(apply && state !== 'ok'\) \{ await writeFile/],
]) {
  check(`${kind} records the revert BEFORE overwriting`, re.test(sync),
    `applying sets state to 'ok'; a push written after the write would always see 'ok' and record nothing`)
}

check('only a real overwrite counts as a revert',
  !/if \(apply && state !== 'ok'\) reverted\.push/.test(sync),
  "a freshly seeded item ('missing') is not a lost edit; reporting it as one would make the warning noise and get ignored")

check('the boot log names the reverted items',
  /reverted \$\{s\.reverted\.length\} locally-edited item\(s\)/.test(seed)
  && /r\.kind\}\/\$\{r\.name/.test(seed),
  'a count without names does not tell an operator which of their edits vanished')

check('the warning says how to keep a change',
  /promote it to the plugin|edit the shipped template and redeploy/.test(seed),
  'naming the loss without naming the remedy leaves the operator stuck')

check('a plugin agent overrides a shipped template',
  /pluginAgents\.get\(t\.id\) \?\? serializeFrontmatter/.test(sync),
  'without this, promoting an sdlc-* agent opens a PR, reports success, and changes nothing — the shipped template still wins at boot')

// Comments are stripped first: this file's own comment EXPLAINS the removed
// line, and a naive search finds that explanation and calls the bug present.
const code = sync.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
check('the old skip-if-shipped line is gone from the CODE',
  !/if \(agentTemplates\.some\(t => t\.id === id\)\) continue/.test(code),
  'that line is exactly what made promote a no-op for the nine agents most likely to be edited')

check('plugin-only agents are still seeded',
  /if \(!shippedIds\.has\(id\)\) await seedAgent\(id, next\)/.test(sync),
  'an agent that exists only in the plugin must still reach the instance')

console.log(failures === 0 ? '\nseeder transparency: all checks passed' : `\nseeder transparency: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
