/**
 * Minimal, dependency-free YAML reader and a focused JSON-Schema subset
 * validator, shared by the registry validators under engineering/scripts/.
 *
 * Deliberately NOT the general-purpose validate-registry.mjs's own copy of
 * this logic — that script is the existing, extensively-tested control for
 * products.yaml/watches.yaml, and this task's instructions were to add a
 * SIBLING validator for the new environments registry rather than risk a
 * regression by refactoring the working one. The two implementations are
 * intentionally independent; this file only exists so the two NEW scripts
 * introduced here (validate-environments.mjs, resolve-environment.mjs) do not
 * duplicate a second, third copy of the same parser between themselves.
 *
 * Handles the subset environments.yaml uses: nested maps, "- " sequences,
 * inline scalars, quoted scalars, booleans/numbers, and # comments. Anything
 * outside that subset is a parse error, not a silent misread — the same
 * failure posture as validate-registry.mjs's parser.
 */

export function parseYaml(text) {
  const lines = text.split('\n')
  const root = {}
  const stack = [{ indent: -1, node: root }]
  const problems = []
  let i = 0

  const scalar = (raw) => {
    const v = raw.trim()
    if (v === '') return ''
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null' || v === '~') return null
    if (/^-?\d+$/.test(v)) return Number(v)
    if (/^-?\d*\.\d+$/.test(v)) return Number(v)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1)
    }
    return v
  }

  const parentFor = (indent) => {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    return stack[stack.length - 1].node
  }

  while (i < lines.length) {
    const line = lines[i]
    const stripped = line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '')
    if (!stripped.trim()) { i++; continue }

    const indent = stripped.match(/^\s*/)[0].length
    const body = stripped.trim()

    // Folded block scalar:  key: >-
    const folded = body.match(/^([\w.-]+):\s*>-?\s*$/)
    if (folded) {
      const parent = parentFor(indent)
      const parts = []
      i++
      while (i < lines.length) {
        const nxt = lines[i]
        if (!nxt.trim()) { i++; continue }
        const nIndent = nxt.match(/^\s*/)[0].length
        if (nIndent <= indent) break
        parts.push(nxt.trim())
        i++
      }
      parent[folded[1]] = parts.join(' ')
      continue
    }

    if (body.startsWith('- ')) {
      const parent = parentFor(indent)
      if (!Array.isArray(parent.__seq)) parent.__seq = []
      const rest = body.slice(2)
      const kv = rest.match(/^([\w.-]+):\s*(.*)$/)
      if (kv) {
        const item = {}
        parent.__seq.push(item)
        stack.push({ indent, node: item })
        if (kv[2].trim() === '') {
          const child = {}
          item[kv[1]] = child
          stack.push({ indent: indent + 2, node: child })
        } else {
          item[kv[1]] = scalar(kv[2])
        }
      } else {
        parent.__seq.push(scalar(rest))
      }
      i++
      continue
    }

    const kv = body.match(/^([\w.-]+):\s*(.*)$/)
    if (!kv) { problems.push(`line ${i + 1}: cannot parse "${body}"`); i++; continue }
    const [, key, rawValue] = kv
    const parent = parentFor(indent)
    if (rawValue.trim() === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, node: child })
    } else {
      parent[key] = scalar(rawValue)
    }
    i++
  }

  const collapse = (node) => {
    if (Array.isArray(node)) return node.map(collapse)
    if (node && typeof node === 'object') {
      if (Array.isArray(node.__seq)) return node.__seq.map(collapse)
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = collapse(v)
      return out
    }
    return node
  }

  if (problems.length) {
    const err = new Error(`YAML parse error:\n${problems.join('\n')}`)
    err.problems = problems
    throw err
  }
  return collapse(root)
}

/**
 * A focused subset of JSON Schema, sufficient to validate our own
 * hand-written schemas honestly. Pushes problems onto `problems` (an array
 * of "path: message" strings) rather than throwing, so a caller can collect
 * every violation in one pass instead of stopping at the first.
 */
export function validateSchema(node, schema, path, problems, defs) {
  const D = defs ?? schema.$defs ?? {}
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '')
    return validateSchema(node, D[name] ?? {}, path, problems, D)
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null
  if (types) {
    const actual = node === null ? 'null' : Array.isArray(node) ? 'array'
      : Number.isInteger(node) ? 'integer' : typeof node
    const ok = types.some(t => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) { problems.push(`${path}: expected ${types.join(' or ')}, got ${actual}`); return }
  }

  if (schema.enum && !schema.enum.includes(node)) {
    problems.push(`${path}: "${node}" is not one of ${schema.enum.filter(e => e !== null).join(', ')}`)
  }
  if (schema.pattern && typeof node === 'string' && !new RegExp(schema.pattern).test(node)) {
    problems.push(`${path}: "${node}" does not match ${schema.pattern}`)
  }
  if (schema.minLength !== undefined && typeof node === 'string' && node.length < schema.minLength) {
    problems.push(`${path}: is empty`)
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      problems.push(`${path}: needs at least ${schema.minItems} item(s)`)
    }
    if (schema.items) node.forEach((v, idx) => validateSchema(v, schema.items, `${path}[${idx}]`, problems, D))
    return
  }

  if (node && typeof node === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in node)) problems.push(`${path}: missing required key "${req}"`)
    }
    if (schema.minProperties !== undefined && Object.keys(node).length < schema.minProperties) {
      problems.push(`${path}: needs at least ${schema.minProperties} entr(ies)`)
    }
    if (schema.propertyNames?.pattern) {
      for (const k of Object.keys(node)) {
        if (!new RegExp(schema.propertyNames.pattern).test(k)) {
          problems.push(`${path}.${k}: key does not match ${schema.propertyNames.pattern}`)
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      const sub = schema.properties?.[k]
      if (sub) { validateSchema(v, sub, `${path}.${k}`, problems, D); continue }
      if (schema.additionalProperties === false) {
        problems.push(`${path}.${k}: is not a recognised key (typo, or the schema needs updating)`)
      } else if (typeof schema.additionalProperties === 'object') {
        validateSchema(v, schema.additionalProperties, `${path}.${k}`, problems, D)
      }
    }
  }
}
