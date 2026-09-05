import { resolveProduct } from '../../utils/registry'

/** Which product a ticket key or text would route to, before a run is started. */
export default defineEventHandler(async (event) => {
  const q = getQuery(event).q
  const text = typeof q === 'string' ? q.trim() : ''
  if (!text) return { product: null }
  const p = await resolveProduct(text)
  return { product: p ? { name: p.name, suite: p.suite ?? null, repos: p.repos, recipe: !!p.recipe } : null }
})
