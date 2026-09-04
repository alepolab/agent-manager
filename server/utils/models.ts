/**
 * Canonical model configuration for the server side.
 *
 * Keep in sync conceptually with `app/utils/models.ts` (the frontend twin).
 * The server cannot import from `app/` (different module context), so this
 * file mirrors the model list and adds server-specific concerns (pricing).
 *
 * Source: https://www.anthropic.com/pricing
 */

export const MODEL_IDS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const
export type ModelId = (typeof MODEL_IDS)[number]

/**
 * Map from the short "tier" alias (used in agent frontmatter) to the full API
 * model id.
 *
 * Verified by live `query()` calls against the installed
 * @anthropic-ai/claude-agent-sdk (0.2.81) on 2026-09-03, reading the
 * `system`/`init` message's `model` field for each alias:
 *   sonnet -> claude-sonnet-4-6
 *   opus   -> claude-opus-4-6
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
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
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
  pricing: ModelPricing
}

export const SERVER_MODEL_META: Record<ModelId, ServerModelMeta> = {
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    contextWindow: 200_000,
    pricing: { input: 15.0, output: 75.0, cached: 1.5 },
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    contextWindow: 200_000,
    pricing: { input: 3.0, output: 15.0, cached: 0.3 },
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    pricing: { input: 0.8, output: 4.0, cached: 0.08 },
  },
}

/** Fallback pricing when model is unknown */
export const DEFAULT_PRICING: ModelPricing = SERVER_MODEL_META['claude-sonnet-4-6'].pricing

/** Default context window when model is unknown */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/**
 * Resolve a model string (either a full id like "claude-sonnet-4" or an alias
 * like "sonnet") to the canonical ServerModelMeta. Returns undefined if unknown.
 */
export function resolveModelMeta(model: string | undefined): ServerModelMeta | undefined {
  if (!model) return undefined
  // Try full id first
  if (SERVER_MODEL_META[model as ModelId]) return SERVER_MODEL_META[model as ModelId]
  // Try alias
  const aliased = MODEL_ALIAS[model]
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
