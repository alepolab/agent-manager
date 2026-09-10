import { listPublicChannels } from '../../utils/channels.ts'

/** Every configured channel, without its webhook. The URL is write-only once saved. */
export default defineEventHandler(async () => {
  return { channels: await listPublicChannels() }
})
