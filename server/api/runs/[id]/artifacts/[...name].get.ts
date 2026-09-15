import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { artifactContentType, runArtifactsDir } from '../../../../utils/runArtifacts'

/** 512 KB is plenty for any report or xunit file; a bigger file is truncated with a marker. */
const MAX_BYTES = 512 * 1024

/** Screenshots run to a few hundred KB and a full-page one can pass a megabyte. */
const MAX_BINARY_BYTES = 8 * 1024 * 1024

/** One artifact file. Text is returned as text; an image as itself. The path must stay inside the run's artifacts directory. */
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
  const type = artifactContentType(name)
  if (type) {
    if (size > MAX_BINARY_BYTES) {
      throw createError({ statusCode: 413, message: `That artifact is ${Math.round(size / 1024 / 1024)} MB; the console serves images up to ${MAX_BINARY_BYTES / 1024 / 1024} MB.` })
    }
    setHeader(event, 'content-type', type)
    // Truncating an image produces a broken one rather than a shorter one, so
    // the whole file goes or none of it does.
    return await readFile(full)
  }
  const buf = await readFile(full)
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  const text = buf.subarray(0, MAX_BYTES).toString('utf8')
  return size > MAX_BYTES ? `${text}\n\n[truncated: ${size} bytes total, first ${MAX_BYTES} shown]` : text
})
