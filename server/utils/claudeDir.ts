import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

let currentClaudeDir: string | null = null

export function getClaudeDir(): string {
  if (!currentClaudeDir) {
    const envDir = process.env.CLAUDE_DIR
    currentClaudeDir = envDir || join(homedir(), '.claude')
  }
  return currentClaudeDir
}

export function setClaudeDir(dir: string): void {
  if (!existsSync(dir)) {
    throw createError({ statusCode: 400, message: `Directory does not exist: ${dir}` })
  }
  currentClaudeDir = dir
}

export function resolveClaudePath(...segments: string[]): string {
  return join(getClaudeDir(), ...segments)
}

/** One path segment, from an id or key that came out of a request body, a
 *  router param or an artifact a person wrote.
 *
 *  Rejecting is not an option at every call site - a watch must still get a
 *  state file whatever it is called - so this rewrites rather than throws, and
 *  the result is only ever a single file or directory name. The leading-dot
 *  strip is what stops `..`, and the character class is what stops a separator
 *  on either platform. */
export const safeSegment = (key: string) =>
  key.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'entry'

/**
 * A file inside one of the Claude directory's own subdirectories, named after
 * something a caller chose.
 *
 * `resolveClaudePath` is a bare `join`, so an id of `../../x` walks out of the
 * directory and turns a state file into an arbitrary read, overwrite or unlink.
 * Every such path goes through here instead: the name is reduced to one
 * segment, and the result is then checked to be under the directory, so a
 * future change to `safeSegment` cannot quietly reopen the hole.
 */
export function resolveClaudeFile(dir: string, name: string, ext = '.json'): string {
  const base = resolve(resolveClaudePath(dir))
  const path = resolve(join(base, `${safeSegment(name)}${ext}`))
  if (path !== base && !path.startsWith(base + sep)) {
    throw createError({ statusCode: 400, message: `"${name}" is not a usable name` })
  }
  return path
}
