import { MODEL_ALIAS, DEFAULT_MODEL_ALIAS } from './models.ts'
import type { AgentFrontmatter } from '~/types'

/**
 * There is no default turn budget. A step runs until it finishes.
 *
 * The defaults were removed on the operator's decision, and the evidence was
 * on their side: across the recorded runs 40% of all agent executions were
 * repeats, and a budget that fires does not save the spend — it discards
 * everything the step had done and re-attempts it from a log tail, which
 * costs more than the turns it refused. Every declared budget in the pipeline
 * had been set from a guess and then raised after it killed real work.
 *
 * `maxTurns` and `maxDurationMs` remain honoured when an agent declares one,
 * so a genuinely bounded step (a one-shot Jira transition) can still say so.
 * Absent means absent: nothing is substituted.
 *
 * What still bounds a run: the RUN budget in workflowRunStore, which pauses
 * and asks for another allowance instead of failing, and the operator's Stop.
 */
export const DEFAULT_MAX_TURNS: number | undefined = undefined

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

/**
 * Resolves the model for a `query()` call from an agent's frontmatter.
 *
 * `frontmatter.model` (documented in CLAUDE.md's data model as
 * `model: sonnet | opus | haiku`) used to be parsed by agentCaller.ts and
 * then never used - every agent silently ran on whatever the SDK's own
 * default happened to be, regardless of what its frontmatter declared, with
 * no error. Pulled out as a pure function, same pattern as resolveTools/
 * resolveMaxTurns above, so the mapping is testable without a live SDK call.
 *
 * Returns both forms: `alias` ('sonnet'/'opus'/'haiku') is what gets
 * recorded as provenance (RunStep.model, meta.json's `model`) - it matches
 * DEFAULT_MODEL_ALIAS and every other model-alias value in this codebase.
 * `id` is the full model id (via this repo's own MODEL_ALIAS map) that
 * actually gets passed to query()'s `Options.model` - checked against the
 * installed SDK's sdk.d.ts, whose only documented examples for that field
 * are full ids ('claude-sonnet-4-6'), not the short alias.
 */
export function resolveModel(frontmatter?: Pick<AgentFrontmatter, 'model'>): { alias: string, id: string } {
  const alias = frontmatter?.model ?? DEFAULT_MODEL_ALIAS
  // An agent may declare a model this registry does not know. Fall back to the
  // default's id rather than handing the SDK `undefined`, which it rejects -
  // and which would fail the step for a reason unrelated to its work.
  return { alias, id: MODEL_ALIAS[alias] ?? MODEL_ALIAS[DEFAULT_MODEL_ALIAS] ?? DEFAULT_MODEL_ALIAS }
}

/** An agent's turn budget, or undefined for "run until done". Only a positive integer counts. */
export function resolveMaxTurns(frontmatter?: Pick<AgentFrontmatter, 'maxTurns'>): number | undefined {
  const declared = frontmatter?.maxTurns
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_TURNS
}

/** There is no default wall-clock ceiling either.
 *
 *  The turn budget alone does not bound a step — one turn can sit inside a
 *  single Bash command indefinitely — which is why this existed: a real stack
 *  provisioner ran 47.4 minutes, and a 30-minute ceiling was set from it.
 *  Re-reading that case, the provisioner was spending turns the whole way and
 *  died on TURNS, not time: it was working, not hanging, and the ceiling drawn
 *  from it killed working steps.
 *
 *  Removed on the operator's decision. A step that genuinely hangs is now ended
 *  by the operator's Stop or by the run budget, both of which a person sees,
 *  rather than by a timer that discards the step's work and silently
 *  re-attempts it. An agent that wants a ceiling may still declare one. */
export const DEFAULT_MAX_DURATION_MS: number | undefined = undefined

/** An agent's wall-clock budget, or undefined for no ceiling. Only a positive integer counts. */
export function resolveMaxDurationMs(frontmatter?: Pick<AgentFrontmatter, 'maxDurationMs'>): number | undefined {
  const declared = frontmatter?.maxDurationMs
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_DURATION_MS
}
