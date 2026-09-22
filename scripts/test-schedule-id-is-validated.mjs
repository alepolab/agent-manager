// The id a caller sends for a schedule names that schedule's state file, so
// POST /api/schedules refuses one that is not a slug. The exception is an id
// already in the store: this route is the edit and the enable path too, and
// setEnabled round-trips the whole record, so rejecting a legacy id would make
// that schedule impossible to turn off.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../server/api/schedules/index.post.ts', import.meta.url), 'utf8')
const watchSrc = readFileSync(new URL('../server/api/watches/index.post.ts', import.meta.url), 'utf8')

// The rule exists and is the same one the product registry already applies.
assert.match(src, /const ID = \/\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$\//,
  'the schedules route declares no id rule; a caller-supplied id reaches the state path unchecked')
assert.match(watchSrc, /const ID = \/\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$\//,
  'the watches route declares no id rule; a watch id names its state and ticket files the same way')

// It is applied to a CALLER-supplied id only - the generated one is already a
// slug - and the store is consulted before refusing.
for (const [name, text] of [['schedules', src], ['watches', watchSrc]]) {
  assert.match(text, /else if \(!ID\.test\(id\)/,
    `${name}: the id rule is not on the branch that handles a caller-supplied id`)
  assert.match(text, /!ID\.test\(id\) && !\(?await listWatches\(\)\)?\.some|!ID\.test\(id\) && !all\.some/,
    `${name}: the id rule refuses without first checking whether the id is one the store already holds`)
  assert.match(text, /statusCode: 400/, `${name}: a bad id is not a 400`)
}

// The rule itself, exercised the way the route exercises it.
const rule = /^[a-z0-9]+(-[a-z0-9]+)*$/
for (const ok of ['nightly', 'nightly-scan', 'a1', 'scan-2', 'a-b-c']) {
  assert.ok(rule.test(ok), `"${ok}" is a slug the app generates and must be accepted`)
}
for (const bad of ['../../x', '..', '/etc/passwd', 'a/b', 'A', 'a_b', 'a--b', '-a', 'a-', '', 'a.b', 'a\\b']) {
  assert.ok(!rule.test(bad), `"${bad}" must be refused`)
}

// Whatever slugify produces is accepted by the rule, or a create would 400 on
// its own generated id.
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schedule'
for (const name of ['Nightly Scan', '  spaced  out  ', 'Weird!!Name??', 'ALLCAPS', '...', 'a', '2am run']) {
  assert.ok(rule.test(slugify(name)), `slugify("${name}") = "${slugify(name)}" would be refused by the route's own rule`)
}

// And the state path is contained regardless, which is what makes accepting a
// stored legacy id safe.
assert.match(
  readFileSync(new URL('../server/utils/scheduleState.ts', import.meta.url), 'utf8'),
  /resolveClaudeFile\(SCHEDULE_STATE_DIR_NAME, id\)/,
  'the schedule state path no longer goes through the containment guard')

console.log('schedule id is validated: all checks passed')
