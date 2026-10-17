/**
 * Starts the CI check poller with the server. CI_POLLER_DISABLED=1 keeps a
 * test or smoke boot from shelling out to gh on a timer.
 */
import { setVerificationStarter, startCiPoller } from '../utils/ciPoller.ts'
import { startVerificationRun } from '../utils/verificationRunStarter.ts'

export default defineNitroPlugin(() => {
  if (process.env.CI_POLLER_DISABLED === '1') return
  // A merged PR starts Runbook V for its ticket. Wired here, not in ciPoller.ts,
  // so that module stays importable by the plain-node tests without pulling the
  // whole runner in.
  setVerificationStarter(s => startVerificationRun({ ...s, autoRun: true }))
  startCiPoller()
})
