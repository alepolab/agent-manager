import { listAttachments, requireEditableSkill } from '../../../../utils/skillAttachments'

export default defineEventHandler(async (event) => {
  const skill = requireEditableSkill(event)
  return { attachments: await listAttachments(skill) }
})
