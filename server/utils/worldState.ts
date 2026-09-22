import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { WorldState } from '../../shared/utils/facts.ts'

const execFileAsync = promisify(execFile)

export type ExecLike = (cmd: string, args: string[], opts: { cwd: string }) => Promise<string>

const realExec: ExecLike = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, { cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/**
 * What the repository looks like right now: the commit, and a digest of the
 * working tree.
 *
 * Both, because either alone lies — the same reasoning testLock.ts already
 * records: "a step that never committed has still changed the tree". A
 * verdict captured green and then followed by an uncommitted edit leaves HEAD
 * byte-identical, so a freshness check that compares only commits would call
 * that evidence current. It is not; it describes a tree that no longer exists
 * and that nobody will ever review.
 *
 * The tree digest is over `git status --porcelain`, not over file contents.
 * That is deliberate and it is a known ceiling: porcelain reports WHICH paths
 * differ from HEAD, not what they now contain, so editing a already-dirty file
 * twice yields the same digest. It catches the case that actually happens —
 * work appearing or disappearing between a capture and its use — at the cost
 * of one cheap command rather than hashing a monorepo.
 *
 * ponytail: porcelain digest, not a content hash. Move to `git stash create`
 * or a content tree-hash if a same-set-different-content edit ever matters.
 *
 * Never throws. An unreadable repository yields an EMPTY state rather than a
 * guess, and `freshness()` reads a missing tree as `indeterminate` — so a
 * broken git invocation blocks a gate instead of silently licensing it.
 */
export async function worldStateOf(dir: string | undefined, exec: ExecLike = realExec): Promise<WorldState> {
  if (!dir) return {}
  const [head, tree] = await Promise.all([
    headOf(dir, exec),
    treeDigestOf(dir, exec),
  ])
  return { ...(head ? { head } : {}), ...(tree ? { tree } : {}) }
}

async function headOf(dir: string, exec: ExecLike): Promise<string | undefined> {
  try {
    const out = await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })
    return out.trim() || undefined
  } catch {
    // An unborn HEAD is a real state for a fresh checkout, not an error worth
    // propagating; the absent value is the honest answer either way.
    return undefined
  }
}

/**
 * A stable digest of the dirty set, or undefined when git could not be read.
 *
 * A CLEAN tree digests to a real value rather than to nothing: "clean" is a
 * state a fact can be pinned to, and returning undefined for it would make
 * every capture on a clean checkout permanently indeterminate — which would
 * block every gate rather than pass them, but for the wrong reason.
 */
async function treeDigestOf(dir: string, exec: ExecLike): Promise<string | undefined> {
  try {
    const out = await exec('git', ['status', '--porcelain'], { cwd: dir })
    const lines = out.split('\n').map(l => l.trimEnd()).filter(Boolean).sort()
    return createHash('sha256').update(lines.join('\n')).digest('hex')
  } catch {
    return undefined
  }
}
