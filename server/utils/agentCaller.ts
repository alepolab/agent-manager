import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { resolveTools, resolveMaxTurns } from './agentToolPolicy.ts'
import type { AgentFrontmatter } from '~/types'

// Exported and imported directly by workflowRunner.ts (module scope, not a
// side-effect import) so the real caller is wired the instant that module
// loads — see the comment on `agentCaller` there. Do NOT import
// workflowRunner.ts from this file: workflowRunner.ts imports this file, and
// a back-reference would create a cycle.
/** One agent turn. Returns its final text. */
export async function callAgent(agentSlug: string, input: string, projectDir?: string): Promise<string> {
  const claudeDir = getClaudeDir()
  const cwd = projectDir && existsSync(projectDir) ? projectDir : claudeDir

  let systemAppend = `You are "${agentSlug}", a specialized agent.`
  let frontmatter: AgentFrontmatter | undefined

  const agentPath = resolveClaudePath('agents', `${agentSlug}.md`)
  if (existsSync(agentPath)) {
    const parsed = parseFrontmatter<AgentFrontmatter>(await readFile(agentPath, 'utf-8'))
    frontmatter = parsed.frontmatter
    systemAppend = `You are "${parsed.frontmatter.name || agentSlug}", a specialized agent. `
      + `Follow these instructions precisely:\n\n${parsed.body}\n\n`
      + `The current working directory is: ${cwd}`
  }

  const toolsOption = resolveTools(frontmatter)
  let result = ''
  for await (const message of query({
    prompt: input,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: resolveMaxTurns(frontmatter),
      ...(toolsOption ? { tools: toolsOption } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
    },
  })) {
    if (message.type === 'result' && 'result' in message) result = String(message.result ?? '')
  }
  return result
}
