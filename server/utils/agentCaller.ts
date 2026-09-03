import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir'
import { parseFrontmatter } from './frontmatter'
import { resolveTools, resolveMaxTurns } from './agentToolPolicy'
import { setAgentCaller } from './workflowRunner'
import type { AgentFrontmatter } from '~/types'

/** One agent turn. Returns its final text. */
async function callAgent(agentSlug: string, input: string, projectDir?: string): Promise<string> {
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

setAgentCaller(callAgent)
