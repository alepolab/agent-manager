import { requireCapability } from '../../../../utils/session'
import { invalidate } from '../../../../utils/memo'
import { existsSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { attachmentPath, listAttachments, requireEditableSkill, syncAttachmentsSection } from '../../../../utils/skillAttachments'

export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const skill = requireEditableSkill(event)
  const name = getRouterParam(event, 'name')!
  const path = attachmentPath(skill, name)
  if (!existsSync(path)) throw createError({ statusCode: 404, message: `No attachment named "${name}"` })

  await rm(path)
  await syncAttachmentsSection(skill)
  invalidate('skills'); invalidate('relationships')

  return {
    attachments: await listAttachments(skill),
    lastModified: (await stat(skill.file)).mtimeMs,
  }
})
