import { requireCapability } from '../../../../utils/session'
import { invalidate } from '../../../../utils/memo'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  MAX_ATTACHMENT_BYTES, attachmentPath, listAttachments, requireEditableSkill, syncAttachmentsSection,
} from '../../../../utils/skillAttachments'

/**
 * Upload one or more files (multipart, any field name) into the skill's folder.
 * A file goes to the `folder` field's path (e.g. `scripts/curl`) when given,
 * else to `attachments/`. A file at the same path is replaced. SKILL.md's
 * managed Attachments section is rewritten so Claude knows the files exist.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const skill = requireEditableSkill(event)

  const form = await readMultipartFormData(event) ?? []
  const parts = form.filter(p => p.filename)
  const folder = form.find(p => !p.filename && p.name === 'folder')?.data.toString('utf-8').trim().replace(/^\/+|\/+$/g, '')
  if (!parts.length) throw createError({ statusCode: 400, message: 'No files in the upload' })

  // Check every file before writing any, so a rejected upload leaves nothing half done.
  const files = parts.map((p) => {
    if (p.data.length > MAX_ATTACHMENT_BYTES) {
      throw createError({ statusCode: 413, message: `"${p.filename}" is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit` })
    }
    return { path: attachmentPath(skill, folder ? `${folder}/${p.filename}` : p.filename!), data: p.data }
  })

  for (const f of files) {
    await mkdir(dirname(f.path), { recursive: true })
    await writeFile(f.path, f.data)
  }
  await syncAttachmentsSection(skill)
  invalidate('skills'); invalidate('relationships')

  return {
    attachments: await listAttachments(skill),
    // The page adopts this so its next Save is not refused as a change made elsewhere.
    lastModified: (await stat(skill.file)).mtimeMs,
  }
})
