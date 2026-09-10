import { getPublicSmtp } from '../utils/channels.ts'

/** The instance's SMTP settings without the password. */
export default defineEventHandler(async () => {
  return { smtp: await getPublicSmtp() }
})
