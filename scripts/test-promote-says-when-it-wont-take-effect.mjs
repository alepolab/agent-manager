#!/usr/bin/env node
/**
 * `promote` opens a PR moving an agent, skill or command into the
 * alepo-engineering plugin. On an instance with NO plugin installed — which is
 * what the team container reports, "plugin not installed" — the seeder reads
 * the copy shipped in the product instead. So merging that PR changes the team
 * repo and leaves the box exactly as it was: the same local edit gets reverted
 * on the very next boot.
 *
 * The old response was a bare PR link and a green success toast. That is the
 * same defect the seeder warning was just built to fix — an operation that
 * reports success while nothing changes where the operator is looking.
 *
 * The PR still opens, and should: getting the change into the team repo is real
 * work. Only the claim about what it accomplishes needed correcting.
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

const promote = read('server/utils/promote.ts')
const sync = read('server/utils/teamSync.ts')
const ui = read('app/composables/usePromote.ts')

check('pluginInstall is exported for promote to reuse',
  /export async function pluginInstall\(\)/.test(sync),
  'promote must answer "is the plugin installed" the same way the seeder does, not with a second, divergent check')

check('promote reports whether the plugin is installed',
  /pluginInstalled: boolean/.test(promote) && /const installed = \(await pluginInstall\(\)\) !== null/.test(promote),
  'the caller cannot warn about a condition the server never returns')

check('the note names the consequence, not just the condition',
  /will not change behaviour here/.test(promote) && /keep reverting local edits/.test(promote),
  '"no plugin installed" is a fact; "your edit will be reverted anyway" is what the operator needs to act on')

check('the note names both remedies',
  /Install the plugin/.test(promote) && /edit the shipped template/.test(promote),
  'a warning with no way out leaves the operator stuck')

check('the note is absent when the plugin IS installed',
  /installed\s*\n?\s*\? \{\}/.test(promote),
  'warning unconditionally would train the operator to ignore it')

check('the UI does not show a plain success when it will not take effect',
  /will not take effect here/.test(ui) && /color: 'warning'/.test(ui),
  'a green tick over a change that never arrives is the exact failure being fixed')

check('the warning toast does not auto-dismiss',
  /duration: 0/.test(ui),
  'the caveat matters more than the PR link and must not vanish before it is read')

check('the PR link is still offered in both cases',
  (ui.match(/actions: \[openPr\]/g) || []).length === 2,
  'the PR did open and is still useful — the fix is the claim about it, not the action')

console.log(failures === 0 ? '\npromote honesty: all checks passed' : `\npromote honesty: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
