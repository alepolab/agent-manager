import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { parseFrontmatter } from './frontmatter.ts'
import type { SkillFrontmatter, CommandFrontmatter } from '~/types'

interface ResolvedSkill {
  name: string
  agent: string | null
  body: string
}

export async function resolveSkillInvocation(
  skillRef: string,
): Promise<ResolvedSkill | null> {
  let agentFilter: string | null = null
  let skillName: string

  if (skillRef.includes(':')) {
    const parts = skillRef.split(':')
    agentFilter = parts[0]!
    skillName = parts.slice(1).join(':')
  } else {
    skillName = skillRef
  }

  const result = await resolveFromSkillsDir(skillName, agentFilter)
  if (result) return result

  const pluginResult = await resolveFromPluginSkills(skillName, agentFilter)
  if (pluginResult) return pluginResult

  const commandResult = await resolveFromCommands(skillName)
  if (commandResult) return commandResult

  return null
}

async function resolveFromSkillsDir(
  name: string,
  agentFilter: string | null,
): Promise<ResolvedSkill | null> {
  const skillPath = resolveClaudePath('skills', name, 'SKILL.md')
  if (!existsSync(skillPath)) return null

  const raw = await readFile(skillPath, 'utf-8')
  const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)

  if (agentFilter && frontmatter.agent !== agentFilter) return null

  return {
    name: frontmatter.name || name,
    agent: frontmatter.agent || null,
    body,
  }
}

async function resolveFromPluginSkills(
  name: string,
  agentFilter: string | null,
): Promise<ResolvedSkill | null> {
  const installedPath = resolveClaudePath('plugins', 'installed_plugins.json')
  if (!existsSync(installedPath)) return null

  let installed: { plugins: Record<string, { installPath: string }[]> }
  try {
    const raw = await readFile(installedPath, 'utf-8')
    installed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!installed?.plugins) return null

  for (const entries of Object.values(installed.plugins)) {
    const entry = entries[0]
    if (!entry) continue

    const skillPath = join(entry.installPath, 'skills', name, 'SKILL.md')
    if (!existsSync(skillPath)) continue

    const raw = await readFile(skillPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw)

    if (agentFilter && frontmatter.agent !== agentFilter) continue

    return {
      name: frontmatter.name || name,
      agent: frontmatter.agent || null,
      body,
    }
  }

  return null
}

async function resolveFromCommands(name: string): Promise<ResolvedSkill | null> {
  const commandsDir = resolveClaudePath('commands')
  if (!existsSync(commandsDir)) return null

  const directPath = join(commandsDir, `${name}.md`)
  if (existsSync(directPath)) {
    const raw = await readFile(directPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw)
    return {
      name: frontmatter.name || name,
      agent: null,
      body,
    }
  }

  const entries = await readdir(commandsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nestedPath = join(commandsDir, entry.name, `${name}.md`)
    if (existsSync(nestedPath)) {
      const raw = await readFile(nestedPath, 'utf-8')
      const { frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw)
      return {
        name: frontmatter.name || name,
        agent: null,
        body,
      }
    }
  }

  return null
}
