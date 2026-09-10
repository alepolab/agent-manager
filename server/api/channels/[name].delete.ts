import { deleteChannel } from '../../utils/channels.ts'

export default defineEventHandler(async (event) => {
  const name = decodeURIComponent(getRouterParam(event, 'name')!)
  if (!await deleteChannel(name)) throw createError({ statusCode: 404, message: `No channel named "${name}"` })
  return { deleted: name }
})
