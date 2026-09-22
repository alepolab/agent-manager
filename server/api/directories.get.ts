import { readdirSync, statSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { getClaudeDir } from '../utils/claudeDir'
import { workspaceRoot } from '../utils/workspace'
import { requireCapability } from '../utils/session'

/**
 * Browse for a working directory, within the trees this app is about.
 *
 * Previously listed any directory on the host, starting from `/`, for any
 * signed-in user and with no capability check — the directory index that made
 * an unguarded file read trivially exploitable.
 */
function allowedRoots(): string[] {
  return [getClaudeDir(), workspaceRoot(), process.env.AGENT_RUNS_DIR || '', homedir()]
    .filter(Boolean)
    .map(d => resolve(d))
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const query = getQuery(event)
  const input = (query.path as string || '').replace(/^~/, homedir())

  // Determine which directory to list and what prefix to filter by
  let dirToList: string
  let prefix: string

  if (!input || input === '/') {
    dirToList = '/'
    prefix = ''
  } else if (input.endsWith('/')) {
    dirToList = input
    prefix = ''
  } else {
    dirToList = dirname(input)
    prefix = input.slice(dirToList.length).replace(/^\//, '').toLowerCase()
  }

  const resolved = resolve(dirToList)
  if (!allowedRoots().some(root => within(resolved, root))) {
    throw createError({ statusCode: 403, message: 'That directory is outside the directories this app serves.' })
  }

  try {
    const entries = readdirSync(resolved, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .filter(e => !prefix || e.name.toLowerCase().startsWith(prefix))
      .slice(0, 15)
      .map(e => {
        const full = resolve(resolved, e.name)
        // Check if this directory has subdirectories (for showing expandability)
        let hasChildren = false
        try {
          hasChildren = readdirSync(full, { withFileTypes: true }).some(c => c.isDirectory() && !c.name.startsWith('.'))
        } catch { /* no access */ }
        return { name: e.name, path: full + '/', hasChildren }
      })

    return { directories: dirs, basePath: dirToList }
  } catch {
    return { directories: [], basePath: dirToList }
  }
})
