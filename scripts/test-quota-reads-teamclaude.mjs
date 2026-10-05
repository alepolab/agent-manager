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
import { readFileSync } from 'node:fs'

const { quotaResetAt, quotaResetStated } = await import('../server/utils/workflowRunner.ts')
const now = Date.UTC(2026, 9, 2, 4, 0, 0)
const TC = 'API Error: Server is temporarily limiting requests (not your usage limit) · No account can serve this request for claude-opus-5: all 3 accounts are at their quota or rate limit. Quota resets in 32m.'
assert.equal(quotaResetAt(TC, now), now + 32 * 60_000 + 60_000, '32m, plus the minute of margin')
assert.equal(quotaResetAt(TC.replace('32m', '1h15m'), now), now + 75 * 60_000 + 60_000, 'hours and minutes')
assert.equal(quotaResetAt(TC.replace('32m', '2h'), now), now + 120 * 60_000 + 60_000, 'hours alone')
assert.ok(quotaResetStated(TC), 'a stated reset')
assert.equal(quotaResetAt('429 rate limit', now), now + 15 * 60_000, 'nothing stated: the 15-minute guess')
assert.ok(!quotaResetStated('429 rate limit'))
assert.equal(quotaResetAt('quota exceeded, resets in 90s', now), now + 90_000 + 60_000, 'seconds still read')

const src = readFileSync(new URL('../server/utils/workflowRunner.ts', import.meta.url), 'utf8')
assert.match(src, /reason: 'quota', resumeAt: until, resetStated: stated/, 'the paused run records whether its time was stated')
const resume = src.slice(src.indexOf('export async function resumeQuotaPaused'))
assert.ok(resume.indexOf('blockForQuota(now + QUOTA_PROBE_MS)') < resume.indexOf('drainRunQueue('), 'a probe shuts the queue before it could drain')
console.log('ok - TeamClaude reset times are read, and a probe starts nothing new')
