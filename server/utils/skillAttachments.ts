import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

/**
 * A skill's files are everything in its folder but the skill file itself, at the
 * paths SKILL.md uses for them (`references/x.md`, `scripts/curl/lib.mjs`). An
 * upload with a bare name lands in `attachments/`. Hidden entries and build
 * leftovers are not part of a skill.
 */
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__'])
const SKIPPED_FILE = /\.pyc$/

/** A skill-relative path made of safe segments, e.g. `scripts/curl/lib.mjs`. A bare name goes under `attachments/`. */
export function skillFilePath(name: string): string {
  const parts = name.split(/[\\/]/).filter(p => p && p !== '.')
  if (!parts.length || parts.some(p => p === '..')) {
    throw createError({ statusCode: 400, message: `"${name}" is not a usable file path` })
  }
  const segs = parts.map(attachmentName)
  return (segs.length === 1 ? [ATTACHMENTS_DIR, ...segs] : segs).join('/')
}

/** The on-disk path of one skill file, checked to stay inside the skill's folder and never to be the skill file itself. */
export function attachmentPath(skill: EditableSkill, name: string): string {
  const base = resolve(skill.dir)
  const path = resolve(base, skillFilePath(name))
  if (!path.startsWith(base + sep) || path === resolve(skill.file)) {
    throw createError({ statusCode: 400, message: `"${name}" is not a usable file path` })
  }
  return path
}

/** Every file under `dir` that belongs to a skill, as posix paths relative to `dir`. */
async function walkSkillDir(dir: string, skip?: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) { if (!SKIPPED_DIRS.has(e.name)) await walk(full); continue }
      if (!e.isFile() || SKIPPED_FILE.test(e.name) || full === skip) continue
      out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  if (existsSync(dir)) await walk(dir)
  return out.sort()
}

export async function listAttachments(skill: EditableSkill): Promise<SkillAttachment[]> {
  const paths = await walkSkillDir(skill.dir, resolve(skill.file))
  const attachments = await Promise.all(paths.map(async (path) => {
    const s = await stat(join(skill.dir, path))
    return { name: path.split('/').pop()!, path, size: s.size, modifiedAt: s.mtimeMs }
  }))
  // Folder by folder, so the list reads like the tree it is.
  return attachments.sort((a, b) => a.path.localeCompare(b.path))
}

export interface SkillImportResult {
  added: string[]
  changed: string[]
  unchanged: number
  /** The source's skill file differs from this one's (the managed Attachments section aside). */
  skillFileDiffers: boolean
  skillFileUpdated: boolean
  applied: boolean
}

/** The skill file's text without the managed section, which is ours and never part of a comparison. */
function skillBody(raw: string): string {
  return raw.replace(SECTION_RE, '\n').replace(/\s+$/, '')
}

/**
 * Copy a skill folder on this machine (a project's `.claude/skills/<name>`) into
 * this skill, keeping each file's path and its executable bit. Files only this
 * skill has are kept: an import adds and updates, it never deletes. The skill
 * file is replaced only when asked, and keeps its managed section either way.
 * With `apply` false nothing is written and the result is the preview.
 */
export async function importSkillFolder(skill: EditableSkill, source: string, opts: { apply: boolean, skillFile: boolean }): Promise<SkillImportResult> {
  if (!isAbsolute(source)) throw createError({ statusCode: 400, message: 'The folder must be an absolute path' })
  const src = resolve(source)
  const srcFile = ['SKILL.md', `${src.split(sep).pop()}.md`].map(n => join(src, n)).find(f => existsSync(f))
  if (!srcFile) throw createError({ statusCode: 400, message: `${src} is not a skill folder: it has no SKILL.md` })
  if (src === resolve(skill.dir)) throw createError({ statusCode: 400, message: 'That is this skill\'s own folder' })

  const result: SkillImportResult = { added: [], changed: [], unchanged: 0, skillFileDiffers: false, skillFileUpdated: false, applied: opts.apply }
  const copies: string[] = []
  for (const path of await walkSkillDir(src, srcFile)) {
    const from = join(src, path)
    const to = attachmentPath(skill, path)
    if (!existsSync(to)) { result.added.push(path); copies.push(path); continue }
    const [a, b] = await Promise.all([readFile(from), readFile(to)])
    if (a.equals(b)) result.unchanged++
    else { result.changed.push(path); copies.push(path) }
  }
  const [srcBody, ownBody] = [skillBody(await readFile(srcFile, 'utf-8')), skillBody(await readFile(skill.file, 'utf-8'))]
  result.skillFileDiffers = srcBody !== ownBody

  if (!opts.apply) return result
  // Check every file before writing any, so a refused import leaves nothing half done.
  const modes = new Map<string, number>()
  for (const path of copies) {
    const s = await stat(join(src, path))
    if (s.size > MAX_ATTACHMENT_BYTES) throw createError({ statusCode: 413, message: `"${path}" is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit` })
    modes.set(path, s.mode & 0o777)
  }
  for (const path of copies) {
    const to = attachmentPath(skill, path)
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(src, path), to)
    await chmod(to, modes.get(path)!)
  }
  if (opts.skillFile && result.skillFileDiffers) {
    await writeFile(skill.file, `${srcBody}\n`, 'utf-8')
    result.skillFileUpdated = true
  }
  await syncAttachmentsSection(skill)
  return result
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
      'Files bundled with this skill (references, scripts, templates), relative to this file. Read or run the ones the task needs.',
      '',
      ...lines,
      SECTION_END,
      '',
    ].join('\n')
  }
  if (next !== raw) await writeFile(skill.file, next, 'utf-8')
}
