#!/usr/bin/env node
// Adds ui-to-api-optimization queue items for the test folders that are ready: they have specs with browser-driven
// tests left (scripts/ui-remaining.mjs), and the Robot migration has finished every Robot file they come from (no
// pending or running migration item covers them, so the two workflows never edit one folder at once).
//
//   node /opt/pwmig/opt-seed-queue.mjs <suite checkout> <migration queue.json> <optimization queue.json> [--write]
//
// A folder with more than 15 such specs gets one item per 15. The precheck hands each run the next 15 still left.
// Folders already in the optimization queue (any status) are not added again. Without --write it only prints the
// plan. Re-run it as the migration finishes more folders. Order: the two pilots, then catalog, subscriber
// management, inventory, sanity, then the rest, each smallest first.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [suite, migQueueFile, optQueueFile] = process.argv.slice(2)
if (!optQueueFile) { console.error('usage: opt-seed-queue.mjs <suite checkout> <migration queue> <optimization queue> [--write]'); process.exit(2) }
const PER_ITEM = 15
const PILOTS = ['catalog/policies/tax', 'catalog/usage-rating/holidays']
const ORDER = ['catalog/policies', 'catalog/usage-rating', 'catalog/plans', 'catalog/availability-rules', 'catalog',
  'subscriber-management', 'subscriber-operations', 'inventory', 'Sanity_Testcases']

const dirs = (function walk(d) {
  return [d, ...readdirSync(d).filter(f => statSync(join(d, f)).isDirectory()).flatMap(f => walk(join(d, f)))]
})(join(suite, 'tests'))

// spec path -> Robot files it ports
const robotOf = new Map()
const cells = line => { // one CSV line, quotes honoured
  const out = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  return [...out, cur]
}
for (const line of readFileSync(join(suite, 'docs/coverage.csv'), 'utf8').split(/\r?\n/).slice(1)) {
  const [robotFile, , , spec] = cells(line)
  if (!spec) continue
  robotOf.set(spec, [...(robotOf.get(spec) ?? []), robotFile])
}

const mig = JSON.parse(readFileSync(migQueueFile, 'utf8'))
const busy = mig.items.filter(i => i.status === 'pending' || i.status === 'running').map(i => ({
  folder: i.parameters?.robotFolder ?? '',
  files: (i.parameters?.include ?? '').split(',').map(s => s.trim()).filter(Boolean),
}))
const migrating = robotFile => busy.some(b => (robotFile + '/').startsWith(b.folder.replace(/\/?$/, '/'))
  && (!b.files.length || b.files.some(f => robotFile.endsWith('/' + f))))

const opt = JSON.parse(readFileSync(optQueueFile, 'utf8'))
const queued = new Set(opt.items.map(i => i.parameters?.testFolder))

const ready = [], waiting = []
for (const d of dirs) {
  const folder = relative(join(suite, 'tests'), d) || '.'
  if (queued.has(folder)) continue
  const out = JSON.parse(execFileSync('node', ['scripts/ui-remaining.mjs', relative(suite, d), '--json'], { cwd: suite, encoding: 'utf8' }))
  if (!out.remaining.length) continue
  const robots = out.remaining.flatMap(f => robotOf.get(relative(suite, join(d, f))) ?? [])
  const blockedBy = robots.filter(migrating)
  ;(blockedBy.length ? waiting : ready).push({ folder, n: out.remaining.length, blockedBy })
}

const rank = f => {
  const p = PILOTS.indexOf(f.folder)
  if (p >= 0) return p
  const o = ORDER.findIndex(x => f.folder === x || f.folder.startsWith(x + '/'))
  return 10 + (o < 0 ? ORDER.length : o)
}
ready.sort((a, b) => rank(a) - rank(b) || a.n - b.n || a.folder.localeCompare(b.folder))

const items = ready.flatMap(f => {
  const parts = Math.ceil(f.n / PER_ITEM)
  return Array.from({ length: parts }, (_, k) => ({
    prompt: `Optimize tests/${f.folder}${parts > 1 ? ` (part ${k + 1}/${parts})` : ''}: ${f.n} specs with UI tests`,
    parameters: { testFolder: f.folder, laneArea: f.folder.replaceAll('/', '~') },
    status: 'pending',
  }))
})

for (const f of ready) console.log(`ready    ${String(f.n).padStart(3)}  ${f.folder}`)
for (const f of waiting) console.log(`waiting  ${String(f.n).padStart(3)}  ${f.folder}  (migration still on ${[...new Set(f.blockedBy)].slice(0, 2).join(', ')})`)
console.log(`\n${items.length} item(s) for ${ready.length} folder(s); ${waiting.length} folder(s) wait for the migration`)
if (process.argv.includes('--write') && items.length) {
  opt.items.push(...items)
  writeFileSync(optQueueFile, JSON.stringify(opt, null, 2) + '\n')
  console.log(`written to ${optQueueFile}`)
}
