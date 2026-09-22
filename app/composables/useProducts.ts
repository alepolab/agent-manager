import type { Problem } from '~~/shared/registry/rules'

export interface ProductRow {
  key: string
  /** Position in the file. Shown because file order is the final routing tie-break. */
  position: number
  product: Record<string, any>
  /** The rationale block written above the entry. */
  comment: string
  recipe: boolean
  problems: Problem[]
}

export interface RegistryRead {
  ok: boolean
  /** The store exists but does not parse, so routing is running on the seed. */
  degraded: boolean
  path: string | null
  source: 'override' | 'store' | 'plugin' | 'shipped' | 'none'
  seed: { seededFrom: string, seededKind: string, seededAt: number } | null
  /** Sent back with every write; the server answers 409 when it has moved. */
  mtimeMs: number | null
  products: ProductRow[]
}

/**
 * The product registry, as the Products page reads and writes it.
 *
 * Every write carries the `mtimeMs` the page loaded with. Without it two tabs,
 * or two instances sharing a config directory, silently overwrite each other -
 * and what they would be overwriting is which repository a ticket clones.
 */
export function useProducts() {
  const registry = useState<RegistryRead | null>('registry', () => null)
  const loading = useState('registry-loading', () => false)
  const error = useState<string | null>('registry-error', () => null)

  async function load({ silent = false } = {}) {
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const next = await $fetch<RegistryRead>('/api/registry/products')
      // An unchanged background refresh must not hand consumers a new object:
      // /registry/[key] reads the same `registry` state this poll reassigns.
      if (silent && JSON.stringify(next) === JSON.stringify(registry.value)) return
      registry.value = next
      error.value = null
    } catch (e: any) {
      // The 30s poll fires unprompted — see useAutoRefresh. A transient failure
      // there must not paint an error banner over data that is still on screen.
      if (silent) return
      error.value = e?.data?.message || e?.message || 'Could not read the registry'
    } finally {
      if (!silent) loading.value = false
    }
  }

  const mtime = () => registry.value?.mtimeMs ?? undefined

  const create = (key: string, product: Record<string, any>, comment?: string) =>
    $fetch('/api/registry/products', { method: 'POST', body: { key, product, comment, mtimeMs: mtime() } })

  const update = (key: string, product: Record<string, any>, comment?: string) =>
    $fetch(`/api/registry/products/${encodeURIComponent(key)}`, { method: 'PUT', body: { product, comment, mtimeMs: mtime() } })

  const remove = (key: string) =>
    $fetch(`/api/registry/products/${encodeURIComponent(key)}`, { method: 'DELETE', query: { mtimeMs: mtime() } })

  const reorder = (keys: string[]) =>
    $fetch('/api/registry/products/order', { method: 'PUT', body: { keys, mtimeMs: mtime() } })

  const importProducts = (keys: string[]) =>
    $fetch<{ imported: string[] }>('/api/registry/products/import', { method: 'POST', body: { keys, mtimeMs: mtime() } })

  const validate = () =>
    $fetch<{ ok: boolean, degraded: boolean, path: string | null, problems: Problem[] }>('/api/registry/validate', { method: 'POST' })

  const byKey = (key: string) => registry.value?.products.find(p => p.key === key)

  return { registry, loading, error, load, create, update, remove, reorder, importProducts, validate, byKey }
}
