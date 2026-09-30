/**
 * A budget pause says what granting more buys: what the run spent and on
 * which steps, what is left and what it takes on finished runs of the same
 * workflow, and what stopping keeps.
 *
 * ASECRM-318's pause said "182 min over the 180 min cap" and nothing else,
 * with three short steps left and a finished fix on its branch.
 *
 *   node scripts/test-budget-brief.mjs
 */
import assert from 'node:assert/strict'

const { budgetBrief } = await import('../shared/utils/budgetBrief.ts')

const min = 60_000
const step = (stepId, status, minutes, extra = {}) => ({
  stepId, label: stepId, agentSlug: `a-${stepId}`, status, visits: status === 'pending' ? 0 : 1,
  ...(minutes != null ? { startedAt: 1_000_000, completedAt: 1_000_000 + minutes * min } : {}), ...extra,
})
const run = {
  id: 'r', workflowSlug: 'fix', status: 'paused', startedAt: 0, activeMs: 182 * min,
  budget: { maxMinutes: 180, maxTokens: 8_000_000 },
  usage: { input_tokens: 3_000_000, cached_tokens: 2_000_000, output_tokens: 100_000, usd: 30.41 },
  branch: 'fix/X-1',
  steps: [
    step('intake', 'completed', 5),
    step('fix', 'completed', 120, { visits: 3, usage: { input_tokens: 500, cache_read_input_tokens: 100, output_tokens: 50 } }),
    step('qa', 'completed', 57),
    step('review', 'pending'), step('ship', 'pending'),
  ],
}
const done = (id, review, ship, status = 'completed') => ({
  ...run, id, status, steps: [step('review', 'completed', review), step('ship', 'completed', ship)],
})

// ── Spent, remaining, and an estimate from finished runs ─────────────────────
{
  const b = budgetBrief(run, [run, done('a', 4, 10), done('b', 6, 12), done('c', 8, 14), done('d', 100, 100, 'failed'), { ...done('e', 1, 1), workflowSlug: 'other' }], { minutes: 180, tokens: 8_000_000 }, 0)
  assert.equal(Math.round(b.minutesUsed), 182)
  assert.deepEqual(b.over, ['minutes'], 'over the minutes cap, not the tokens one')
  assert.equal(b.tokensUsed, 1_100_000, 'cached input does not count, as in the cap')
  assert.equal(b.costUsd, 30.41)
  assert.deepEqual(b.spent.map(s => s.label), ['fix', 'qa', 'intake'], 'most expensive first')
  assert.equal(b.spent[0].visits, 3, 'retries show')
  assert.equal(b.spent[0].tokens, 450)
  assert.equal(b.comparedRuns, 3, 'only finished runs of this workflow, not itself, a failed one or another workflow')
  assert.deepEqual(b.remaining.map(r => [r.label, r.typicalMinutes, r.samples]), [['review', 6, 3], ['ship', 12, 3]], 'the median')
  assert.equal(b.estimateMinutes, 18)
  assert.deepEqual(b.keeps, { branch: 'fix/X-1' })
}

// ── Never guessed: a step no finished run has timed leaves no estimate ───────
{
  const b = budgetBrief({ ...run, ci: { pr: 'https://github.com/o/r/pull/1' } }, [done('a', 4, 10)].map(o => ({ ...o, steps: [o.steps[0]] })), { minutes: 180, tokens: 8_000_000 }, 0)
  assert.equal(b.remaining[1].typicalMinutes, null)
  assert.equal(b.estimateMinutes, null)
  assert.equal(b.keeps.pr, 'https://github.com/o/r/pull/1')
}

console.log('ok - a budget pause says what granting more buys')
