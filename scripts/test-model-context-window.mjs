/**
 * Self-check for the context-window half of the two model registries.
 *
 * The `/cli` context panel used to report 200,000 tokens for every model
 * because both registries said so and nothing ever read them. These asserts
 * pin the measured numbers and the alias/full-id/`[1m]` resolution paths that
 * feed them, plus the agreement between the frontend and server tables - the
 * two files cannot import each other, so drift is only catchable here.
 *
 * Windows measured 2026-09-10 with agent SDK 0.3.263, reading
 * `modelUsage[<key>].contextWindow` from
 * `claude -p --model <alias> --output-format json`.
 *
 *   node scripts/test-model-context-window.mjs
 */
import assert from 'node:assert/strict'

const S = await import('../server/utils/models.ts')
const F = await import('../app/utils/models.ts')
const N = await import('../server/utils/messageNormalizer.ts')

const usage = (contextWindow, n = 1) => ({
  inputTokens: n, outputTokens: n, cacheReadInputTokens: n, cacheCreationInputTokens: n, contextWindow,
})
const windowOf = (modelUsage) => {
  const complete = N.normalizeSDKMessage({ type: 'result', modelUsage }, 's')
    .find((m) => m.kind === 'complete')
  return complete.metadata.aggregatedUsage.contextWindow
}

const MEASURED = {
  fable: 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 200_000,
}

// ── 1. Aliases report their measured window, on both sides ────────────────
for (const [alias, expected] of Object.entries(MEASURED)) {
  assert.equal(S.getModelContextWindow(alias), expected,
    `server: alias '${alias}' resolves to ${expected}`)
  assert.equal(F.getModelContextWindow(alias), expected,
    `frontend: alias '${alias}' resolves to ${expected}`)
}

// ── 2. Full ids resolve to the same window as the alias pointing at them ──
for (const [alias, expected] of Object.entries(MEASURED)) {
  const id = S.MODEL_ALIAS[alias]
  assert.equal(S.getModelContextWindow(id), expected,
    `server: full id '${id}' resolves to ${expected}`)
}

// ── 3. A `[1m]` suffix is the same model ──────────────────────────────────
// The SDK's init message reports "claude-opus-5[1m]" whenever settings.json
// asks for "opus[1m]", and agentCaller records that string verbatim. Before
// the suffix was stripped every such run fell through to the defaults - a
// wrong window AND, via the same resolver, sonnet-4-6's prices.
assert.equal(S.getModelContextWindow('claude-opus-5[1m]'), 1_000_000,
  'a [1m] full id keeps its 1M window')
assert.equal(S.getModelContextWindow('opus[1m]'), 1_000_000,
  'a [1m] alias keeps its 1M window')
assert.deepEqual(
  S.getModelPricing('claude-sonnet-4-6[1m]'),
  S.getModelPricing('claude-sonnet-4-6'),
  'a [1m] id is priced as the model it is, not as the unknown-model default'
)

// ── 4. An unknown model falls back, and the fallback is the small window ──
assert.equal(S.getModelContextWindow('claude-made-up-model-nobody-shipped'),
  S.DEFAULT_CONTEXT_WINDOW, 'unknown model falls back to DEFAULT_CONTEXT_WINDOW')
assert.equal(S.getModelContextWindow(undefined), S.DEFAULT_CONTEXT_WINDOW,
  'no model at all falls back too')
assert.equal(S.DEFAULT_CONTEXT_WINDOW, 200_000,
  'the fallback is the smallest window we ship: overstating usage is a visible '
  + 'false alarm, understating it hides an imminent compaction')

// ── 5. Every declared model has a window, and the tables agree ────────────
for (const id of S.MODEL_IDS) {
  const window = S.SERVER_MODEL_META[id].contextWindow
  assert.ok(Number.isInteger(window) && window > 0,
    `server: '${id}' declares a positive contextWindow (got ${window})`)
}
for (const alias of F.MODEL_IDS) {
  assert.equal(
    F.MODEL_META[alias].contextWindow,
    S.SERVER_MODEL_META[S.MODEL_ALIAS[alias]].contextWindow,
    `the two registries agree on '${alias}' (${S.MODEL_ALIAS[alias]})`
  )
}

// ── 6. claude-fable-5 has a row ───────────────────────────────────────────
// No alias points at it, but it is the second most common model in the local
// transcripts, so a reloaded session on it must not fall back to 200k.
assert.equal(S.getModelContextWindow('claude-fable-5'), 1_000_000,
  'claude-fable-5 resolves, even though no alias reaches it')

// ── 7. The normalizer takes the largest window, whatever the key order ────
// A turn that delegates to a haiku subagent reports both models. Object.values
// order is not the main model's, so last-wins used to report 200k for a 1M
// session.
const main = 'claude-opus-5'
const sub = 'claude-haiku-4-5-20251001'
assert.equal(windowOf({ [main]: usage(1_000_000), [sub]: usage(200_000) }), 1_000_000,
  'main model first: the 1M window wins')
assert.equal(windowOf({ [sub]: usage(200_000), [main]: usage(1_000_000) }), 1_000_000,
  'subagent first: the 1M window still wins - order-independent')
assert.equal(windowOf({ [sub]: usage(200_000) }), 200_000,
  'a haiku-only turn reports haiku\'s real 200k, not a 1M floor')
assert.equal(windowOf({}), S.DEFAULT_CONTEXT_WINDOW,
  'no modelUsage at all falls back to the default')
assert.equal(windowOf({ 'claude-opus-5[1m]': usage(1_000_000) }), 1_000_000,
  'the normalizer reads the SDK\'s number and never parses the model id')

// Token sums still add across every model - the max change must not have
// disturbed the aggregation beside it.
{
  const complete = N.normalizeSDKMessage(
    { type: 'result', modelUsage: { [main]: usage(1_000_000, 10), [sub]: usage(200_000, 5) } },
    's'
  ).find((m) => m.kind === 'complete')
  const agg = complete.metadata.aggregatedUsage
  assert.equal(agg.input, 15, 'input tokens sum across both models')
  assert.equal(agg.output, 15, 'output tokens sum across both models')
  assert.equal(agg.cacheRead, 15, 'cache-read tokens sum across both models')
  assert.equal(agg.cacheCreation, 15, 'cache-creation tokens sum across both models')
}

console.log('ok - model context windows')
