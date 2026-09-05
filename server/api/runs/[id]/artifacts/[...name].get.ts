import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { runArtifactsDir } from '../../../../utils/runArtifacts'

/** 512 KB is plenty for any report or xunit file; a bigger file is truncated with a marker. */
const MAX_BYTES = 512 * 1024

/** One artifact file as text. The path must stay inside the run's artifacts directory. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const name = getRouterParam(event, 'name') ?? ''
  const root = resolve(runArtifactsDir(id))
  const full = resolve(root, name)
  if (full !== root && !full.startsWith(root + sep)) {
    throw createError({ statusCode: 400, message: 'Artifact path must stay inside the run' })
  }
  let size: number
  try { size = (await stat(full)).size } catch { throw createError({ statusCode: 404, message: 'Artifact not found' }) }
  const buf = await readFile(full)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  const text = buf.subarray(0, MAX_BYTES).toString('utf8')
  return size > MAX_BYTES ? `${text}\n\n[truncated: ${size} bytes total, first ${MAX_BYTES} shown]` : text
})
