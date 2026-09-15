/**
 * Re-runs `fn` while the page is mounted so data changed elsewhere (another tab,
 * a watch, a schedule, team sync) shows up without a browser reload.
 *
 * Polls only while the tab is visible, and again when the tab regains focus.
 * Does not run on mount: the page keeps its own initial load. `fn` should be
 * silent (no loading flag, no error toast), since it fires unprompted.
 */
export function useAutoRefresh(fn: () => unknown, opts: { interval?: number, focus?: boolean } = {}) {
  if (!import.meta.client) return
  const interval = opts.interval ?? 30_000
  const focus = opts.focus ?? true

  let running = false
  let lastRun = 0
  let timer: ReturnType<typeof setInterval> | null = null

  async function tick() {
    if (running || document.visibilityState !== 'visible') return
    running = true
    try {
      await fn()
    } catch {
      // Background refresh: the next tick retries, and the page still shows the last good data.
    } finally {
      running = false
      lastRun = Date.now()
    }
  }

  // Tabbing back fires both visibilitychange and focus; one refetch is enough.
  function onReturn() {
    if (Date.now() - lastRun > 5_000) tick()
  }

  onMounted(() => {
    lastRun = Date.now()
    if (interval > 0) timer = setInterval(tick, interval)
    if (focus) {
      document.addEventListener('visibilitychange', onReturn)
      window.addEventListener('focus', onReturn)
    }
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
    document.removeEventListener('visibilitychange', onReturn)
    window.removeEventListener('focus', onReturn)
  })
}
