import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeDir, resolveClaudePath } from '../utils/claudeDir'
import { DEFAULT_OUTPUT_STYLES } from '../utils/defaultOutputStyles'
import { parseFrontmatter } from '../utils/frontmatter'
import { resolveTools, resolveMaxTurns } from '../utils/agentToolPolicy'
import { buildAgentSystemPrompt } from '../utils/agentSystemPrompt'
import type { AgentFrontmatter } from '~/types'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

async function getOutputStyleContent(id: string, projectDir?: string): Promise<{ content: string; keepCodingInstructions: boolean } | null> {
  // 1. Check built-in
  const defaultStyle = DEFAULT_OUTPUT_STYLES.find(s => s.id === id)
  if (defaultStyle) {
    return { 
      content: id === 'default' ? '' : defaultStyle.content, 
      keepCodingInstructions: defaultStyle.keepCodingInstructions ?? false 
    }
  }

  // 2. Check global files
  const globalPath = resolveClaudePath('output-styles', `${id}.md`)
  if (existsSync(globalPath)) {
    const raw = readFileSync(globalPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter<any>(raw)
    return { 
      content: body, 
      keepCodingInstructions: frontmatter['keep-coding-instructions'] === true || frontmatter.keepCodingInstructions === true
    }
  }

  // 3. Check project files
  if (projectDir) {
    const projectPath = join(projectDir, '.claude', 'output-styles', `${id}.md`)
    if (existsSync(projectPath)) {
      const raw = readFileSync(projectPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<any>(raw)
      return { 
        content: body, 
        keepCodingInstructions: frontmatter['keep-coding-instructions'] === true || frontmatter.keepCodingInstructions === true
      }
    }
  }

  return null
}

function defaultManagerPrompt(claudeDir: string, resolvedCwd: string): string {
  return `You are an assistant integrated into the Agent Manager UI. The user is managing their Claude Code agents, commands, skills, and plugins through a web interface.

The current working directory is: ${resolvedCwd}

Your own configuration (agents, commands, skills, settings) always lives in the Claude configuration folder, independent of the working directory above: ${claudeDir}

## File structure

- **Agents**: Markdown files in \`${claudeDir}/agents/\` with YAML frontmatter (name, description, model, color, memory)
- **Commands**: Markdown files in \`${claudeDir}/commands/\` (can be in subdirectories) with YAML frontmatter (name, description, argument-hint, allowed-tools)
- **Skills**: Each skill is a directory in \`${claudeDir}/skills/<name>/SKILL.md\` with YAML frontmatter (name, description, context, agent)
- **Settings**: \`${claudeDir}/settings.json\` — global Claude Code settings

## Capabilities

You can create, read, update, and delete any of these files. You can also:
- **Bulk operations**: Rename, update, or delete multiple agents/commands/skills at once. When doing bulk ops, list what you'll change and ask for confirmation before executing.
- **Audit**: Review all agents/commands/skills and report on quality, missing fields, inconsistencies.
- **Generate**: Create new agents/commands/skills from a plain-English description. Ask clarifying questions first.
- **Refactor**: Reorganize commands into directories, split large agents into agent+skills, consolidate duplicates.

## Rules

- Always confirm what you did after making changes.
- For destructive operations (delete, overwrite), list exactly what will be affected and ask for confirmation.
- When creating agents, use the YAML frontmatter format with --- delimiters.
- Keep the user informed of progress during multi-step operations.
- If the user describes what they need in plain English, translate that into the right agent/command/skill configuration.`
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ 
    messages: ChatMessage[]; 
    sessionId?: string; 
    agentSlug?: string; 
    projectDir?: string;
    outputStyleId?: string;
  }>(event)

  if (!body.messages?.length) {
    throw createError({ statusCode: 400, message: 'messages is required' })
  }

  const lastUserMessage = body.messages.filter(m => m.role === 'user').pop()
  if (!lastUserMessage) {
    throw createError({ statusCode: 400, message: 'No user message found' })
  }

  const claudeDir = getClaudeDir()

  // Resolved once - this MUST match the `cwd` handed to `query()` below, or the
  // system prompt will tell the model it's somewhere it isn't.
  const resolvedCwd = body.projectDir && existsSync(body.projectDir) ? body.projectDir : claudeDir

  // Build system prompt depending on whether an agent is active
  let systemAppend: string

  let agentFrontmatter: AgentFrontmatter | undefined

  if (body.agentSlug) {
    const agentPath = resolveClaudePath('agents', `${body.agentSlug}.md`)
    if (existsSync(agentPath)) {
      const { parseFrontmatter } = await import('../utils/frontmatter')
      const raw = await readFile(agentPath, 'utf-8')
      const { frontmatter, body: agentBody } = parseFrontmatter<AgentFrontmatter>(raw)
      agentFrontmatter = frontmatter
      systemAppend = await buildAgentSystemPrompt({
        agentSlug: body.agentSlug,
        agentName: frontmatter.name,
        agentBody,
        skills: frontmatter.skills,
        cwd: resolvedCwd,
      })
    } else {
      systemAppend = defaultManagerPrompt(claudeDir, resolvedCwd)
    }
  } else {
    systemAppend = defaultManagerPrompt(claudeDir, resolvedCwd)
  }

  // Handle Output Style
  let systemPreset: 'claude_code' | 'none' = 'claude_code'
  if (body.outputStyleId) {
    const style = await getOutputStyleContent(body.outputStyleId, body.projectDir)
    if (style) {
      if (style.content) {
        systemAppend += `\n\nAdditional style/behavioral instructions:\n${style.content}`
      }
      if (style.keepCodingInstructions === false) {
        systemPreset = 'none'
      }
    }
  }

  // Set up SSE headers
  setResponseHeaders(event, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const sendEvent = (type: string, data: unknown) => {
    event.node.res.write(`data: ${JSON.stringify({ type, ...data as object })}\n\n`)
  }

  try {
    let sessionId = body.sessionId || null
    let resultText = ''

    const toolsOption = resolveTools(agentFrontmatter)

    for await (const message of query({
      prompt: lastUserMessage.content,
      options: {
        cwd: resolvedCwd,
        // `tools` restricts the actual toolset; `allowedTools` only pre-approves a
        // permission prompt and is a no-op under `bypassPermissions` below. Omitted
        // entirely when the agent declares no `tools` frontmatter, so the SDK keeps
        // its full default toolset (today's effective behaviour). See agentToolPolicy.ts.
        ...(toolsOption ? { tools: toolsOption } : {}),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: resolveMaxTurns(agentFrontmatter),
        includePartialMessages: true,
        // `systemPreset === 'none'` means the output style asked for the coding
        // preset to be dropped entirely - it is not a preset value the SDK
        // accepts. Omit the preset and send the append text as a plain system
        // prompt instead; setting `preset: 'none'` was silently invalid.
        ...(systemPreset === 'claude_code'
          ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemAppend } }
          : { systemPrompt: systemAppend }),
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      // Capture session ID for resumption
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id
        sendEvent('session', { sessionId })
      }

      // Stream incremental text and thinking deltas
      if (message.type === 'stream_event' && message.event) {
        const evt = message.event as {
          type: string
          content_block?: { type: string }
          delta?: { type: string; text?: string; thinking?: string }
        }
        if (evt.type === 'content_block_start' && evt.content_block?.type === 'thinking') {
          sendEvent('thinking_start', {})
        }
        if (evt.type === 'content_block_delta') {
          if (evt.delta?.type === 'text_delta' && evt.delta.text) {
            sendEvent('text_delta', { text: evt.delta.text })
          } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
            sendEvent('thinking_delta', { text: evt.delta.thinking })
          }
        }
      }

      // Tool progress — surface what Claude is doing
      if (message.type === 'tool_progress') {
        const m = message as any
        sendEvent('tool_progress', {
          toolName: m.tool_name,
          elapsed: m.elapsed_time_seconds,
        })
      }

      // UNREACHABLE with the current SDK: 'tool_call' and 'tool_result' are not
      // members of SDKMessage's `type` union (it carries 'assistant', 'user',
      // 'result', 'stream_event', 'system', ...). Tool activity arrives inside
      // assistant content blocks instead. These branches have therefore never
      // fired; kept, narrowed through a widened local so the comparison is
      // honest rather than a type error, and left for whoever wires tool
      // streaming properly.
      const msgType = (message as { type: string }).type
      // Tool call
      if (msgType === 'tool_call') {
        const m = message as any
        sendEvent('tool_call', {
          id: m.id,
          toolName: m.tool_name,
          input: m.tool_input,
        })
      }

      // Tool result
      if (msgType === 'tool_result') {
        const m = message as any
        sendEvent('tool_result', {
          id: m.tool_use_id,
          toolName: m.tool_name,
          result: m.content,
          isError: m.is_error,
        })
      }

      // Final result
      if ('result' in message) {
        const m = message as any
        resultText = m.result
        sendEvent('result', { text: resultText, stopReason: m.stop_reason })
      }
    }

    sendEvent('done', { sessionId })
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    sendEvent('error', { message: errorMessage })
  }

  event.node.res.end()
})
