import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, isAbsolute, resolve, sep } from 'node:path'
import { getClaudeDir } from '../utils/claudeDir'
import { workspaceRoot } from '../utils/workspace'
import { requireCapability } from '../utils/session'

/**
 * Read one file, from somewhere this app is entitled to read.
 *
 * This route previously took any absolute path and returned its contents to any
 * signed-in user. It carried a comment reading "Security check: ensure the file
 * is within an allowed directory" above a check that the file EXISTS — which is
 * the opposite test. Two requests took the whole instance: one for
 * `~/.agent-manager/users/<login>.json` (every developer's sealed GitHub and
 * Jira tokens) and one for the app's `.env` (AGENT_MANAGER_SECRET, which is both
 * the AES key those tokens are sealed with and the session-cookie password).
 * The 0600 file mode on the credential store does not help: this route reads as
 * the server process, which owns those files.
 *
 * Two controls, because either alone is insufficient. `configure` keeps it to
 * operators — reading the config directory is a configuration act. Confinement
 * keeps even an operator inside the directories this app is about, so the route
 * cannot be turned into a general host file reader by anyone at all.
 */
function allowedRoots(): string[] {
  // Real paths of the three trees this app legitimately serves: the Claude
  // config directory, the workspace holding the git checkouts, and the run
  // evidence. Anything else on the host is not this route's business.
  return [getClaudeDir(), workspaceRoot(), process.env.AGENT_RUNS_DIR || '']
    .filter(Boolean)
    .map(p => resolve(p))
}

/** Inside `root`, and not merely prefixed by its name (`/srv/work-evil`). */
function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')

  const query = getQuery(event)
  const path = query.path as string
  const projectDir = query.projectDir as string

  if (!path) {
    throw createError({ statusCode: 400, message: 'Path is required' })
  }

  const claudeDir = getClaudeDir()
  const base = projectDir && existsSync(projectDir) ? projectDir : claudeDir
  // `resolve` after the join, so `../` inside a relative path cannot climb out
  // of the base it was resolved against.
  const fullPath = resolve(isAbsolute(path) ? path : join(base, path))

  const roots = allowedRoots()
  if (!roots.some(root => within(fullPath, root))) {
    // Deliberately does not echo the resolved path or the roots: this is the
    // one answer an attacker probing for a readable location would want.
    throw createError({ statusCode: 403, message: 'That file is outside the directories this app serves.' })
  }

  if (!existsSync(fullPath)) {
    throw createError({ statusCode: 404, message: 'File not found' })
  }

  try {
    const content = await readFile(fullPath, 'utf-8')
    return { content, path: fullPath }
  } catch (err: any) {
    throw createError({ statusCode: 500, message: `Failed to read file: ${err.message}` })
  }
})
