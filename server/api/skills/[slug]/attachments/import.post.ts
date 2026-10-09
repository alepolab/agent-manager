import { requireCapability } from '../../../../utils/session'
import { invalidate } from '../../../../utils/memo'
import { stat } from 'node:fs/promises'
import { importSkillFolder, listAttachments, requireEditableSkill } from '../../../../utils/skillAttachments'

/**
 * Bring a skill folder on this machine into this skill, scripts and references
 * at their own paths. `apply: false` (the default) only previews what would
 * change; `skillFile: true` also replaces SKILL.md with the source's.
 */
export default defineEventHandler(async (event) => {
  await requireCapability(event, 'configure')
  const skill = requireEditableSkill(event)
  const body = await readBody<{ source?: string, apply?: boolean, skillFile?: boolean }>(event)
  if (!body?.source?.trim()) throw createError({ statusCode: 400, message: 'Give the folder to import from' })

  const result = await importSkillFolder(skill, body.source.trim(), { apply: !!body.apply, skillFile: !!body.skillFile })
  if (result.applied) { invalidate('skills'); invalidate('relationships') }

  return {
    ...result,
    attachments: await listAttachments(skill),
    lastModified: (await stat(skill.file)).mtimeMs,
  }
})
