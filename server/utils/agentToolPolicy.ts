import type { AgentFrontmatter } from '~/types'

export const DEFAULT_MAX_TURNS = 10

/**
 * Resolves the SDK's `tools` option for a `query()` call.
 *
 * This MUST be passed as `tools`, not `allowedTools`. Per the SDK's own typings
 * (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts), `allowedTools` only
 * pre-approves a permission prompt - it does not remove a tool from what the
 * model can call. Since this app runs with `permissionMode: 'bypassPermissions'`,
 * every prompt is already auto-approved, so `allowedTools` was a complete no-op:
 * every agent got the full default toolset regardless of its frontmatter.
 *
 * Verified empirically against the installed SDK (0.2.81) with real `query()` runs:
 *   - `allowedTools: ['Read','Grep','Glob']` + `permissionMode: 'bypassPermissions'`
 *     -> the model still called Bash and it executed. Confirms the no-op.
 *   - `tools: ['Read','Grep','Glob']` -> the `system/init` message reports exactly
 *     `['Glob','Grep','Read']` as the registered toolset, and the model reports it
 *     has no Bash access when asked to use it.
 *   - `tools: []` -> `system/init` reports `tools: []`. Asking the model to write a
 *     file produces no `tool_use` content block at all (it can only hallucinate a
 *     fake `<tool_call>` in plain text) and no file is created. So an empty array
 *     genuinely yields zero tools - it is NOT a no-op for the top-level `Options.tools`
 *     field in this SDK version, so no `disallowedTools` workaround is needed.
 *   - Omitting `tools` entirely -> `system/init` reports the full ~24-tool default
 *     set, matching today's (buggy) effective behaviour.
 *
 * Semantics:
 * - No `tools` frontmatter -> `undefined`, so the SDK keeps its full default
 *   toolset. This preserves today's effective behaviour for every agent that
 *   doesn't declare `tools` (Agent Studio, existing agents/templates) - narrowing
 *   this to some smaller default list would be a breaking regression.
 * - An explicit `tools` array is honoured exactly, including an empty one, which
 *   is a deliberate "touch nothing" declaration.
 */
export function resolveTools(frontmatter?: Pick<AgentFrontmatter, 'tools'>): string[] | undefined {
  const declared = frontmatter?.tools
  if (Array.isArray(declared)) return [...declared]
  return undefined
}

/** An agent's turn budget. Only a positive integer overrides the default. */
export function resolveMaxTurns(frontmatter?: Pick<AgentFrontmatter, 'maxTurns'>): number {
  const declared = frontmatter?.maxTurns
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_TURNS
}
