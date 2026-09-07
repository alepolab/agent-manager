import { getClaudeCodeProjects } from './claudeCodeHistory'

/**
 * Find a Claude Code project by name or path.
 *
 * This matching used to live only inside /api/projects/resolve, and the two
 * handlers that needed it called that route over HTTP from inside the server.
 * A server-to-self $fetch carries no cookies, so the auth middleware answered
 * 401 as soon as AUTH_DISABLED was off — and both call sites caught the error
 * and fell back to guessing the path as `name.replace(/-/g, '/')`. The result
 * in team mode was not an error: it was a file tree and a git panel quietly
 * pointed at the wrong directory.
 *
 * Resolution is a lookup over a list this process already holds. It has no
 * business being an HTTP request at all.
 */

/** Lowercase, non-alphanumerics to dashes, collapsed and trimmed. */
function normalize(str: string): string {
  return str.toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export interface ResolvedProject { name: string, path: string }

/**
 * Exact name, then path, then a suffix match in either direction — the same
 * order and semantics the route applied. Returns null when nothing matches.
 */
export async function findProject(nameOrPath: string): Promise<ResolvedProject | null> {
  const projects = await getClaudeCodeProjects() as ResolvedProject[]
  const target = normalize(nameOrPath)

  let project = projects.find(p => p.name === nameOrPath || normalize(p.name) === target)
  if (!project) project = projects.find(p => normalize(p.path) === target)
  if (!project) {
    project = projects.find(p => {
      const pathSlug = normalize(p.path)
      return pathSlug.endsWith(target) || target.endsWith(pathSlug)
    })
  }
  return project ?? null
}

/**
 * The project's path, or the historical guess when nothing matches. Both
 * callers want a path and both had this same fallback inline.
 */
export async function resolveProjectPath(nameOrPath: string): Promise<string> {
  const project = await findProject(nameOrPath)
  return project?.path ?? nameOrPath.replace(/-/g, '/')
}
