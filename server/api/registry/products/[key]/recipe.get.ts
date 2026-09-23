import { readRecipe } from '../../../../utils/recipeStore'

/**
 * One product's recipe, with the content and not just the fact that there is
 * one. The list endpoint deliberately keeps sending a boolean: a recipe is a
 * few kilobytes of prose and twenty-four of them in the page's first payload
 * would be paid for on every load by everybody who never opens one.
 */
export default defineEventHandler(async (event) => {
  const key = getRouterParam(event, 'key')!
  try {
    return await readRecipe(key)
  } catch (err) {
    throw createError({ statusCode: 400, message: err instanceof Error ? err.message : String(err) })
  }
})
