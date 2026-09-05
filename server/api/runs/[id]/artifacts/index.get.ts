import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runArtifactsDir } from '../../../../utils/runArtifacts'

/** Every file under a run's artifacts directory, as relative paths with sizes. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const root = runArtifactsDir(id)
  if (!existsSync(root)) return []
  const out: { name: string, size: number }[] = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push({ name: relative(root, full), size: (await stat(full)).size })
    }
  }
  await walk(root)
  return out.sort((a, b) => a.name.localeCompare(b.name))
})
