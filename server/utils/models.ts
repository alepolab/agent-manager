/**
 * Canonical model configuration for the server side.
 *
 * Keep in sync conceptually with `app/utils/models.ts` (the frontend twin).
 * The server cannot import from `app/` (different module context), so this
 * file mirrors the model list and adds server-specific concerns (pricing).
 *
 * Source: https://www.anthropic.com/pricing
 */

// 'claude-fable-5' has no alias pointing at it, but it is the second most
// common model in the local transcripts (3,308 entries against 122 for
// claude-fable-5-1, 2026-09-10), so a session on it needs a row to resolve to.
export const MODEL_IDS = ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const
export type ModelId = (typeof MODEL_IDS)[number]

/**
 * Map from the short "tier" alias (used in agent frontmatter) to the full API
 * model id.
 *
 * Verified 2026-09-10 with agent SDK 0.3.263, reading the `modelUsage` key of
 * `claude -p --model <alias> --output-format json`:
 *   fable  -> claude-fable-5-1
 *   opus   -> claude-opus-5
 *   sonnet -> claude-sonnet-5
 *   haiku  -> claude-haiku-4-5-20251001
 *
 * These full ids move whenever a new model snapshot is released, without
 * notice - the alias ('sonnet' | 'opus' | 'haiku') is the stable thing to
 * actually pass to the SDK (see agentCaller.ts, which does exactly that and
 * does NOT consume this map). This table exists to RECORD what ran, not to
 * be fed back into `query()`'s `options.model` - re-verify before doing
 * that; a previous (now corrected) version of this map held ids
 * ('claude-opus-4' etc.) that the SDK rejected outright.
 */
export const MODEL_ALIAS: Record<string, ModelId> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
}

/**
 * Named constants for model alias keys (the short strings used in agent frontmatter).
 * Use these for any server-side string comparisons or defaults instead of raw literals:
 *
 *   // ✅ do this
 *   import { MODEL_ALIAS_KEY, DEFAULT_MODEL_ALIAS } from './models'
 *   if (model === MODEL_ALIAS_KEY.SONNET) { ... }
 *   models: Object.values(MODEL_ALIAS_KEY)
 *
 *   // ❌ never this
 *   if (model === 'sonnet') { ... }
 *   models: ['sonnet', 'opus', 'haiku']
 */
export const MODEL_ALIAS_KEY = {
  FABLE: 'fable' as const,
  OPUS: 'opus' as const,
  SONNET: 'sonnet' as const,
  HAIKU: 'haiku' as const,
}

/** Default model alias used when none is specified */
export const DEFAULT_MODEL_ALIAS = MODEL_ALIAS_KEY.SONNET


export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number
  /** USD per 1M output tokens */
  output: number
  /** USD per 1M cache-read tokens */
  cached: number
}

export interface ServerModelMeta {
  id: ModelId
  /** Max context window in tokens */
  contextWindow: number
  /** Absent when the list price is not known here: cost reports then mark the
   *  step unpriced rather than inventing a number. */
  pricing?: ModelPricing
}

/**
 * Context windows measured 2026-09-10 with agent SDK 0.3.263, reading
 * `modelUsage[<key>].contextWindow` from
 * `claude -p --model <alias> --output-format json`: fable/opus/sonnet all
 * report 1,000,000 and haiku 200,000. The 4-6 ids and claude-fable-5 carry
 * Anthropic's published 1M figure - no alias reaches them, so they cannot be
 * measured the same way. The SDK's `context-1m-2025-08-07` beta is
 * deliberately unused: the plain aliases already report 1M without it.
 */
export const SERVER_MODEL_META: Record<ModelId, ServerModelMeta> = {
  // Pricing deliberately absent: not published where this table can cite it.
  'claude-fable-5-1': {
    id: 'claude-fable-5-1',
    contextWindow: 1_000_000,
  },
  'claude-fable-5': {
    id: 'claude-fable-5',
    contextWindow: 1_000_000,
  },
  // No list price cited here for the Claude 5 ids either; steps on them are
  // costed from the SDK's own figure (usage.usd), never from a guessed table.
  'claude-opus-5': { id: 'claude-opus-5', contextWindow: 1_000_000 },
  'claude-sonnet-5': { id: 'claude-sonnet-5', contextWindow: 1_000_000 },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    contextWindow: 1_000_000,
    pricing: { input: 15.0, output: 75.0, cached: 1.5 },
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    contextWindow: 1_000_000,
    pricing: { input: 3.0, output: 15.0, cached: 0.3 },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    pricing: { input: 0.8, output: 4.0, cached: 0.08 },
  },
}

/** Fallback pricing when model is unknown */
export const DEFAULT_PRICING: ModelPricing = SERVER_MODEL_META['claude-sonnet-4-6'].pricing!

/**
 * Default context window when model is unknown. Deliberately the smallest
 * window we ship rather than the largest: understating it overstates usage,
 * which shows up as an early-filling bar, where overstating it would hide an
 * imminent compaction until it happened.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Resolve a model string (either a full id like "claude-sonnet-4" or an alias
 * like "sonnet") to the canonical ServerModelMeta. Returns undefined if unknown.
 */
export function resolveModelMeta(model: string | undefined): ServerModelMeta | undefined {
  if (!model) return undefined
  // A `[1m]` suffix selects the long-context variant of the same model, so it
  // resolves to the same row. Such strings reach here for real: the SDK's init
  // message reports "claude-opus-5[1m]" whenever ~/.claude/settings.json asks
  // for "opus[1m]", and agentCaller records that string verbatim.
  const base = model.endsWith('[1m]') ? model.slice(0, -4) : model
  // Try full id first
  if (SERVER_MODEL_META[base as ModelId]) return SERVER_MODEL_META[base as ModelId]
  // Try alias
  const aliased = MODEL_ALIAS[base]
  if (aliased) return SERVER_MODEL_META[aliased]
  return undefined
}

/**
 * Return the pricing for a model string. Falls back to DEFAULT_PRICING.
 */
export function getModelPricing(model: string | undefined): ModelPricing {
  return resolveModelMeta(model)?.pricing ?? DEFAULT_PRICING
}

/**
 * Return the context window for a model string. Falls back to DEFAULT_CONTEXT_WINDOW.
 */
export function getModelContextWindow(model: string | undefined): number {
  return resolveModelMeta(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}
