#!/usr/bin/env node
// The migration's progress after one delivered folder, for the Teams message the workflow's
// "tell-progress" notify step posts. The branch pusher runs it after a successful push:
//
//   node migration-progress.mjs <before> <after> "<robotFolder>" ["<include>"]   > progress.json
//
// <before>/<after>: workflow/main before and after this folder's merge (<merge>^1 and <merge>).
// Every number comes from the files and tools the porting skills keep and rely on, never from a
// count of our own:
//   docs/coverage.csv, read through scripts/coverage-summary.mjs (one row per Robot test, never
//     deleted; done = ported + ported-bug + ported-missing-feature, out of all rows but excluded),
//     at <after>, at <before> (this push = the difference) and for this folder;
//   docs/run-status.md: this folder's verification status, at <after>;
//   scripts/robot-remaining.mjs: Robot tests of queued folders that coverage.csv has no row for yet.
// Prints { entries: [{ title }], progress: {...} }: the title is the message.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SUITE = process.env.PWMIG_SUITE ?? '/work/ase-crm-testPlaywright-workflow'
const ROBOT = process.env.PWMIG_ROBOT ?? '/work/atddtestsuite_bss'
const QUEUE = process.env.PWMIG_QUEUE ?? '/data/am/claude/workflow-queues/robot-to-playwright-migration.json'
const [before, after, folder = '', include = ''] = process.argv.slice(2)
if (!before || !after || !folder) { console.error('usage: migration-progress.mjs <before> <after> "<robotFolder>" ["<include>"]'); process.exit(2) }

const git = (...a) => execFileSync('git', ['-C', SUITE, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const show = (rev, path) => { try { return git('show', `${rev}:${path}`) } catch { return null } }
const warnings = []

// coverage-summary.mjs on coverage.csv as of <rev>, from a copy in this container's temp dir. Its
// markdown table is read by its own header, so a column it adds or moves does not shift ours.
// `--folder` always comes first, '' for no filter: without it the script skips its first argument
// and reads the working tree's coverage.csv instead of the file it was given.
const tmp = mkdtempSync(join(tmpdir(), 'pwmig-progress-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
function summary(rev, prefix = '') {
  const csv = show(rev, 'docs/coverage.csv')
  if (csv === null) return null
  const file = join(tmp, `coverage-${rev.replace(/[^\w]/g, '_')}.csv`)
  writeFileSync(file, csv)
  let out
  try {
    out = execFileSync('node', ['scripts/coverage-summary.mjs', '--folder', prefix, file],
      { cwd: SUITE, encoding: 'utf8', maxBuffer: 16 << 20 })
  } catch (e) {   // exit 1 = it found problems (duplicate rows, unknown statuses); the table is still printed
    out = String(e.stdout ?? '')
    const n = out.match(/(\d+) problem\(s\)/)?.[1]
    if (n && rev === after && !prefix) warnings.push(`coverage-summary reports ${n} problem(s) in coverage.csv`)
  }
  const lines = out.split('\n').filter(l => l.startsWith('|'))
  const head = lines[0]?.split('|').slice(1, -1).map(s => s.trim()) ?? []
  const row = lines.find(l => l.startsWith('| **total**'))
  if (!row) return null
  const cells = row.split('|').slice(1, -1).map(s => s.trim())
  const t = Object.fromEntries(head.map((h, i) => [h, parseInt(cells[i], 10) || 0]))
  // coverage-summary's own short names: ported, p-bug, p-missing, analysed, a-bug, not-avail, blocked, todo, excluded
  const done = t['ported'] + t['p-bug'] + t['p-missing']
  return { ...t, done, inScope: t.total - t.excluded, pct: cells[head.indexOf('done %')] ?? '' }
}

const now = summary(after)
if (!now) { console.error('coverage-summary.mjs gave no total for coverage.csv at ' + after); process.exit(1) }
const was = summary(before) ?? Object.fromEntries(Object.keys(now).map(k => [k, 0]))
const d = k => (now[k] ?? 0) - (was[k] ?? 0)
// This folder, or just its included files: coverage-summary's --folder is a prefix of robot_file.
const files = include.split(',').map(f => f.trim()).filter(Boolean)
const prefixes = files.length ? files.map(f => `${folder}/${f}`) : [folder]
const here = prefixes.map(x => summary(after, x)).filter(Boolean).reduce((a, t) => a
  ? Object.fromEntries(Object.keys(a).map(k => [k, typeof a[k] === 'number' ? a[k] + (t[k] ?? 0) : a[k]]))
  : t, null)
if (here) here.pct = here.inScope ? `${Math.round((100 * here.done) / here.inScope)}%` : '0%'

// run-status.md: this folder's rows. Folder runs are "<folder>" or "<folder> (batch …)"; file runs
// are "<folder>/<file without .robot>".
const names = files.length ? files.map(f => `${folder}/${f.replace(/\.robot$/, '')}`) : [folder]
const status = (show(after, 'docs/run-status.md') ?? '').split('\n')
  .filter(l => l.startsWith('|')).map(l => l.split('|').slice(1, -1).map(s => s.trim()))
  .filter(c => names.some(nm => c[0] === nm || c[0].startsWith(`${nm} (`))).map(c => c[5]).filter(Boolean)
const runStatus = status.length ? [...new Set(status)].join('; ') : 'no row in run-status.md'

// Queued Robot tests that coverage.csv has no row for yet: robot-remaining's tests minus rows.
const queue = JSON.parse(readFileSync(QUEUE, 'utf8')).items ?? []
let notStarted = 0, notStartedFolders = 0
for (const it of queue) {
  const p = it.parameters ?? {}
  if (!p.robotFolder) continue
  try {
    const r = JSON.parse(execFileSync('node', ['scripts/robot-remaining.mjs', ROBOT, p.robotFolder, ...(p.include ? [p.include] : []), '--json', '--flat'],
      { cwd: SUITE, encoding: 'utf8', maxBuffer: 16 << 20 }) || '{}')
    const missing = (r.remaining ?? []).reduce((a, f) => a + Math.max((f.tests ?? 0) - (f.rows ?? 0), 0), 0)
    if (missing) { notStarted += missing; notStartedFolders++ }
  } catch { warnings.push(`robot-remaining could not read ${p.robotFolder}`) }
}

const specFiles = git('diff', '--name-status', before, after, '--', 'tests/').split('\n').filter(l => /^[AM]\s.*\.spec\.ts$/.test(l)).length
const fixme = git('diff', before, after, '--', 'tests/').split('\n').filter(l => l.startsWith('+') && l.includes('test.fixme(')).length
const delivered = queue.filter(i => i.status === 'done' || i.status === 'running').length
const sha = git('rev-parse', '--short', after).trim()

const n = x => x.toLocaleString('en-US')
const sgn = x => (x > 0 ? `+${n(x)}` : n(x))
const parts = (t, f) => [
  [`${f(t['ported'])} pass`, true], [`${f(t['p-bug'])} @bug`, t['p-bug']], [`${f(t['p-missing'])} missing feature`, t['p-missing']],
].filter(([, show]) => show).map(([s]) => s)
const delta = { ported: d('ported'), 'p-bug': d('p-bug'), 'p-missing': d('p-missing') }
const otherDelta = [['blocked', 'blocked'], ['excluded', 'excluded'], ['not-avail', 'not available'], ['todo', 'todo']]
  .filter(([k]) => d(k)).map(([k, w]) => `${sgn(d(k))} ${w}`)
const wholeTotal = now.inScope + notStarted
const title = [
  `This push: ${folder}${include ? ` (${include})` : ''} · ${sha}: ${sgn(d('done'))} Robot tests done (${parts(delta, sgn).join(', ')})${otherDelta.length ? `; ${otherDelta.join(', ')}` : ''}; ${specFiles} spec files, ${fixme} test.fixme`,
  here ? `This folder: ${n(here.done)} of ${n(here.inScope)} done (${here.pct}), ${n(here.todo)} todo; run status: ${runStatus}` : `This folder: run status: ${runStatus}`,
  `coverage.csv: ${n(now.done)} of ${n(now.inScope)} tracked Robot tests done (${now.pct}): ${parts(now, n).join(', ')}; ${n(now.todo)} todo, ${n(now.blocked)} blocked, ${n(now.excluded)} excluded`,
  `Whole migration: ${n(now.done)} of ${n(wholeTotal)} (${wholeTotal ? ((100 * now.done) / wholeTotal).toFixed(1) : '0.0'}%), with ${n(notStarted)} Robot tests in ${notStartedFolders} queued folders not in coverage.csv yet. Queue: ${delivered} of ${queue.length} folders delivered`,
  ...warnings.map(w => `Note: ${w}`),
].join('\n')

console.log(JSON.stringify({
  entries: [{ title }],
  progress: { commit: sha, folder, include, coverage: now, before: was, folderCoverage: here, runStatus, notStarted, notStartedFolders, specFiles, fixme, delivered, queued: queue.length, warnings: warnings.join("; ") },
}, null, 2))
