import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../../utils/path'
import { requireCapability } from '../../utils/session'

export default defineEventHandler(async (event) => {
  // `configure`, matching claude-md.put.ts beside it. The write was guarded and
  // the read was not, which is the asymmetry worth naming: this returns the
  // contents of a file under a path the caller chooses, so it leaks exactly what
  // the guarded route protects. Its only caller is the CLI chat interface, which
  // is already `configure`-gated in the UI.
  await requireCapability(event, 'configure')
  const query = getQuery(event)
  const path = query.path as string

  if (!path) {
    throw createError({ statusCode: 400, message: 'Path is required' })
  }

  const expandedPath = resolveHome(path)
  const claudeMdPath = join(expandedPath, 'CLAUDE.md')

  if (!existsSync(claudeMdPath)) {
    return { exists: false, content: '', path: claudeMdPath }
  }

  try {
    const content = await readFile(claudeMdPath, 'utf-8')
    return { exists: true, content, path: claudeMdPath }
  } catch (e) {
    console.error(`Failed to read CLAUDE.md for ${path}:`, e)
    return { exists: false, content: '', path: claudeMdPath }
  }
})
