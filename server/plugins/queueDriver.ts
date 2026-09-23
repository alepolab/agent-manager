/**
 * Keeps the work queue moving without anyone pressing anything.
 *
 * `onRunSettled` in the runner starts the next task when one finishes, which
 * covers the steady state and nothing else. It does not cover a queue that was
 * created while nothing was running, and it does not survive a restart: the
 * process that would have dispatched is the one that went away. So a queue
 * with twenty-three pending tasks sat idle until a signed-in human clicked a
 * button, every boot — which is the opposite of "start them one after
 * another", and on an instance with auth on it meant the queue could not be
 * driven at all without a browser session.
 *
 * Two triggers, both cheap:
 *
 *  - once at boot, after the same delay resumeInterrupted uses, because
 *    teamSeed rewrites the workflow files at boot and a dispatch that read one
 *    mid-write would start a run against half a workflow;
 *  - then on an interval, as the backstop for the case `onRunSettled` cannot
 *    see: a run whose process died leaves its task `running` with nothing left
 *    to fire the hook, and only a later pass reconciles it and moves on.
 *
 * Dispatching is already idempotent and already refuses past the capacity cap
 * and the workspace lock, so a tick that finds nothing to do costs one file
 * read. QUEUE_DRIVER=0 turns it off.
 */
import { dispatchQueue } from '../utils/queueDispatcher.ts'

/** Long enough that a quiet instance is not polling for nothing, short enough
 *  that a stranded queue recovers within one coffee. */
const EVERY_MS = 60_000
const BOOT_DELAY_MS = 5_000

export default defineNitroPlugin(() => {
  if (process.env.QUEUE_DRIVER === '0') return

  const tick = async (why: string) => {
    try {
      const r = await dispatchQueue()
      if (r.started.length) console.log(`[queue] ${why}: started ${r.started.join(', ')}`)
    } catch (err) {
      // A queue that cannot dispatch must never take the server down with it.
      console.error('[queue] dispatch failed:', err instanceof Error ? err.message : err)
    }
  }

  setTimeout(() => {
    void tick('boot')
    const timer = setInterval(() => void tick('tick'), EVERY_MS)
    // Nitro tears the process down on its own; unref so a pending timer is
    // never the reason it lingers.
    timer.unref?.()
  }, BOOT_DELAY_MS)
})
