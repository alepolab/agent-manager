import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { resolveTools, resolveMaxTurns, resolveModel } from './agentToolPolicy.ts'
import { buildAgentSystemPrompt } from './agentSystemPrompt.ts'
import type { AgentFrontmatter } from '~/types'

/**
 * What one agent turn actually did. `model` is the alias that ran —
 * 'sonnet' | 'opus' | 'haiku', matching DEFAULT_MODEL_ALIAS and every other
 * model-alias value in this codebase, not the SDK's full model id — so the
 * runner can record the truth instead of asserting a constant.
 */
export interface AgentCallResult {
  output: string
  model: string
}

// Exported and imported directly by workflowRunner.ts (module scope, not a
// side-effect import) so the real caller is wired the instant that module
// loads — see the comment on `agentCaller` there. Do NOT import
// workflowRunner.ts from this file: workflowRunner.ts imports this file, and
// a back-reference would create a cycle.
/**
 * One agent turn. Returns its final text AND the model alias actually used.
 *
 * `frontmatter.model` (documented in CLAUDE.md's data model as
 * `model: sonnet | opus | haiku`) used to be parsed and then silently
 * ignored — every agent ran on whatever the SDK's own default happened to
 * be, regardless of what its frontmatter declared, with no error. This now
 * reads it, falls back to DEFAULT_MODEL_ALIAS when absent, and passes the
 * resolved model explicitly to query(). That is a deliberate behaviour
 * change: an agent call that previously took the SDK's own default now
 * takes this repo's own documented default explicitly — aligning the code
 * with stated intent, not changing it.
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

  const { alias: modelAlias, id: model } = resolveModel(frontmatter)

  const toolsOption = resolveTools(frontmatter)
  let result = ''
  for await (const message of query({
    prompt: input,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: resolveMaxTurns(frontmatter),
      model,
      ...(toolsOption ? { tools: toolsOption } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    },
  })) {
    if (message.type === 'result' && 'result' in message) result = String(message.result ?? '')
  }
  return { output: result, model: modelAlias }
}
