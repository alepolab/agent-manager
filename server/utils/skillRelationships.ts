import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'

export async function getPreloadingAgents(skillSlug: string): Promise<{ name: string; slug: string }[]> {
  const agentsDir = resolveClaudePath('agents')
  const preloadingAgents: { name: string; slug: string }[] = []

  if (existsSync(agentsDir)) {
    const agentFiles = await readdir(agentsDir)
    for (const file of agentFiles) {
      if (!file.endsWith('.md')) continue
      try {
        const agentSlug = file.replace(/\.md$/, '')
        const raw = await readFile(join(agentsDir, file), 'utf-8')
        const { frontmatter } = parseFrontmatter<{ name: string; skills?: string[] }>(raw)
        const agentName = frontmatter.name || agentSlug
        const preloadedSkills = frontmatter.skills || []

        if (preloadedSkills.includes(skillSlug)) {
          preloadingAgents.push({ name: agentName, slug: agentSlug })
        }
      } catch {
        // Skip invalid agent files
      }
    }
  }

  return preloadingAgents
}

export type McpServerRef = { name: string; scope: string }

/**
 * The MCP servers a skill could refer to: global ones from ~/.claude.json and
 * project ones from <workingDir>/.mcp.json. Read once per request and passed
 * to matchMcpServer; reading it per skill re-parsed a half-megabyte file
 * hundreds of times and made the skills list take ten seconds.
 */
export async function loadMcpServers(workingDir?: string): Promise<McpServerRef[]> {
  const servers: McpServerRef[] = []

  // Read global servers
  const globalPath = join(homedir(), '.claude.json')
  if (existsSync(globalPath)) {
    try {
      const raw = await readFile(globalPath, 'utf-8')
      const data = JSON.parse(raw)
      if (data.mcpServers) {
        for (const name of Object.keys(data.mcpServers)) {
          servers.push({ name, scope: 'global' })
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  // Read project servers
  if (workingDir && existsSync(workingDir)) {
    const projectPath = join(workingDir, '.mcp.json')
    if (existsSync(projectPath)) {
      try {
        const raw = await readFile(projectPath, 'utf-8')
        const data = JSON.parse(raw)
        if (data.mcpServers) {
          for (const name of Object.keys(data.mcpServers)) {
            servers.push({ name, scope: 'project' })
          }
        }
      } catch (err) {
        // Ignore parse errors
      }
    }
  }

  return servers
}

/** Pure: which of the loaded servers a skill points at, if any. */
export function matchMcpServer(
  servers: McpServerRef[],
  skillSlug: string,
  frontmatter: Record<string, any>,
  body: string,
): McpServerRef | undefined {
  // 1. Explicitly defined in frontmatter
  const mcpRef = frontmatter.mcp as string | undefined
  if (mcpRef) {
    const found = servers.find(s => s.name === mcpRef)
    if (found) return found
  }

  // 2. Scan skill body for MCP tool patterns: mcp__server_name__
  for (const server of servers) {
    const regex = new RegExp(`mcp__${server.name}__`, 'i')
    if (regex.test(body)) {
      return server
    }
  }

  // 3. Name matches pattern: server_name-mcp
  for (const server of servers) {
    if (skillSlug.toLowerCase() === `${server.name.toLowerCase()}-mcp`) {
      return server
    }
  }

  // 4. Name matches exactly (some skills have same name as server)
  for (const server of servers) {
    if (skillSlug.toLowerCase() === server.name.toLowerCase()) {
      return server
    }
  }

  return undefined
}

/** Kept for the single-skill routes; the list handler loads servers once instead. */
export async function getMcpServerForSkill(
  skillSlug: string,
  frontmatter: Record<string, any>,
  body: string,
  workingDir?: string
): Promise<McpServerRef | undefined> {
  return matchMcpServer(await loadMcpServers(workingDir), skillSlug, frontmatter, body)
}
