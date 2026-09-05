import { existsSync } from 'node:fs'
import { lstat, mkdir, readlink, readdir, readFile, symlink, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve as pathResolve } from 'node:path'
import type { GithubImport, SkillFrontmatter } from '~/types'
import { resolveClaudePath } from './claudeDir'
import { parseFrontmatter } from './frontmatter'

/** `child` is under `parent` (POSIX-style paths after resolve). */
function isUnderClaudePath(parent: string, child: string): boolean {
  const p = pathResolve(parent).replace(/\\/g, '/')
  const c = pathResolve(child).replace(/\\/g, '/')
  return c === p || c.startsWith(`${p}/`)
}

/** Map skill slug -> absolute directory path that should become ~/.claude/skills/<slug> (folder containing the skill markdown). */
export async function resolveGithubImportSkillDirs(entry: GithubImport): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  const scanRoot = entry.targetPath
    ? join(entry.localPath, entry.targetPath)
    : entry.localPath

  if (!existsSync(scanRoot) || !existsSync(entry.localPath)) return out

  const indexPathCandidates = [
    join(entry.localPath, 'skills-index.json'),
    join(scanRoot, 'skills-index.json'),
  ]
  const indexPath = indexPathCandidates.find(p => existsSync(p))

  if (indexPath) {
    try {
      const raw = await readFile(indexPath, 'utf-8')
      const index = JSON.parse(raw) as {
        skills?: Array<{
          slug: string
          files?: string[]
          path?: string
        }>
      }
      const targetPrefix = entry.targetPath || ''
      const list = (index.skills || []).filter(s => !!s.slug).filter(s => {
        if (!targetPrefix) return true
        const filePath = s.files?.[0] || s.path || ''
        return filePath.startsWith(targetPrefix)
      })
      for (const s of list) {
        const relFile = s.files?.[0] || s.path || ''
        if (!relFile) continue
        const absFile = join(entry.localPath, relFile)
        if (!existsSync(absFile)) continue
        const dir = dirname(absFile)
        if (!out.has(s.slug)) out.set(s.slug, dir)
      }
      if (out.size > 0) return out
    } catch {
      // fall through
    }
  }

  const SKIP_FILENAMES = new Set<string>([
    'README.md', 'readme.md',
    'CHANGELOG.md', 'changelog.md',
    'CONTRIBUTING.md', 'contributing.md',
    'LICENSE.md', 'license.md',
    'CODE_OF_CONDUCT.md',
  ])
  const skipLower = new Set([...SKIP_FILENAMES].map(s => s.toLowerCase()))

  const walk = async (dir: string) => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!item.isFile()) continue
      if (!item.name.toLowerCase().endsWith('.md')) continue
      if (skipLower.has(item.name.toLowerCase())) continue

      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter } = parseFrontmatter<SkillFrontmatter>(raw)
      if (!frontmatter.name || !frontmatter.description) continue

      const rel = relative(scanRoot, fullPath)
      const parts = rel.split(/[\\/]/).filter(Boolean)
      const fileName = parts.at(-1) || item.name
      const parentDir = parts.length >= 2 ? parts.at(-2) : undefined

      let slug = (fileName.toLowerCase() === 'skill.md' && parentDir)
        ? parentDir
        : fileName.replace(/\.md$/i, '')

      if ((slug.toLowerCase() === 'skill' || !slug) && frontmatter.name) {
        slug = frontmatter.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }

      if (!slug) continue
      if (!out.has(slug)) out.set(slug, dirname(fullPath))
    }
  }

  await walk(scanRoot)
  return out
}

/** Map agent slug -> absolute file path that should become ~/.claude/agents/<slug>.md. */
export async function resolveGithubImportAgentFiles(entry: GithubImport): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  const scanRoot = entry.targetPath
    ? join(entry.localPath, entry.targetPath)
    : entry.localPath

  if (!existsSync(scanRoot) || !existsSync(entry.localPath)) return out

  const SKIP_FILENAMES = new Set<string>([
    'README.md', 'readme.md',
    'CHANGELOG.md', 'changelog.md',
    'CONTRIBUTING.md', 'contributing.md',
    'LICENSE.md', 'license.md',
    'CODE_OF_CONDUCT.md',
  ])
  const skipLower = new Set([...SKIP_FILENAMES].map(s => s.toLowerCase()))

  const walk = async (dir: string) => {
    const items = await readdir(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const fullPath = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!item.isFile()) continue
      if (!item.name.toLowerCase().endsWith('.md')) continue
      if (skipLower.has(item.name.toLowerCase())) continue

      const raw = await readFile(fullPath, 'utf-8')
      const { frontmatter } = parseFrontmatter<any>(raw)
      
      // Detect Agent
      if (frontmatter.name && frontmatter.description && (fullPath.includes('agents/') || frontmatter.model || frontmatter.skills)) {
        const parts = fullPath.split('/')
        const fileName = parts.pop()!
        let slug = fileName.replace(/\.md$/, '')
        if (slug.toLowerCase() === 'agent' && parts.length > 0) {
          slug = parts[parts.length - 1] ?? ''
        }
        if (!slug) continue
        if (!out.has(slug)) out.set(slug, fullPath)
      }
    }
  }

  await walk(scanRoot)
  return out
}

export type GithubSymlinkSyncResult = {
  linked: string[]
  removed: string[]
  skippedConflicts: string[]
  missingInClone: string[]
}

/**
 * Create ~/.claude/skills/<slug> or ~/.claude/agents/<slug>.md based on type.
 */
export async function syncGithubImportSymlinks(
  entry: GithubImport,
  previousItems: string[],
  selectedItems: string[],
  type: 'skills' | 'agents'
): Promise<GithubSymlinkSyncResult> {
  const result: GithubSymlinkSyncResult = {
    linked: [],
    removed: [],
    skippedConflicts: [],
    missingInClone: [],
  }

  const root = resolveClaudePath(type)
  await mkdir(root, { recursive: true })

  const cloneRoot = pathResolve(entry.localPath)

  if (type === 'skills') {
    const slugToDir = await resolveGithubImportSkillDirs(entry)
    const previousSet = new Set(previousItems)
    const selectedSet = new Set(selectedItems)

    for (const slug of previousSet) {
      if (selectedSet.has(slug)) continue
      const linkPath = join(root, slug)
      if (!existsSync(linkPath)) continue
      try {
        const st = await lstat(linkPath)
        if (!st.isSymbolicLink()) continue
        const rawTarget = await readlink(linkPath)
        const absTarget = pathResolve(dirname(linkPath), rawTarget)
        if (!isUnderClaudePath(cloneRoot, absTarget)) continue
        await unlink(linkPath)
        result.removed.push(slug)
      } catch { }
    }

    for (const slug of selectedItems) {
      const skillDir = slugToDir.get(slug)
      if (!skillDir || !existsSync(skillDir)) {
        result.missingInClone.push(slug)
        continue
      }
      const target = pathResolve(skillDir)
      const linkPath = join(root, slug)
      try {
        if (existsSync(linkPath)) {
          const st = await lstat(linkPath)
          if (st.isSymbolicLink()) await unlink(linkPath)
          else { result.skippedConflicts.push(slug); continue }
        }
        await symlink(target, linkPath, 'dir')
        result.linked.push(slug)
      } catch { result.skippedConflicts.push(slug) }
    }
  } else {
    const slugToFile = await resolveGithubImportAgentFiles(entry)
    const previousSet = new Set(previousItems)
    const selectedSet = new Set(selectedItems)

    for (const slug of previousSet) {
      if (selectedSet.has(slug)) continue
      const linkPath = join(root, `${slug}.md`)
      if (!existsSync(linkPath)) continue
      try {
        const st = await lstat(linkPath)
        if (!st.isSymbolicLink()) continue
        const rawTarget = await readlink(linkPath)
        const absTarget = pathResolve(dirname(linkPath), rawTarget)
        if (!isUnderClaudePath(cloneRoot, absTarget)) continue
        await unlink(linkPath)
        result.removed.push(slug)
      } catch { }
    }

    for (const slug of selectedItems) {
      const file = slugToFile.get(slug)
      if (!file || !existsSync(file)) {
        result.missingInClone.push(slug)
        continue
      }
      const target = pathResolve(file)
      const linkPath = join(root, `${slug}.md`)
      try {
        if (existsSync(linkPath)) {
          const st = await lstat(linkPath)
          if (st.isSymbolicLink()) await unlink(linkPath)
          else { result.skippedConflicts.push(slug); continue }
        }
        await symlink(target, linkPath, 'file')
        result.linked.push(slug)
      } catch { result.skippedConflicts.push(slug) }
    }
  }

  return result
}
