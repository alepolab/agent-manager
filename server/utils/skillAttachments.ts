import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { resolveClaudePath, safeSegment } from './claudeDir'
import type { SkillAttachment } from '~/types'

/** Per-file cap on an upload. Claude reads text, PDFs and images straight off disk; anything bigger is rarely worth a skill's context. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export const ATTACHMENTS_DIR = 'attachments'

const SECTION_START = '<!-- attachments:start - managed by Agent Manager, edits here are replaced -->'
const SECTION_END = '<!-- attachments:end -->'
const SECTION_RE = /\n*<!-- attachments:start[^>]*-->[\s\S]*?<!-- attachments:end -->\n?/

export interface EditableSkill {
  /** The skill's own directory, where `attachments/` lives beside SKILL.md. */
  dir: string
  /** The markdown file the managed Attachments section is written into. */
  file: string
}

/**
 * The directory of a skill that this instance may add files to, or null.
 *
 * Same lookup order as `GET /api/skills/[slug]`: a project's skills first when a
 * workingDir is given, then the personal ones. GitHub and plugin skills are not
 * looked at - they are read-only here and their next update would drop the files.
 *
 * The workingDir comes off the query string, so a write only ever lands in a
 * directory that already holds a skill file: it cannot make one up elsewhere.
 */
export function resolveEditableSkill(slug: string, workingDir?: string): EditableSkill | null {
  if (!slug || slug !== safeSegment(slug)) return null

  const dirs: string[] = []
  if (workingDir && isAbsolute(workingDir)) {
    dirs.push(join(workingDir, '.claude', 'skills', slug), join(workingDir, 'skills', slug))
  }
  dirs.push(resolveClaudePath('skills', slug))

  for (const dir of dirs) {
    for (const name of ['SKILL.md', `${slug}.md`]) {
      const file = join(dir, name)
      if (existsSync(file)) return { dir, file }
    }
  }
  return null
}

export function requireEditableSkill(event: any): EditableSkill {
  const slug = getRouterParam(event, 'slug')!
  const { workingDir } = getQuery(event) as { workingDir?: string }
  const skill = resolveEditableSkill(slug, workingDir)
  if (!skill) throw createError({ statusCode: 404, message: `No editable skill named "${slug}"` })
  return skill
}

/**
 * A browser-supplied file name reduced to one safe segment. Spaces and anything
 * outside a plain set become `_` so the name drops into a markdown link as is.
 */
export function attachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '').slice(0, 120)
  if (!cleaned || !/[A-Za-z0-9]/.test(cleaned)) {
    throw createError({ statusCode: 400, message: `"${name}" is not a usable file name` })
  }
  return cleaned
}

/** The on-disk path of one attachment, checked to stay inside the skill's attachments directory. */
export function attachmentPath(skill: EditableSkill, name: string): string {
  const base = resolve(skill.dir, ATTACHMENTS_DIR)
  const path = resolve(base, attachmentName(name))
  if (!path.startsWith(base + sep)) {
    throw createError({ statusCode: 400, message: `"${name}" is not a usable file name` })
  }
  return path
}

export async function listAttachments(skill: EditableSkill): Promise<SkillAttachment[]> {
  const dir = join(skill.dir, ATTACHMENTS_DIR)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'))
  const attachments = await Promise.all(files.map(async (e) => {
    const s = await stat(join(dir, e.name))
    return { name: e.name, path: `${ATTACHMENTS_DIR}/${e.name}`, size: s.size, modifiedAt: s.mtimeMs }
  }))
  return attachments.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Rewrite the managed `## Attachments` section at the end of the skill file so
 * it lists exactly the files on disk. Claude only opens a skill's extra files
 * when SKILL.md names them, so this list is what makes an upload usable.
 *
 * Works on the raw text rather than parse-and-serialize so the frontmatter and
 * the rest of the body are written back byte for byte.
 */
export async function syncAttachmentsSection(skill: EditableSkill): Promise<void> {
  const attachments = await listAttachments(skill)
  const raw = await readFile(skill.file, 'utf-8')
  const without = raw.replace(SECTION_RE, '\n').replace(/\s+$/, '')

  let next = without + '\n'
  if (attachments.length) {
    const lines = attachments.map(a => `- [${a.name}](${a.path})`)
    next = [
      without,
      '',
      SECTION_START,
      '## Attachments',
      '',
      'Reference files bundled with this skill, relative to this file. Read the ones the task needs.',
      '',
      ...lines,
      SECTION_END,
      '',
    ].join('\n')
  }
  if (next !== raw) await writeFile(skill.file, next, 'utf-8')
}
