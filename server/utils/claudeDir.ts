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
/**
 * Where the Claude Code SDK writes its session transcripts, which is NOT
 * necessarily where this app keeps its configuration.
 *
 * The SDK resolves its own config directory from CLAUDE_CONFIG_DIR, falling
 * back to `$HOME/.claude`. It has never read CLAUDE_DIR — that is this app's
 * variable. In the container the two differ (CLAUDE_DIR=/root/.claude,
 * HOME=/home/bun), so every lookup under `getClaudeDir()/projects` found an
 * empty directory and every feature built on finding a transcript silently did
 * nothing: a step that ran again started cold instead of continuing, and so did
 * a step that declares `continuesSession`. Nothing failed; the work was simply
 * paid for twice.
 *
 * Candidates in order, because a developer's machine and the test suite have
 * them the other way round: the SDK's own configured directory, the HOME
 * default, then this app's directory (where CLAUDE_DIR is a temp dir a test
 * wrote a transcript into).
 */
export function projectsDirCandidates(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (dir: string) => { if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir) } }
  if (process.env.CLAUDE_CONFIG_DIR) add(join(process.env.CLAUDE_CONFIG_DIR, 'projects'))
  add(join(homedir(), '.claude', 'projects'))
  add(join(getClaudeDir(), 'projects'))
  return out
}

/** The project folder holding a session's transcripts, or the first candidate when none exists yet. */
export function projectDirFor(project: string): string {
  const candidates = projectsDirCandidates().map(d => join(d, project))
  return candidates.find(existsSync) ?? candidates[0]!
}

/** An existing transcript for this session, or undefined. */
export function transcriptPath(project: string, sessionId: string): string | undefined {
  return projectsDirCandidates()
    .map(d => join(d, project, `${sessionId}.jsonl`))
    .find(existsSync)
}
