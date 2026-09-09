import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface ArtifactFile { name: string, size: number }

/** Test seam: the two filesystem calls the walk makes. */
export interface ListDeps {
  readdir: typeof readdir
  stat: typeof stat
}

/**
 * Every file under a run's artifacts directory, with sizes.
 *
 * The whole difficulty is that this directory is READ WHILE IT IS WRITTEN. The
 * Runs page polls it during a live run, and the agent underneath is creating and
 * deleting scratch files as it works. `readdir` then `stat` is therefore a
 * time-of-check/time-of-use race by construction, and losing it is normal rather
 * than exceptional:
 *
 *   ENOENT: no such file or directory, statx '.../artifacts/oracle/raw-3.txt'
 *   statusCode: 500, unhandled: true
 *
 * One scratch file that existed a millisecond ago took down the entire listing —
 * so the page showed nothing at all, at exactly the moment someone was watching
 * a run to see what it was doing.
 *
 * A vanished entry is skipped, not fatal. It is the correct answer, not a
 * degraded one: the file genuinely is not there any more, and a listing of a
 * moving directory is a snapshot either way. The same applies to a whole
 * subdirectory disappearing mid-walk.
 *
 * Anything that is NOT "it disappeared" still throws. A permissions error or a
 * broken mount is a real fault, and swallowing those would turn this into the
 * silent-empty failure this codebase keeps finding: an empty artifact list that
 * looks exactly like a run which produced nothing.
 */
const GONE = new Set(['ENOENT', 'ENOTDIR'])

export async function listArtifactFiles(root: string, deps: ListDeps = { readdir, stat }): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = []

  async function walk(dir: string) {
    let entries
    try {
      entries = await deps.readdir(dir, { withFileTypes: true })
    } catch (err: any) {
      if (GONE.has(err?.code)) return
      throw err
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          out.push({ name: relative(root, full), size: (await deps.stat(full)).size })
        } catch (err: any) {
          if (!GONE.has(err?.code)) throw err
        }
      }
    }
  }

  await walk(root)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
