/**
 * A quota message that says when it resets is waited out, not retried every
 * fifteen minutes; and a retry on a guessed time starts nothing new.
 *
 * TeamClaude reports "Quota resets in 32m." for a spent pool of accounts.
 * Read as no reset time, the runs retried every quarter-hour and each retry
 * drained the queue: ASECRM-283 and 284 started into the spent quota and
 * paused at Ticket Intake.
 *
 *   node scripts/test-quota-reads-teamclaude.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'quota-tc-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'quota-tc-artifacts-'))
process.env.AGENT_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'quota-tc-ws-'))
process.env.AGENT_MAX_CONCURRENT_PIPELINES = '2'
mkdirSync(join(process.env.CLAUDE_DIR, 'workflows'), { recursive: true })

const runner = await import('../server/utils/workflowRunner.ts')
const queue = await import('../server/utils/runQueue.ts')
const store = await import('../server/utils/workflowRunStore.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const { quotaResetAt, quotaResetStated } = runner
const now = Date.UTC(2026, 9, 2, 4, 0, 0)
const TC = 'API Error: Server is temporarily limiting requests (not your usage limit) · No account can serve this request for claude-opus-5: all 3 accounts are at their quota or rate limit. Quota resets in 32m.'
assert.equal(quotaResetAt(TC, now), now + 32 * 60_000 + 60_000, '32m, plus the minute of margin')
assert.equal(quotaResetAt(TC.replace('32m', '1h15m'), now), now + 75 * 60_000 + 60_000, 'hours and minutes')
assert.equal(quotaResetAt(TC.replace('32m', '2h'), now), now + 120 * 60_000 + 60_000, 'hours alone')
assert.ok(quotaResetStated(TC), 'a stated reset')
assert.equal(quotaResetAt('429 rate limit', now), now + 15 * 60_000, 'nothing stated: the 15-minute guess')
assert.ok(!quotaResetStated('429 rate limit'))
assert.equal(quotaResetAt('quota exceeded, resets in 90s', now), now + 90_000 + 60_000, 'seconds still read')

// Every form a reset is said in: the time read, and `stated` true exactly when
// the time came from the message. They were two regexes, and "30 minutes" read
// as stated while its time fell to the 15-minute guess - so the probe guard
// stood down and the queue drained into a quota spent for hours.
const M = 60_000
for (const [text, wait, stated] of [
  ['Quota resets in 32m.', 32 * M, true],
  ['Quota resets in 1h15m.', 75 * M, true],
  ['Quota resets in 2h', 120 * M, true],
  ['429 quota exceeded. Quota resets in 30 minutes', 30 * M, true],
  ['429 quota exceeded. Quota resets in 3 hours', 180 * M, true],
  ['429 quota exceeded. Quota resets in 1 hour 5 minutes', 65 * M, true],
  ['429 quota exceeded. Quota resets in 2 hours and 10 minutes.', 130 * M, true],
  ['429 quota exceeded. Quota resets in 1 min', 1 * M, true],
  ['quota exceeded, resets in 90 seconds', 90_000, true],
  ['429 rate limit, retry-after: 120', 120_000, true],
  ['429 quota exceeded. Quota resets in 3 days', 15 * M - M, false],
  ['429 rate limit', 15 * M - M, false],
]) {
  const msg = text.startsWith('Quota') ? TC.replace('Quota resets in 32m.', text) : text
  assert.equal(quotaResetAt(msg, now), now + wait + M, `"${text}": the wait`)
  assert.equal(quotaResetStated(msg, now), stated, `"${text}": ${stated ? 'stated' : 'a guess'}, agreeing with the time`)
}

// ── A retry on a guessed time is a probe: it starts nothing new ─────────────
// Driven through the runner, not read off the source: a run pauses on a quota
// error that names no reset, another run queues behind it, and the retry at
// the guessed time resumes the first and leaves the second queued.
const wf = { slug: 'probe', name: 'Probe', steps: [
  { id: 'a', agentSlug: 'agent-a', label: 'Intake', next: ['b'] },
  { id: 'b', agentSlug: 'agent-b', label: 'Scan', next: [] },
] }
writeFileSync(join(process.env.CLAUDE_DIR, 'workflows', 'probe.json'), JSON.stringify({ name: wf.name, description: '', steps: wf.steps, createdAt: new Date().toISOString() }))
let reply = 'API Error: 429 rate limit'
const started = []
runner.setAgentCaller(async (slug, input, dir) => {
  if (slug === 'agent-a') started.push(slug)
  if (slug === 'agent-b' && reply) throw new Error(reply)
  return `out ${slug}`
})
let run = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev1' })).run
run = await runner.waitForSettled(run.id, 8000)
assert.equal(run.question?.reason, 'quota', `paused on the quota: ${run.error ?? ''}`)
assert.equal(run.question.resetStated, false, 'the record says its reset time is a guess')
const behind = (await runner.startOrQueue({ workflow: wf, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true, startedBy: 'dev2' }))
assert.ok(behind.queued, 'a run arriving now waits')
const before = started.length
// The guessed time passes: on the record, as the clock every reader uses sees
// it, and for the timer that fires the retry.
const at = run.question.resumeAt
const saved = await store.getRun(run.id)
saved.question.resumeAt = Date.now() - 1
await store.saveRun(saved)
const resumed = await runner.resumeQuotaPaused(at + 1)
assert.deepEqual(resumed, [run.id], 'the guessed time passing resumes the paused run, as a probe')
await runner.waitForSettled(run.id, 8000)
assert.equal((await store.getRun(behind.run.id)).status, 'queued',
  'THE REGRESSION: the probe drained the queue, starting a run into a quota still spent (ASECRM-283, 284)')
assert.equal(started.length, before, 'nothing new reached an agent')
assert.ok(queue.quotaBlocked(), 'the queue stays shut for one more window')

console.log('ok - TeamClaude reset times are read, and a probe starts nothing new')
process.exit(0)
