/**
 * One type scale, and no way back.
 *
 * The app carried 1,023 arbitrary `text-[Npx]` declarations across fourteen
 * distinct sizes, three of which did about three quarters of the work. That is
 * not a hierarchy: a failing run's status, its ticket headline and its timestamp
 * all sat within a pixel of each other, so nothing led and the eye had nowhere
 * to land.
 *
 * Sweeping them was the easy half. The hard half is that nothing stopped the
 * next one being written — an arbitrary size looks perfectly normal in a diff,
 * reviews fine, and renders fine on its own. Only the accumulation is the
 * defect, and no reviewer sees an accumulation. So the rule is mechanical.
 *
 *   node scripts/test-type-scale.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = 'app'
const ARBITRARY = /text-\[\d+px\]/g

/** The scale. Size only — colour lives in .text-label/.text-meta/.text-body. */
const SCALE = ['t-title', 't-head', 't-body', 't-ui', 't-small', 't-label']

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(path)
  }
  return out
}

const files = await walk(ROOT)
assert.ok(files.length > 100, `expected to scan the app, found ${files.length} files`)

// ── 1. no arbitrary font sizes anywhere in the app ───────────────────────────
const offenders = []
for (const file of files) {
  const hits = readFileSync(file, 'utf8').match(ARBITRARY)
  if (hits) offenders.push(`${relative(ROOT, file)} (${hits.length}: ${[...new Set(hits)].join(', ')})`)
}
assert.deepEqual(offenders, [],
  'these use an arbitrary font size instead of the scale. Use t-title / t-head / '
  + 't-body / t-ui / t-small / t-label — they are size only, so they compose with '
  + `the existing colour classes:\n  ${offenders.join('\n  ')}`)

// ── 2. the scale it points at actually exists ────────────────────────────────
// A rule that names classes nobody defined would pass while every element it
// governs rendered at the browser default.
{
  const css = readFileSync('app/assets/css/main.css', 'utf8')
  for (const cls of SCALE) {
    assert.ok(css.includes(`.${cls} {`), `the scale names .${cls}, which main.css does not define`)
  }
}

// ── 3. the scale is used, not merely defined ─────────────────────────────────
// The app already shipped four semantic type classes that nothing adopted —
// `.text-mono` was defined and used in exactly zero files. A scale with no
// consumers is decoration, and this test would otherwise happily protect one.
{
  const body = files.map(f => readFileSync(f, 'utf8')).join('\n')
  for (const cls of SCALE) {
    const uses = body.split(new RegExp(`\\b${cls}\\b`)).length - 1
    assert.ok(uses > 0, `.${cls} is defined and used nowhere — either adopt it or drop it from the scale`)
  }
}

console.log(`type scale: ${files.length} files, 0 arbitrary sizes, ${SCALE.length} classes defined and in use`)
