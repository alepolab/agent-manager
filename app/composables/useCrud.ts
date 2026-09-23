interface CrudOptions {
  stateKey: string
  label?: string
}

export function useCrud<T extends { slug: string }, P = unknown>(basePath: string, opts: CrudOptions) {
  const items = useState<T[]>(opts.stateKey, () => [])
  const loading = useState(`${opts.stateKey}Loading`, () => false)
  const error = useState<string | null>(`${opts.stateKey}Error`, () => null)
  const { workingDir } = useWorkingDir()

  const label = opts.label || opts.stateKey

  /** `silent` is for background refreshes: no loading flag, and a failure keeps the last good list. */
  async function fetchAll(params: any = {}, { silent = false } = {}) {
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const next = await $fetch<T[]>(basePath, {
        query: { workingDir: workingDir.value, ...params }
      }) as T[]
      // An unchanged background refresh must not hand consumers new objects: /graph rebuilds its layout from them.
      if (silent && JSON.stringify(next) === JSON.stringify(items.value)) return
      items.value = next
    } catch (e: unknown) {
      if (silent) return
      const msg = e instanceof Error ? e.message : `Failed to load ${label}`
      error.value = msg
      console.error(`[useCrud:${label}] fetchAll:`, msg)
    } finally {
      if (!silent) loading.value = false
    }
  }

  async function fetchOne(slug: string, params: any = {}) {
    return await $fetch<T>(`${basePath}/${slug}`, {
      query: { workingDir: workingDir.value, ...params }
    }) as T
  }

  async function create(payload: P) {
    const item = await $fetch<T>(basePath, { 
      method: 'POST', 
      body: { ...payload as Record<string, unknown>, workingDir: workingDir.value } 
    }) as T
    items.value.push(item)
    return item
  }

  async function update(slug: string, payload: P) {
    const item = await $fetch<T>(`${basePath}/${slug}`, { 
      method: 'PUT', 
      body: { ...payload as Record<string, unknown>, workingDir: workingDir.value } 
    }) as T
    const idx = items.value.findIndex(i => i.slug === slug)
    if (idx >= 0) items.value[idx] = item
    else items.value.push(item)
    return item
  }

  async function remove(slug: string) {
    await $fetch(`${basePath}/${slug}`, { 
      method: 'DELETE' as const,
      query: { workingDir: workingDir.value }
    })
    items.value = items.value.filter(i => i.slug !== slug)
  }

  return { items, loading, error, fetchAll, fetchOne, create, update, remove }
}
