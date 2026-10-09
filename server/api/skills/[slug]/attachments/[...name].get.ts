import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { attachmentPath, requireEditableSkill } from '../../../../utils/skillAttachments'

export default defineEventHandler(async (event) => {
  const skill = requireEditableSkill(event)
  const name = getRouterParam(event, 'name')!
  const path = attachmentPath(skill, name)
  if (!existsSync(path)) throw createError({ statusCode: 404, message: `No attachment named "${name}"` })

  setResponseHeaders(event, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String((await stat(path)).size),
    'Content-Disposition': `attachment; filename="${name.split('/').pop()!.replace(/"/g, '')}"`,
  })
  return sendStream(event, createReadStream(path))
})
