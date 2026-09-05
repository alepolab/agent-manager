import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { resolveTools, resolveMaxTurns } from './agentToolPolicy.ts'
import { buildAgentSystemPrompt } from './agentSystemPrompt.ts'
import type { AgentFrontmatter } from '~/types'

/**
 * Token usage for one agent turn, as the SDK's own `result` message reported
 * it - never estimated. `input_tokens` folds THREE of the SDK's usage
 * buckets together: `input_tokens` (fresh, uncached), `cache_creation_input_tokens`
 * and `cache_read_input_tokens`. Judgement call, stated here because a
 * reviewer comparing two bundles needs both counted the same way: the
 * evidence-bundle schema has exactly one `input_tokens` slot, no separate
 * cache accounting, and a real agentic turn with prompt caching on can spend
 * >1000x more tokens on cache writes than on fresh input (measured: 3 fresh
 * vs 5406 cache-creation tokens on a trivial one-turn probe). Reporting only
 * the fresh-input figure in that slot would be technically non-fabricated
 * but functionally as misleading as the hardcoded 0 it replaces - a cost
 * field a reviewer can't use to gauge what the run actually spent. So
 * `input_tokens` here means "every input-side token the API processed",
 * not "every input-side token that was billed at the base input rate".
 * `output_tokens` is `usage.output_tokens` alone - there is no output-side
 * caching to fold in.
 */
export interface AgentUsage {
  input_tokens: number
  output_tokens: number
}

/**
 * What one agent turn actually did. `model` is the id the SDK's own
 * `system`/`init` message reported it ran with (e.g. 'claude-sonnet-4-6') -
 * an OBSERVED fact, not a value we requested or defaulted to. `null` when no
 * init message was seen (never guessed - see the comment below on why a
 * fallback here would be worse than an honest absence). `usage` is `null`
 * when the result message carried no usable usage object - never guessed
 * either; see AgentUsage for what "usable" means.
 */
export interface AgentCallResult {
  output: string
  model: string | null
  usage: AgentUsage | null
}

// Exported and imported directly by workflowRunner.ts (module scope, not a
// side-effect import) so the real caller is wired the instant that module
// loads — see the comment on `agentCaller` there. Do NOT import
// workflowRunner.ts from this file: workflowRunner.ts imports this file, and
// a back-reference would create a cycle.
/**
 * One agent turn. Returns its final text AND the model the SDK actually ran.
 *
 * Model handling here went through two rounds of correction, both against
 * measured behaviour of the installed SDK rather than its doc comments:
 *
 * 1. `frontmatter.model` (documented in CLAUDE.md's data model as
 *    `model: sonnet | opus | haiku`) used to be parsed and then silently
 *    ignored entirely — every agent ran on whatever the SDK's own default
 *    happened to be, regardless of what its frontmatter declared, no error.
 * 2. The first fix resolved the declared alias to a full id via this
 *    repo's own MODEL_ALIAS map (server/utils/models.ts) before passing it
 *    to query()'s `options.model`, on the strength of that field's doc
 *    comment ("Examples: 'claude-sonnet-4-6'"). A live `query()` call
 *    proved MODEL_ALIAS's ids are STALE ('claude-sonnet-4' etc. do not
 *    exist) - `Claude Code returned an error result: There's an issue with
 *    the selected model` on every single call. The doc comment misled; the
 *    artifact (a real API response) is what settled it.
 *
 * So: the bare alias declared in frontmatter is passed through to
 * `options.model` UNRESOLVED (measured directly: 'sonnet'/'opus'/'haiku'
 * are what the live API actually accepts there). MODEL_ALIAS itself is left
 * alone - it's stale and reported separately; correcting the registry is a
 * wider change than this function owns. When frontmatter declares no model,
 * the `model` option is omitted entirely rather than substituted with a
 * default: passing one would silently change every undeclared agent's model
 * (and cost) from whatever it inherits today, which is not this function's
 * call to make. Either way, what's RECORDED as `model` in the return value
 * is never the request — it's what the SDK's own `system`/`init` message
 * reports it resolved to, captured below.
 */
export async function callAgent(agentSlug: string, input: string, projectDir?: string, signal?: AbortSignal): Promise<AgentCallResult> {
  // The runner's stop aborts this controller; the SDK then ends the CLI process.
  const abortController = new AbortController()
  if (signal?.aborted) abortController.abort()
  signal?.addEventListener('abort', () => abortController.abort())
  const claudeDir = getClaudeDir()
  const cwd = projectDir && existsSync(projectDir) ? projectDir : claudeDir

  let systemAppend = `You are "${agentSlug}", a specialized agent.`
  let frontmatter: AgentFrontmatter | undefined

  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)
  if (existsSync(agentPath)) {
    const parsed = parseFrontmatter<AgentFrontmatter>(await readFile(agentPath, 'utf-8'))
    frontmatter = parsed.frontmatter
    systemAppend = await buildAgentSystemPrompt({
      agentSlug,
      agentName: parsed.frontmatter.name,
      agentBody: parsed.body,
      skills: parsed.frontmatter.skills,
      cwd,
    })
  }

  const declaredModel = frontmatter?.model

  const toolsOption = resolveTools(frontmatter)
  let result = ''
  let modelRan: string | null = null
  let usage: AgentUsage | null = null
  for await (const message of query({
    prompt: input,
    options: {
      cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: resolveMaxTurns(frontmatter),
      ...(declaredModel ? { model: declaredModel } : {}),
      ...(toolsOption ? { tools: toolsOption } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    },
  })) {
    // The one place the real, observed model comes from - never the request.
    if (message.type === 'system' && message.subtype === 'init') modelRan = message.model
    if (message.type === 'result') {
      const interpreted = interpretResultMessage(message)
      result = interpreted.output
      usage = interpreted.usage
    }
  }
  return { output: result, model: modelRan, usage }
}

/**
 * Interprets one SDKResultMessage: returns the real output and usage on a
 * genuine success, or throws. `subtype === 'success'` is NOT sufficient on
 * its own: SDKResultSuccess also carries `is_error`, and a live probe
 * against a bad model id returned `subtype: 'success'` WITH `is_error: true`
 * - a result whose `.result` text is an error description, not agent
 * output. Treating that as success would silently record the error text as
 * the step's real output, the same failure class an earlier fix already
 * closed once for the `'result' in message` bug (see callAgent's doc
 * comment). On any other shape - SDKResultError (no `.result` field at all,
 * never read here) or an is_error:true SDKResultSuccess - `.errors` is the
 * error-shaped field to surface, since SDKResultSuccess carries none itself.
 *
 * Exported specifically so a test can drive it with a synthetic message:
 * `is_error: true` cannot be provoked from a live call on demand, but the
 * shape is real - a concurrent model-registry probe against a stale model
 * id hit exactly this combination mid-development.
 */
export function interpretResultMessage(
  message: { subtype: string, is_error?: boolean, result?: string, usage?: unknown, errors?: string[] },
): { output: string, usage: AgentUsage | null } {
  if (message.subtype === 'success' && !message.is_error) {
    return { output: String(message.result ?? ''), usage: usageFrom(message.usage) }
  }
  const errors = 'errors' in message ? message.errors : undefined
  throw new Error(
    `Claude Code returned an error result (${message.subtype}` +
    `${message.is_error ? ', is_error' : ''}): ` +
    `${errors?.join('; ') || 'no further detail'}`,
  )
}

/** Folds the SDK's usage object into AgentUsage - see that type's doc comment
 *  for which buckets are summed and why. `null` when the object isn't in the
 *  shape expected (never guessed at a partial or malformed one). */
function usageFrom(raw: unknown): AgentUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number') return null
  return {
    input_tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    output_tokens: num(u.output_tokens),
  }
}
