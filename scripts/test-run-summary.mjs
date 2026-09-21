/**
 * A finished run leaves one page a person can read.
 *
 *   node scripts/test-run-summary.mjs
 *
 * The thing this pins is the headline. A run can reach its last step, be
 * recorded `completed`, and have shipped absolutely nothing — and a summary
 * that calls that success is worse than no summary, because someone will quote
 * it. The pull request, not the status word, decides what the first line says.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'summary-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'summary-runs-'))

const { renderRunSummary } = await import('../server/utils/runSummary.ts')

const step = (label, status, output, extra = {}) => ({
  stepId: label.toLowerCase().replace(/\W+/g, '-'),
  label, agentSlug: 'sdlc-worker', status, input: '', output,
  startedAt: 1_000_000, completedAt: 1_000_000 + 9 * 60_000, visits: 1, ...extra,
})

const base = {
  id: 'run-1', workflowSlug: 'csup-to-pr', workflowName: 'CSUP: ticket to pull request',
  status: 'completed', autoRun: true, watch: 'direct-invocation',
  ticketKey: 'CSUP-7524',
  initialPrompt: 'CSUP-7524: fees are never closed after the charge\nURL: https://example.invalid',
  startedAt: 1_000_000, endedAt: 1_000_000 + 60 * 60_000,
  branch: 'fix/CSUP-7524-run-1',
  steps: [
    step('Read the ticket', 'completed', '## Reproduced the fault on a clean stack\nlong evidence follows'),
    step('Write the fix', 'completed', '`git commit` 3 files'),
    step('Deploy to prod', 'skipped', '', { skipReason: 'no deployable change' }),
  ],
}

// Shipped nothing, but every step passed: the headline must not read as success.
const nothing = renderRunSummary(base, {})
assert.ok(nothing.includes('# CSUP-7524 — what this run did'), 'the ticket names the page')
assert.ok(/without opening a pull request/.test(nothing.split('\n')[2]),
  'a run that shipped nothing must say so in the first line, whatever its status word says')
assert.ok(nothing.includes('| Pull request | none |'))

// The same run with a PR recorded reads as work waiting for a human.
const shipped = renderRunSummary(base, { fix: { repos: [{ repo: 'alepobilling', pr: 'https://github.com/x/y/pull/9' }] } })
assert.ok(shipped.includes('waiting for review'), 'a PR is the headline when there is one')
assert.ok(shipped.includes('[alepobilling](https://github.com/x/y/pull/9)'))

// Plain words, not pipeline vocabulary, and the agent's own first line quoted.
assert.ok(shipped.includes('**1. Read the ticket** — done'), 'statuses are plain words')
assert.ok(shipped.includes('> Reproduced the fault on a clean stack'), 'the step gist is its first real line, markdown stripped')
assert.ok(shipped.includes('**3. Deploy to prod** — not needed'), '"skipped" means nothing to a reader')
assert.ok(shipped.includes('Skipped because: no deployable change'))
assert.ok(!/\bsdlc-worker\b/.test(shipped), 'agent slugs are internal vocabulary and must not leak into the page')

// A failure names the step it died on.
const failed = renderRunSummary(
  { ...base, status: 'failed', steps: [step('Write the fix', 'failed', '', { error: 'the build never compiled' })] },
  {},
)
assert.ok(failed.includes('stopped at "Write the fix"'), 'a reader must learn where it stopped without opening a file')

console.log('ok - the run summary reads like a person wrote it, and never overstates the outcome')
