/**
 * Whether a product entry may be written to the store.
 *
 * Two halves. The schema walk answers "is this the right shape", against the
 * SHIPPED `products.schema.json` read at runtime, so the form's help text and
 * the rules that refuse a save can never describe different schemas. The
 * semantic rules come from `shared/registry/rules.ts`, which
 * `engineering/scripts/validate-registry.mjs` imports as well.
 *
 * Not a shell-out to that script, for a concrete reason rather than a
 * stylistic one: it parses YAML with its own restricted reader, so routing
 * every save through it would make each write depend on two YAML parsers
 * agreeing - precisely the drift this shares a rule set to avoid. It also
 * validates watches.yaml in the same pass, prints unstructured text, and lives
 * in a plugin that may not be installed.
 *
 * A validator that throws is a validator that refuses every save for a reason
 * nobody can read, so nothing here throws: an unreadable schema degrades to
 * "the semantic rules only", reported as a warning.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveClaudePath } from './claudeDir.ts'
import { productProblems, type Problem } from '../../shared/registry/rules.ts'

export type { Problem } from '../../shared/registry/rules.ts'

/** The same plugin-then-shipped order the registry itself resolves in. */
function schemaPath(): string | null {
  const installed = resolveClaudePath('plugins', 'installed_plugins.json')
  if (existsSync(installed)) {
    try {
      const data = JSON.parse(readFileSync(installed, 'utf-8'))
      const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
      const path = entry?.installPath && join(entry.installPath, 'registry', 'schemas', 'products.schema.json')
      if (path && existsSync(path)) return path
    } catch { /* fall through to the shipped copy */ }
  }
  const shipped = `${process.cwd().replace(/\\/g, '/')}/engineering/registry/schemas/products.schema.json`
  return existsSync(shipped) ? shipped : null
}

let cached: { path: string, schema: any } | null = null
export function loadProductSchema(): any | null {
  const path = schemaPath()
  if (!path) return null
  if (cached?.path === path) return cached.schema
  try {
    const schema = JSON.parse(readFileSync(path, 'utf-8'))
    cached = { path, schema }
    return schema
  } catch {
    return null
  }
}

/**
 * The subset of JSON Schema these files actually use. Ported from
 * validate-registry.mjs rather than pulled from a library on purpose: the
 * shipped validator recognises exactly this much, and a stricter one here
 * would refuse saves that CI accepts, which is the same drift from the other
 * direction.
 */
function walk(node: any, schema: any, path: string, defs: any, out: Problem[]): void {
  const D = defs ?? schema.$defs ?? {}
  const fail = (where: string, message: string) => out.push({ where, message, severity: 'error' })

  if (schema.$ref) {
    return walk(node, D[schema.$ref.replace('#/$defs/', '')] ?? {}, path, D, out)
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null
  if (types) {
    const actual = node === null ? 'null' : Array.isArray(node) ? 'array'
      : Number.isInteger(node) ? 'integer' : typeof node
    if (!types.some((t: string) => t === actual || (t === 'number' && actual === 'integer'))) {
      fail(path, `expected ${types.join(' or ')}, got ${actual}`)
      return
    }
  }

  if (schema.enum && !schema.enum.includes(node)) {
    fail(path, `"${node}" is not one of ${schema.enum.filter((e: unknown) => e !== null).join(', ')}`)
  }
  if (schema.pattern && typeof node === 'string' && !new RegExp(schema.pattern).test(node)) {
    fail(path, `"${node}" does not match ${schema.pattern}`)
  }
  if (schema.minLength !== undefined && typeof node === 'string' && node.length < schema.minLength) {
    fail(path, 'is empty')
  }
  if (schema.minimum !== undefined && typeof node === 'number' && node < schema.minimum) {
    fail(path, `${node} is below the minimum ${schema.minimum}`)
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      fail(path, `needs at least ${schema.minItems} item(s)`)
    }
    if (schema.uniqueItems && new Set(node.map(String)).size !== node.length) {
      fail(path, 'contains duplicates')
    }
    if (schema.items) node.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, D, out))
    return
  }

  if (node && typeof node === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in node)) fail(path, `missing required key "${req}"`)
    }
    if (schema.minProperties !== undefined && Object.keys(node).length < schema.minProperties) {
      fail(path, `needs at least ${schema.minProperties} entr(ies)`)
    }
    if (schema.propertyNames?.pattern) {
      for (const k of Object.keys(node)) {
        if (!new RegExp(schema.propertyNames.pattern).test(k)) {
          fail(`${path}.${k}`, `key does not match ${schema.propertyNames.pattern}`)
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      const sub = schema.properties?.[k]
      if (sub) { walk(v, sub, `${path}.${k}`, D, out); continue }
      if (schema.additionalProperties === false) {
        fail(`${path}.${k}`, 'is not a recognised key (typo, or the schema needs updating)')
      } else if (typeof schema.additionalProperties === 'object') {
        walk(v, schema.additionalProperties, `${path}.${k}`, D, out)
      }
    }
  }
}

/** The schema node one product entry is validated against. */
function productSchema(schema: any): any | null {
  return schema?.properties?.products?.additionalProperties
    ?? schema?.$defs?.product
    ?? null
}

/** Everything wrong with one product entry: shape first, then the shared rules. */
export function validateProduct(key: string, product: unknown): Problem[] {
  const out: Problem[] = []
  const schema = loadProductSchema()
  const node = schema ? productSchema(schema) : null
  if (!node) {
    out.push({
      where: `products.${key}`,
      message: 'the product schema could not be read on this instance, so only the semantic rules were applied',
      severity: 'warning',
    })
  } else {
    walk(product, node, `products.${key}`, schema.$defs ?? {}, out)
  }
  return [...out, ...productProblems(key, product)]
}

export function validateProducts(products: Record<string, unknown>): Problem[] {
  return Object.entries(products).flatMap(([key, p]) => validateProduct(key, p))
}

/** Whether a set of problems should refuse a write. */
export const blocking = (problems: Problem[]) => problems.filter(p => p.severity === 'error')
