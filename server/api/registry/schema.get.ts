import { loadProductSchema } from '../../utils/registryValidate'

/**
 * The product schema, so every field's help text on the Products page is the
 * schema's own `description`. Two descriptions of one field - one in the form,
 * one in the schema - drift, and the form's copy is the one nobody validates.
 */
export default defineEventHandler(() => {
  const schema = loadProductSchema()
  if (!schema) throw createError({ statusCode: 404, message: 'No product schema is available on this instance' })
  return schema
})
