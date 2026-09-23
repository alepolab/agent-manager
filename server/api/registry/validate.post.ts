import { requireCapability } from '../../utils/session'
import { readStore } from '../../utils/productStore'
import { blocking, validateProducts } from '../../utils/registryValidate'

/**
 * Check the whole registry without saving anything.
 *
 * Returns 200 whether or not it passes, with `ok` saying which - the same
 * shape `channels/[name]/test.post.ts` uses, and for the same reason: the
 * caller renders the outcome either way, and a thrown error would make "this
 * registry has three warnings" indistinguishable from "the check itself
 * failed".
 */
export default defineEventHandler(async (event) => {
  // Reads the whole store to check it; the Check button is an operator tool.
  await requireCapability(event, 'configure')
  const store = await readStore()
  const problems = validateProducts(store.products)
  return {
    ok: blocking(problems).length === 0,
    degraded: store.degraded,
    path: store.path,
    problems,
  }
})
