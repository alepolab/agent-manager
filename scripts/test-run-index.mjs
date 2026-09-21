/**
 * The defect this pins: there was no index over runs at all. Answering
 * "which run is CSUP-7516?" meant opening every run's meta.json by hand, and
 * a run resumed after a restart (same runId, a second `updateRunIndex` call)
 * would — without the replace-not-append rule below — leave two rows for one
 * run, which is worse than no index: a reader trusts a row count that is
 * simply wrong. Every row field is read straight off the run record or its
 * meta.json; a field the run never produced must be ABSENT, never a
 * fabricated null or zero standing in for "unknown".
 *
 *   node scripts/test-run-index.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'run-index-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'run-index-runs-'))

const { buildRunIndexRow, updateRunIndex, readRunIndex } = await import('../server/utils/runIndex.ts')
const { resolveClaudePath } = await import('../server/utils/claudeDir.ts')
const { renderRunSummary, runSummaryFrontMatter } = await import('../server/utils/runSummary.ts')

function mkRun(overrides = {}) {
  const startedAt = Date.now() - 3_600_000
  return {
    id: 'run-x',
    workflowSlug: 'csup-to-pr',
    workflowName: 'CSUP: ticket to pull request',
    status: 'completed',
    startedAt,
    endedAt: startedAt + 1_800_000,
    steps: [],
    ...overrides,
  }
}

// ── 1. a second update REPLACES the row, never duplicates it ────────────────
{
  const run = mkRun({ id: 'run-a', ticketKey: 'CSUP-1001', status: 'running', endedAt: undefined })
  await updateRunIndex(run, {})
  let rows = await readRunIndex()
  assert.equal(rows.filter(r => r.runId === 'run-a').length, 1, 'first write produces one row')
  assert.equal(rows.find(r => r.runId === 'run-a').status, 'running')

  // Same run id, later state — the shape a restart or a resumed run produces.
  const finished = { ...run, status: 'completed', endedAt: run.startedAt + 900_000 }
  await updateRunIndex(finished, {})
  rows = await readRunIndex()
  assert.equal(rows.filter(r => r.runId === 'run-a').length, 1, 'second write replaces, does not duplicate')
  assert.equal(rows.find(r => r.runId === 'run-a').status, 'completed', 'the replaced row carries the newer state')
}

// ── 2. a field the run never produced is ABSENT, not null or a guessed zero ──
{
  const bare = mkRun({ id: 'run-b' }) // no ticketKey, no product, no steps, no meta
  const row = await buildRunIndexRow(bare, {})
  for (const key of ['ticket', 'product', 'model', 'costUsd', 'blastRadius', 'verdicts']) {
    assert.ok(!(key in row), `${key} must be absent, not null, when the run never produced it`)
  }
  assert.deepEqual(row.repos, [])
  assert.deepEqual(row.commits, [])
  assert.deepEqual(row.prs, [])
  assert.equal(row.stepCount, 0)
  assert.equal(row.laneKept, false)
  assert.equal(row.recovered, false)

  // meta.fix does carry facts: they must show up, verbatim, never re-derived.
  const withFix = await buildRunIndexRow(mkRun({ id: 'run-b2', ticketKey: 'CSUP-2002' }), {
    fix: { repos: [{ repo: 'alepobilling', pr: 'https://github.com/x/y/pull/9', commits: ['abc123', 'def456'] }] },
  })
  assert.deepEqual(withFix.repos, ['alepobilling'])
  assert.deepEqual(withFix.commits, ['abc123', 'def456'])
  assert.deepEqual(withFix.prs, [{ repo: 'alepobilling', url: 'https://github.com/x/y/pull/9' }])
  assert.equal(withFix.ticket, 'CSUP-2002')
}

// ── 3. a corrupt line is skipped, never fatal to the runs around it ─────────
{
  const path = resolveClaudePath('workflow-runs', 'index.jsonl')
  await mkdir(dirname(path), { recursive: true })
  const good = {
    runId: 'ok-1', workflow: 'csup-to-pr', workflowName: 'CSUP: ticket to pull request',
    status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', activeMinutes: 5,
    repos: [], commits: [], prs: [], stepCount: 1, failedSteps: [],
    artifactCount: 0, artifactBytes: 0, laneKept: false, recovered: false,
  }
  await writeFile(path, `not json at all\n{"runId": "no-close-brace"\n${JSON.stringify(good)}\n`)
  const rows = await readRunIndex()
  assert.equal(rows.length, 1, 'the two corrupt lines are skipped, not fatal')
  assert.equal(rows[0].runId, 'ok-1')
}

// ── 4. the RUN-SUMMARY.md front matter parses and carries ticket + PRs ──────
{
  const run = mkRun({ id: 'run-c', ticketKey: 'CSUP-7524' })
  const meta = { fix: { repos: [{ repo: 'alepobilling', pr: 'https://github.com/x/y/pull/9', commits: ['abc123'] }] } }

  const fm = runSummaryFrontMatter(run, meta)
  assert.ok(fm.startsWith('---'), 'front matter opens the fence')
  assert.ok(fm.trim().endsWith('---'), 'front matter closes the fence')
  assert.ok(fm.includes(`ticket: ${JSON.stringify('CSUP-7524')}`))
  assert.ok(fm.includes('repo: "alepobilling"') && fm.includes('url: "https://github.com/x/y/pull/9"'))
  assert.ok(fm.includes('- "abc123"'), 'commits are listed')
  assert.ok(!fm.includes('blast_radius'), 'a blast radius the run never classified is absent, not null')

  // The rendered page opens with it, and the human-readable headline still follows.
  const rendered = renderRunSummary(run, meta)
  assert.ok(rendered.startsWith('---\n'), 'the page opens with the machine-readable block')
  assert.ok(rendered.includes(`ticket: ${JSON.stringify('CSUP-7524')}`))
  const afterFrontMatter = rendered.split('\n---\n').pop()
  assert.ok(/^\n*# CSUP-7524/.test(afterFrontMatter), 'the prose body still starts with the ticket heading')
}

console.log('ok - the run index replaces rows instead of duplicating them, never fabricates an absent field, survives a corrupt line, and the summary front matter carries the ticket and PRs')
