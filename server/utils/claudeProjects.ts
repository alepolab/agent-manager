import { promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'
import { projectsDirCandidates } from './claudeDir'

export interface ClaudeProject {
  name: string
  displayName: string
  path: string
  sessionsCount: number
}

export interface ClaudeSession {
  id: string
  summary: string
  lastActivity: string
  messageCount: number
}

/**
 * Every directory transcripts may be in: the server's own and, when agents run
 * as their developers, each developer's. A project worked on by two of them
 * has a folder in each, and is listed once with both folders' sessions.
 */
async function projectsDirs(): Promise<string[]> {
  const dirs: string[] = []
  for (const dir of projectsDirCandidates()) {
    try { await fs.access(dir); dirs.push(dir) } catch { /* not there */ }
  }
  return dirs
}

/**
 * Decode project name to path
 * Example: -Users-liamnguyen-Documents-agents-ui -> /Users/liamnguyen/Documents/agents-ui
 */
function decodeProjectName(encodedName: string): string {
  return encodedName.replace(/^-/, '/').replace(/-/g, '/')
}

/**
 * Get display name from project path
 */
function getDisplayName(projectPath: string): string {
  const parts = projectPath.split('/')
  return parts[parts.length - 1] || projectPath
}

/**
 * List all Claude Code projects
 */
export async function listProjects(): Promise<ClaudeProject[]> {
  try {
    const byName = new Map<string, ClaudeProject>()

    for (const projectsDir of await projectsDirs()) {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const projectPath = decodeProjectName(entry.name)
        const projectDir = path.join(projectsDir, entry.name)

        // Count sessions (.jsonl files, excluding agent-*.jsonl)
        const files = await fs.readdir(projectDir).catch(() => [] as string[])
        const sessionFiles = files.filter(file =>
          file.endsWith('.jsonl') && !file.startsWith('agent-')
        )

        const seen = byName.get(entry.name)
        if (seen) seen.sessionsCount += sessionFiles.length
        else byName.set(entry.name, {
          name: entry.name,
          displayName: getDisplayName(projectPath),
          path: projectPath,
          sessionsCount: sessionFiles.length,
        })
      }
    }

    return [...byName.values()]
  } catch (error) {
    console.error('[Claude Projects] Error listing projects:', error)
    return []
  }
}

/**
 * List sessions for a project
 */
export async function listSessions(projectName: string): Promise<ClaudeSession[]> {
  try {
    // This project's folder in every transcripts directory that has one.
    const filesWithStats: { file: string, filePath: string, mtime: Date }[] = []
    for (const projectsDir of await projectsDirs()) {
      const projectDir = path.join(projectsDir, projectName)
      const files = await fs.readdir(projectDir).catch(() => [] as string[])
      for (const file of files) {
        if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue
        const filePath = path.join(projectDir, file)
        const stats = await fs.stat(filePath)
        filesWithStats.push({ file, filePath, mtime: stats.mtime })
      }
    }

    if (filesWithStats.length === 0) {
      return []
    }

    // Sort by modification time
    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    // Parse sessions
    const sessions: ClaudeSession[] = []

    for (const { file, filePath, mtime } of filesWithStats) {
      const sessionId = file.replace('.jsonl', '')

      // Read first few lines to get summary
      let summary = 'New Session'
      let messageCount = 0

      try {
        const fileStream = createReadStream(filePath)
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity,
        })

        for await (const line of rl) {
          if (!line.trim()) continue
          messageCount++

          try {
            const entry = JSON.parse(line)

            // Find first user message for summary
            if (!summary || summary === 'New Session') {
              if (entry.message?.role === 'user') {
                const content = Array.isArray(entry.message.content)
                  ? entry.message.content.find((c: any) => c.type === 'text')?.text
                  : entry.message.content

                if (content && typeof content === 'string') {
                  summary = content.length > 50
                    ? content.substring(0, 50) + '...'
                    : content
                }
              }
            }

            // Early exit after finding summary and counting ~10 messages
            if (summary !== 'New Session' && messageCount > 10) {
              break
            }
          } catch {
            // Skip malformed lines
          }
        }

        rl.close()
      } catch (error) {
        console.error(`Error reading session ${sessionId}:`, error)
      }

      sessions.push({
        id: sessionId,
        summary,
        lastActivity: mtime.toISOString(),
        messageCount,
      })
    }

    return sessions
  } catch (error) {
    console.error('[Claude Projects] Error listing sessions:', error)
    return []
  }
}

/**
 * Get the current project name for a given directory path
 */
export function getProjectName(projectPath: string): string {
  return projectPath.replace(/\//g, '-').replace(/^-/, '-')
}
