#!/usr/bin/env node
/**
 * The Watches page could create, toggle, poll and delete a watch — but not
 * EDIT one. There was no path to change a query, an interval or a cap after
 * creation, and no path to give an ownerless watch an owner. That last one
 * became blocking the moment the scheduler started refusing ownerless watches:
 * the remedy the log line names ("save it while signed in") had no button.
 *
 * The backend already treated a POST carrying an `id` as an update. Two things
 * were missing: a UI that sends the id, and a POST that does not clobber the
 * fields an edit does not send.
 *
 * That second one is the subtle half. `saveWatch` replaces the record wholesale,
 * so an omitted field is not "left alone" — it is reset to a default. Every
 * default here is a plausible value (interval 300, cap 20, autoRun false), so a
 * partial body would silently retune the watch and nothing would look wrong.
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

const post = read('server/api/watches/index.post.ts')
const page = read('app/pages/watches.vue')

// ── backend: an update must not reset what it was not told about ──────────
const literal = post.slice(post.indexOf('const watch: Watch = {'), post.indexOf('return await saveWatch'))
for (const field of ['intervalSeconds', 'maxConcurrentRuns', 'dailyDispatchCap', 'enabled', 'autoRun', 'query', 'projectDir']) {
  check(`${field} falls back to the stored value`,
    new RegExp(`${field}: body\\.${field} \\?\\? existing\\?\\.${field}`).test(literal),
    `saveWatch replaces the record wholesale, so omitting ${field} resets it rather than leaving it alone`)
}

check('nullish coalescing, not ||',
  !/\|\| existing\?\./.test(literal),
  '`||` discards 0 and false — both meaningful here (a cap of 0, autoRun false)')

check('enabled is no longer forced by identity comparison',
  !/enabled: body\.enabled === true/.test(literal),
  '`body.enabled === true` turns an update that omits `enabled` into a silent disable')

check('the owner is still preserved on update',
  /const createdBy = existing\?\.createdBy \?\? body\.createdBy/.test(post),
  'editing someone else\'s watch must not transfer ownership to the editor')

// ── frontend: the id is what makes it an update ───────────────────────────
check('the form sends the id when editing',
  /\.\.\.\(wasEditing \? \{ id: wasEditing\.id, enabled: wasEditing\.enabled \} : \{\}\)/.test(page),
  'without the id the save creates a SECOND watch under a de-duplicated slug instead of updating this one')

check('there is an edit affordance per watch',
  /@click="openEdit\(watch\)"/.test(page) && /i-lucide-pencil/.test(page),
  'the scheduler tells the operator to save the watch; that instruction needs a button')

check('opening the form for edit prefills every field',
  ['name', 'workflowSlug', 'intervalSeconds', 'maxConcurrentRuns', 'dailyDispatchCap', 'query', 'projectDir', 'autoRun']
    .every(f => new RegExp(`form\\.${f} = watch\\.${f}`).test(page)),
  'an unprefilled field submits its default and silently retunes the watch')

check('creating always clears any prior edit state',
  /function openCreate\(\)[\s\S]{0,120}editing\.value = null/.test(page),
  'reusing the modal means a stale editing ref would turn "New Watch" into an overwrite of the last edited one')

check('the modal says which mode it is in',
  /isEditing \? `Edit \$\{editing\?\.name/.test(page),
  'a create and an edit that look identical is how someone overwrites a watch believing they made a new one')

check('an ownerless watch explains itself in the form',
  /This watch has no owner/.test(page) && /Saving here makes you its owner/.test(page),
  'the operator arrives here from a log line about credentials; the form should close that loop')

console.log(failures === 0 ? '\nwatch editing: all checks passed' : `\nwatch editing: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
