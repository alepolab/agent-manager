import { readdir, stat, access } from 'node:fs/promises'
import { join, basename, relative, sep } from 'node:path'
import { constants } from 'node:fs'

interface FileTreeItem {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'directory'
  size: number
  modified: string | null
  extension: string
  children?: FileTreeItem[]
}

async function getFileTree(dirPath: string, rootPath: string, maxDepth = 3, currentDepth = 0, showHidden = true): Promise<FileTreeItem[]> {
  const items: FileTreeItem[] = []

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!showHidden && entry.name.startsWith('.')) continue
      
      // Skip heavy build directories and VCS directories
      if (['node_modules', 'dist', 'build', '.git', '.nuxt', '.output'].includes(entry.name)) continue

      const fullPath = join(dirPath, entry.name)
      const relPath = relative(rootPath, fullPath)
      
      const item: FileTreeItem = {
        name: entry.name,
        path: fullPath,
        relativePath: relPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        extension: entry.name.includes('.') ? entry.name.split('.').pop() || '' : ''
      }

      try {
        const stats = await stat(fullPath)
        item.size = stats.size
        item.modified = stats.mtime.toISOString()
      } catch (e) {
        // Stats might fail for some files
      }

      if (entry.isDirectory() && currentDepth < maxDepth) {
        try {
          await access(fullPath, constants.R_OK)
          item.children = await getFileTree(fullPath, rootPath, maxDepth, currentDepth + 1, showHidden)
        } catch (e) {
          item.children = []
        }
      }

      items.push(item)
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error)
  }

  // Sort: directories first, then alphabetically
  return items.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'directory' ? -1 : 1
  })
}

import { resolveProjectPath } from '../../../utils/projects'

export default defineEventHandler(async (event) => {
  const projectName = getRouterParam(event, 'projectName')
  if (!projectName) {
    throw createError({ statusCode: 400, message: 'Project name is required' })
  }

  // Resolution is a lookup, not an HTTP call. It used to $fetch our own
  // /api/projects routes, which the auth middleware rejected with 401 in
  // team mode — and the catch below turned that into a silently wrong
  // directory rather than an error.
  const projectPath = await resolveProjectPath(projectName)

  try {
    await access(projectPath)
  } catch (e) {
    throw createError({ statusCode: 404, message: `Project path not found: ${projectPath}` })
  }

  const query = getQuery(event)
  const maxDepth = parseInt(query.maxDepth as string) || 3
  const showHidden = query.showHidden === 'true'

  return await getFileTree(projectPath, projectPath, maxDepth, 0, showHidden)
})
