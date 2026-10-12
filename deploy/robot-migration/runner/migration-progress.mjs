#!/usr/bin/env node
// The migration's progress after one delivered folder, for the Teams message the workflow's
// "tell-progress" notify step posts. The branch pusher runs it after a successful push:
//
//   node migration-progress.mjs <before> <after> "<label>"   > progress.json
//
// <before>/<after>: workflow/main before and after this folder's merge (<merge>^1 and <merge>).
// Counts come from the suite's own tools, so they agree with what the workflow skips and ports:
//   scope    every queue item's folder (and include list), plus every folder coverage.csv already
//            tracks (ported before the queue existed), counted by scripts/robot-remaining.mjs
//   ported   docs/coverage.csv rows of those files with a ported* status, at <after>
//   push     rows that are ported* at <after> and were not at <before>
// Prints { entries: [{ title }], progress: {...} }: the title is the message, three lines.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SUITE = process.env.PWMIG_SUITE ?? '/work/ase-crm-testPlaywright-workflow'
const ROBOT = process.env.PWMIG_ROBOT ?? '/work/atddtestsuite_bss'
const QUEUE = process.env.PWMIG_QUEUE ?? '/data/am/claude/workflow-queues/robot-to-playwright-migration.json'
const [before, after, label = ''] = process.argv.slice(2)
if (!before || !after) { console.error('usage: migration-progress.mjs <before> <after> "<label>"'); process.exit(2) }

const git = (...a) => execFileSync('git', ['-C', SUITE, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })

// RFC 4180: quoted fields may hold commas, quotes ("") and newlines (the notes column does).
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else if (c !== '\r') f += c
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  const [head, ...body] = rows
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}
const coverageAt = (rev) => { try { return parseCsv(git('show', `${rev}:docs/coverage.csv`)) } catch { return [] } }
const key = r => `${r.robot_file}\u0000${r.robot_id}\u0000${r.robot_test}`
const PORTED = new Set(['ported', 'ported-bug', 'ported-missing-feature'])
const split = rows => ({
  ported: rows.length,
  pass: rows.filter(r => r.status === 'ported').length,
  bug: rows.filter(r => r.status === 'ported-bug').length,
  missing: rows.filter(r => r.status === 'ported-missing-feature').length,
})

// Scope: every Robot file of every queue item and of every folder coverage.csv tracks, once.
const queue = JSON.parse(readFileSync(QUEUE, 'utf8')).items ?? []
const coverageNow = coverageAt(after)
const folders = new Map()  // "<folder>\0<include>" -> { folder, include }
for (const it of queue) {
  const p = it.parameters ?? {}
  if (p.robotFolder) folders.set(`${p.robotFolder}\u0000${p.include ?? ''}`, { folder: p.robotFolder, include: p.include })
}
for (const r of coverageNow) {
  const folder = r.robot_file.split('/').slice(0, -1).join('/')
  if (folder) folders.set(`${folder}\u0000`, { folder })
}
const scope = new Map()   // "<folder>/<file>" -> number of test cases
for (const p of folders.values()) {
  const args = [`${SUITE}/scripts/robot-remaining.mjs`, ROBOT, p.folder, ...(p.include ? [p.include] : []), '--json', '--flat']
  try {
    const r = JSON.parse(execFileSync('node', args, { encoding: 'utf8', cwd: SUITE, maxBuffer: 16 << 20 }) || '{}')
    for (const f of [...(r.remaining ?? []), ...(r.done ?? [])]) scope.set(`${p.folder}/${f.file}`, f.tests ?? 0)
  } catch { /* a folder robot-remaining cannot read stays out of the total */ }
}
const total = [...scope.values()].reduce((a, b) => a + b, 0)

const now = coverageNow.filter(r => scope.has(r.robot_file))
const was = new Set(coverageAt(before).filter(r => PORTED.has(r.status)).map(key))
const overall = split(now.filter(r => PORTED.has(r.status)))
const push = split(now.filter(r => PORTED.has(r.status) && !was.has(key(r))))

const diffFiles = git('diff', '--name-status', before, after, '--', 'tests/').split('\n').filter(l => /^[AM]\s.*\.spec\.ts$/.test(l))
const fixme = git('diff', before, after, '--', 'tests/').split('\n').filter(l => l.startsWith('+') && l.includes('test.fixme(')).length
const delivered = queue.filter(i => i.status === 'done' || i.status === 'running').length
const sha = git('rev-parse', '--short', after).trim()

const n = x => x.toLocaleString('en-US')
const pct = total ? ((overall.ported / total) * 100).toFixed(1) : '0.0'
const byStatus = s => [s.bug && `${n(s.bug)} @bug`, s.missing && `${n(s.missing)} missing feature`].filter(Boolean)
const title = [
  `This push${label ? `: ${label}` : ''}: ${n(push.ported)} Robot tests ported (${[`${n(push.pass)} pass`, ...byStatus(push)].join(', ')}), ${diffFiles.length} spec files, ${fixme} test.fixme · ${sha}`,
  `Overall: ${n(overall.ported)} of ${n(total)} Robot tests ported (${pct}%)${byStatus(overall).length ? `: ${byStatus(overall).join(', ')}` : ''}; ${n(Math.max(total - overall.ported, 0))} still to port`,
  `Queue: ${delivered} of ${queue.length} folders delivered, ${queue.length - delivered} to go`,
].join('\n')

console.log(JSON.stringify({
  entries: [{ title }],
  progress: { total, overall, push, specFiles: diffFiles.length, fixme, delivered, queued: queue.length, commit: sha, label },
}, null, 2))
