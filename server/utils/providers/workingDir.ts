import { existsSync } from 'node:fs'

/**
 * Why a chat cannot start in `dir`, or null when it can.
 *
 * A chat resumed from a run's worktree outlives the worktree: teardown removes
 * it, the transcript stays in ~/.claude/projects. Spawning the SDK there fails
 * with ENOENT on the cwd, which the SDK reports as "native binary ... failed
 * to launch ... does not match this system's libc" - true of nothing here.
 */
export function workingDirProblem(dir: string | undefined): string | null {
  if (!dir || existsSync(dir)) return null
  return `This chat's folder no longer exists: ${dir}. It was probably a run's worktree, removed when the run finished. `
    + 'The conversation is still readable, but it cannot continue there - start a new chat in a project that exists.'
}
