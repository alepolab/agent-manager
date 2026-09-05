/**
 * Starts the CI check poller with the server. CI_POLLER_DISABLED=1 keeps a
 * test or smoke boot from shelling out to gh on a timer.
 */
import { startCiPoller } from '../utils/ciPoller.ts'

export default defineNitroPlugin(() => {
  if (process.env.CI_POLLER_DISABLED === '1') return
  startCiPoller()
})
