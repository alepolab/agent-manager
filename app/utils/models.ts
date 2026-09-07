import type { AgentModel } from '~/types'

/**
 * All supported model identifiers.
 * This is the canonical list — update here to add/remove models.
 */
export const MODEL_IDS = ['fable', 'opus', 'sonnet', 'haiku'] as const satisfies AgentModel[]

/**
 * Named constants for every model ID.
 * Use these anywhere you need to compare or assign a model string:
 *
 *   // ✅ do this
 *   import { MODEL, DEFAULT_MODEL } from '~/utils/models'
 *   if (model === MODEL.SONNET) { ... }
 *   selectedModel.value = MODEL.SONNET
 *
 *   // ❌ never this
 *   if (model === 'sonnet') { ... }
 */
export const MODEL = {
  FABLE: 'fable' as const,
  OPUS: 'opus' as const,
  SONNET: 'sonnet' as const,
  HAIKU: 'haiku' as const,
} satisfies Record<string, AgentModel>

/**
 * Full metadata for each model.
 * All UI concerns (labels, colors, pricing descriptions, etc.) live here.
 */
export interface ModelMeta {
  /** Short human-readable name shown in badges/chips */
  label: string
  /** One-liner describing the model's strength */
  tagline: string
  /** Full description for pickers / tooltips */
  description: string
  /** Tailwind bg utility for badges */
  badgeBg: string
  /** Tailwind text utility for badges */
  badgeText: string
  /** Hex color for charts and graph nodes */
  color: string
  /** Context window size in tokens */
  contextWindow: number
}

export const MODEL_META: Record<AgentModel, ModelMeta> = {
  fable: {
    label: 'Fable',
    tagline: 'Most intelligent',
    description: 'Anthropic\'s most intelligent model (Claude Fable 5.1). Best for the hardest reasoning and long agentic work.',
    badgeBg: 'bg-rose-500/15',
    badgeText: 'text-rose-400',
    color: '#E11D48',
    contextWindow: 200_000,
  },
  opus: {
    label: 'Opus',
    tagline: 'Most capable',
    description: 'Most capable. Best for complex reasoning and nuanced tasks.',
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-400',
    color: '#7C3AED',
    contextWindow: 200_000,
  },
  sonnet: {
    label: 'Sonnet',
    tagline: 'Balanced',
    description: 'Best balance of speed and quality. Good for most tasks.',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-400',
    color: '#2563EB',
    contextWindow: 200_000,
  },
  haiku: {
    label: 'Haiku',
    tagline: 'Fast & efficient',
    description: 'Fastest and cheapest. Great for simple, repetitive tasks.',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-400',
    color: '#D97706',
    contextWindow: 200_000,
  },
}

/** Default model used when none is specified */
export const DEFAULT_MODEL: AgentModel = MODEL.SONNET

// ─── Derived helpers ──────────────────────────────────────────────────────────

/** Options array for model picker UI components (with optional "Default" entry) */
export const MODEL_OPTIONS: { value: AgentModel | undefined; label: string; desc: string }[] = [
  ...MODEL_IDS.map((id) => ({
    value: id as AgentModel,
    label: MODEL_META[id].label,
    desc: MODEL_META[id].description,
  })),
  { value: undefined, label: 'Default', desc: 'Uses whatever model is set in your Claude Code config.' },
]

/** Compact options for toggle-button style pickers (no "Default") */
export const MODEL_OPTIONS_COMPACT: { value: AgentModel; label: string }[] = MODEL_IDS.map((id) => ({
  value: id,
  label: MODEL_META[id].label,
}))

/**
 * Options for chat-style model selectors that include a description field.
 * Matches the shape { value, label, description } expected by ChatV2ModelSelector.
 */
export const MODEL_OPTIONS_CHAT: { value: AgentModel; label: string; description: string }[] = MODEL_IDS.map((id) => ({
  value: id,
  label: MODEL_META[id].label,
  description: MODEL_META[id].description,
}))

/** Lookup: human-readable tagline for a model */
export function getModelTagline(model: AgentModel | string | undefined): string {
  if (!model) return MODEL_META[DEFAULT_MODEL].tagline
  return MODEL_META[model as AgentModel]?.tagline ?? model
}

/** Lookup: display label for a model (falls back to the raw string) */
export function getModelLabel(model: AgentModel | string | undefined): string {
  if (!model) return 'Default'
  return MODEL_META[model as AgentModel]?.label ?? model
}

/** Lookup: chart/graph hex color for a model */
export function getModelColor(model: AgentModel | string | undefined): string {
  if (!model) return '#71717a'
  return MODEL_META[model as AgentModel]?.color ?? '#71717a'
}

/**
 * Lookup: Tailwind badge classes {bg, text} for a model.
 * Returns neutral classes when model is unknown.
 */
export function getModelBadgeClasses(model: AgentModel | string | undefined): { bg: string; text: string } {
  if (!model || !MODEL_META[model as AgentModel]) {
    return { bg: 'bg-zinc-500/15', text: 'text-zinc-400' }
  }
  const meta = MODEL_META[model as AgentModel]
  return { bg: meta.badgeBg, text: meta.badgeText }
}

/**
 * Lookup: inline style object for model badge (for use in non-Tailwind contexts
 * such as graph nodes where dynamic Tailwind classes are purged).
 */
export function getModelBadgeStyle(model: AgentModel | string | undefined): {
  background: string
  color: string
} {
  const hex = getModelColor(model)
  return {
    background: `${hex}26`, // ~15% opacity
    color: hex,
  }
}
