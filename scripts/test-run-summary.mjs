/**
 * The run list carries what a row reads and not what only a run's page shows.
 *
 * GET /api/runs was 17.6 MB for 234 runs - 11 MB of it every step's full
 * prompt - and /runs re-fetched it every 5 s while anything was live.
 *
 *   node scripts/test-run-summary.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { summariseRun } = await import('../shared/utils/runSummary.ts')

const big = 'x'.repeat(100_000)
const run = {
  id: 'r', workflowSlug: 'w', workflowName: 'Runbook A — Ticket', status: 'failed', ticketKey: 'X-1',
  initialPrompt: `X-1: the headline\n${big}`, startedAt: 1, currentStepIds: [], error: 'boom',
  preflight: { at: 1, checks: [{ name: 'n', level: 'ok', detail: big }] },
  ci: { status: 'failing', checks: [{ name: 'lint', bucket: 'fail' }] },
  steps: [{ stepId: 's', label: 'Fix', agentSlug: 'a', status: 'failed', input: big, output: big, error: 'e', visits: 2, startedAt: 5, completedAt: 9, monitorNote: big, checks: [{ verdict: 'RETRY', note: big }], childRunIds: ['c'] }],
}
const s = summariseRun(run)
assert.ok(JSON.stringify(s).length < 2_000, 'the heavy text is gone')
assert.equal(s.initialPrompt, 'X-1: the headline', 'the first line stays: headlines and the filter read it')
assert.equal(s.preflight, undefined)
const [st] = s.steps
assert.deepEqual([st.input, st.output, st.monitorNote, st.checks], ['', '', undefined, undefined])
assert.deepEqual([st.stepId, st.label, st.status, st.error, st.visits, st.startedAt, st.completedAt, st.childRunIds], ['s', 'Fix', 'failed', 'e', 2, 5, 9, ['c']], 'what rows, restart points and child counts read stays')
assert.deepEqual([s.error, s.ci, s.status, s.ticketKey], [run.error, run.ci, 'failed', 'X-1'], 'run-level fields stay')
assert.ok(run.steps[0].input === big, 'the stored run is not touched')

// The list pages ask for it; the full list stays for scripts that read outputs.
for (const f of ['app/pages/runs/index.vue', 'app/pages/index.vue', 'app/components/RunStack.vue', 'app/components/StepTestPanel.vue']) {
  const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
  assert.match(src, /\/api\/runs\?(tests=1&)?summary=1/, `${f} fetches the summary list`)
}
const api = readFileSync(new URL('../server/api/runs/index.get.ts', import.meta.url), 'utf8')
assert.match(api, /q\.summary === '1' \? list\.map\(summariseRun\) : list/)

console.log('ok - the run list carries what a row reads')
