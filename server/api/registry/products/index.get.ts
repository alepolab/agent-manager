import { productComments, readStore } from '../../../utils/productStore'
import { validateProduct } from '../../../utils/registryValidate'
import { resolveRecipe } from '../../../utils/registry'

/**
 * The registry as the Products page shows it: products IN FILE ORDER, because
 * that order is the final tie-break in `resolveProduct` and a page that listed
 * them alphabetically would hide the rule that decides ambiguous tickets.
 *
 * `mtimeMs` is what a later write sends back for the optimistic-concurrency
 * check; without it two tabs, or two instances sharing a config directory,
 * overwrite each other with no sign that they did.
 */
export default defineEventHandler(async () => {
  const [store, comments] = await Promise.all([readStore(), productComments()])
  return {
    ok: store.ok,
    degraded: store.degraded,
    path: store.path,
    source: store.source,
    seed: store.seed,
    mtimeMs: store.mtimeMs,
    products: Object.entries(store.products).map(([key, product], position) => {
      const recipe = resolveRecipe(key)
      return {
        key,
        position,
        product,
        // The rationale block above the entry. Sent so the form can show it: it
        // is not a value, so `toJS()` never carries it, and a form that showed an
        // empty box above an entry whose comment records a real decision invites
        // somebody to write over that decision.
        comment: comments[key] ?? '',
        recipe: !!recipe,
        // Which copy, not just whether. A local recipe hides the plugin's on
        // this machine only, and a badge that said "recipe" for both would make
        // the one state worth noticing look exactly like the ordinary one.
        recipeSource: recipe?.source ?? null,
        problems: validateProduct(key, product),
      }
    }),
  }
})
