import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { resolveTools, resolveMaxTurns } from './agentToolPolicy.ts'
import { buildAgentSystemPrompt } from './agentSystemPrompt.ts'
import type { AgentFrontmatter } from '~/types'

/**
 * What one agent turn actually did. `model` is the id the SDK's own
 * `system`/`init` message reported it ran with (e.g. 'claude-sonnet-4-6') -
 * an OBSERVED fact, not a value we requested or defaulted to. `null` when no
 * init message was seen (never guessed - see the comment below on why a
 * fallback here would be worse than an honest absence).
 */
export interface AgentCallResult {
  output: string
  model: string | null
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
export async function callAgent(agentSlug: string, input: string, projectDir?: string): Promise<AgentCallResult> {
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
  for await (const message of query({
    prompt: input,
    options: {
      cwd,
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
      if (message.subtype === 'success') {
        result = String(message.result ?? '')
      } else {
        // SDKResultError ('error_during_execution' | 'error_max_turns' | ...).
        // The previous check here (`'result' in message`) treated this the
        // same as success - a live call against an invalid model id this
        // round returned exactly this shape, which the old check would have
        // silently swallowed as an empty, successful output instead of
        // surfacing anything to executeNode's catch block. Fixed while this
        // exact loop was open for the model change, since it is the same
        // silent-fabrication failure mode this whole plan exists to close.
        throw new Error(
          `Claude Code returned an error result (${message.subtype}): ` +
          `${message.errors?.join('; ') || 'no further detail'}`,
        )
      }
    }
  }
  return { output: result, model: modelRan }
}
