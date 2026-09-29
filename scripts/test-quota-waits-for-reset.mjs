/**
 * A run that hits the model's quota waits for the reset the provider stated,
 * and nothing new starts into the spent quota meanwhile.
 *
 * On 2026-09-24 every nightly scan failed on "Request rejected (429) · …
 * Quota resets in 3551s": each failure freed a slot, the next queued scan
 * started into the same wall, and five went in forty seconds.
 *
 *   node scripts/test-quota-waits-for-reset.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'quota-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'quota-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'quota-ws-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '2'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const runner = await import('../server/utils/workflowRunner.ts')
const queue = await import('../server/utils/runQueue.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const { quotaResetAt } = runner

// ── Reading the reset time ───────────────────────────────────────────────────
const now = 1_000_000
const REAL = 'Claude Code returned an error result (success, is_error): API Error: Request rejected (429) · No account can serve this request for claude-opus-5: all 6 accounts are at their quota or rate limit. Quota resets in 3551s.'
assert.equal(quotaResetAt(REAL, now), now + 3551_000 + 60_000, 'the stated reset, plus a minute of margin')
assert.equal(quotaResetAt('API Error: 429 rate limit exceeded', now), now + 15 * 60_000, 'no time stated: fifteen minutes')
assert.equal(quotaResetAt('error_max_turns: no further detail', now), null)
assert.equal(quotaResetAt('Not logged in · Please run /login', now), null, 'a login failure is not a quota')

// ── Through the runner ───────────────────────────────────────────────────────
const wf = { slug: 'q', name: 'Q', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'Intake', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'Scan', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'q.json'), JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))

let spent = true
const calls = []
runner.setAgentCaller(async (slug) => {
  calls.push(slug)
  if (slug === 'agent-b' && spent) throw new Error('API Error: Request rejected (429) · all accounts at their quota. Quota resets in 2s.')
  return `out ${slug}`
})

let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
run = await runner.waitForSettled(run.id, 8000)
assert.equal(run.status, 'paused', `paused, not failed: ${run.error ?? ''}`)
assert.equal(run.question.reason, 'quota')
assert.ok(run.question.resumeAt > Date.now(), 'with the reset time on the record')
assert.match(run.question.text, /resumes on its own at/)
const b = run.steps.find(s => s.stepId === 'b')
assert.equal(b.status, 'pending'); assert.equal(b.visits, 0, 'the refused attempt costs the step no visit')

// Nothing new starts into the spent quota, though a slot is free.
assert.ok(queue.quotaBlocked(), 'the queue is held')
const { run: next, queued } = await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev2' })
assert.ok(queued, 'a new run waits for the reset rather than starting into it')

// At the reset time - brought forward here, as a timer would fire it - both go.
spent = false
const resumed = await runner.resumeQuotaPaused(run.question.resumeAt + 1)
assert.deepEqual(resumed, [run.id])
assert.equal((await runner.waitForSettled(run.id, 8000)).status, 'completed')
assert.deepEqual(calls.filter(c => c === 'agent-a').length >= 1, true)
console.log('ok - a spent quota pauses the run until its reset, and holds the queue')
process.exit(0)
