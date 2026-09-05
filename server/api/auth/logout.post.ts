import { authSession } from '../../utils/session'
export default defineEventHandler(async (event) => {
  const session = await authSession(event)
  await session.clear()
  return { ok: true }
})
