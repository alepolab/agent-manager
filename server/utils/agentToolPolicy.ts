import type { AgentFrontmatter } from '~/types'

/** What every agent got before frontmatter could say otherwise. */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const

export const DEFAULT_MAX_TURNS = 10

/**
 * An agent's toolset. An explicit `tools` array is honoured exactly - including an
 * empty one, which is a deliberate "touch nothing" declaration, not an omission.
 */
export function resolveAllowedTools(frontmatter?: Pick<AgentFrontmatter, 'tools'>): string[] {
  const declared = frontmatter?.tools
  if (Array.isArray(declared)) return [...declared]
  return [...DEFAULT_ALLOWED_TOOLS]
}

/** An agent's turn budget. Only a positive integer overrides the default. */
export function resolveMaxTurns(frontmatter?: Pick<AgentFrontmatter, 'maxTurns'>): number {
  const declared = frontmatter?.maxTurns
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_TURNS
}
