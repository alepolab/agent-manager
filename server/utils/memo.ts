/**
 * Small in-memory memo for expensive directory scans. Each key caches one
 * promise for `ttlMs`; a write route calls invalidate() so the next read sees
 * the change immediately instead of waiting out the TTL. Process-wide by
 * design: the scanned tree is the same for every request.
 */
const entries = new Map<string, { at: number, value: Promise<unknown> }>()

export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = entries.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>
  const value = fn()
  entries.set(key, { at: Date.now(), value })
  // A failed scan must not be served from cache.
  value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key) })
  return value
}

/** Drop every cached entry whose key starts with the prefix. */
export function invalidate(prefix: string): void {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
}

/** Test seam. */
export function _clear(): void { entries.clear() }
