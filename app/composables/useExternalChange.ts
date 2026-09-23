/**
 * Background refresh for an editor. A version saved elsewhere replaces the
 * editor's content when there are no unsaved edits; over unsaved edits it is
 * only offered (`pending`), never applied.
 */
export function useExternalChange<T>(opts: {
  fetch: () => Promise<T>
  /** The saved content the editor last loaded or wrote, in the shape `content` returns. */
  baseline: () => unknown
  content: (item: T) => unknown
  isDirty: () => boolean
  apply: (item: T) => void
  /** Skip the tick, e.g. while loading or saving. */
  paused?: () => boolean
}) {
  const pending = shallowRef<T | null>(null)
  // The version the user chose to keep their edits over, so it isn't offered again.
  let kept = ''

  useAutoRefresh(async () => {
    if (opts.paused?.()) return
    const before = JSON.stringify(opts.baseline())
    const latest = await opts.fetch()
    // A save or reload landed while this fetch was out; its answer is newer than ours.
    if (opts.paused?.() || JSON.stringify(opts.baseline()) !== before) return
    const key = JSON.stringify(opts.content(latest))
    if (key === before) {
      pending.value = null
      return
    }
    if (!opts.isDirty()) {
      pending.value = null
      opts.apply(latest)
      return
    }
    if (key !== kept) pending.value = latest
  })

  function reload() {
    if (pending.value) opts.apply(pending.value)
    pending.value = null
  }

  /** Dismisses the offer and returns the version dismissed, so the caller can adopt its timestamp. */
  function keepMine(): T | null {
    const item = pending.value
    if (item) kept = JSON.stringify(opts.content(item))
    pending.value = null
    return item
  }

  return { pending, reload, keepMine }
}
