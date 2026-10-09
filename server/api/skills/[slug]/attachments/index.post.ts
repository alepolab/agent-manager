import { requireCapability } from '../../../../utils/session'
import { invalidate } from '../../../../utils/memo'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ATTACHMENTS_DIR, MAX_ATTACHMENT_BYTES, attachmentPath, listAttachments, requireEditableSkill, syncAttachmentsSection,
} from '../../../../utils/skillAttachments'

/**
 * Upload one or more files (multipart, any field name) into the skill's
 * `attachments/` directory. A file with the same name is replaced. SKILL.md's
 * managed Attachments section is rewritten so Claude knows the files exist.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const skill = requireEditableSkill(event)

  const parts = (await readMultipartFormData(event))?.filter(p => p.filename) ?? []
  if (!parts.length) throw createError({ statusCode: 400, message: 'No files in the upload' })

  // Check every file before writing any, so a rejected upload leaves nothing half done.
  const files = parts.map((p) => {
    if (p.data.length > MAX_ATTACHMENT_BYTES) {
      throw createError({ statusCode: 413, message: `"${p.filename}" is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit` })
    }
    return { path: attachmentPath(skill, p.filename!), data: p.data }
  })

  await mkdir(join(skill.dir, ATTACHMENTS_DIR), { recursive: true })
  for (const f of files) await writeFile(f.path, f.data)
  await syncAttachmentsSection(skill)
  invalidate('skills'); invalidate('relationships')

  return {
    attachments: await listAttachments(skill),
    // The page adopts this so its next Save is not refused as a change made elsewhere.
    lastModified: (await stat(skill.file)).mtimeMs,
  }
})
