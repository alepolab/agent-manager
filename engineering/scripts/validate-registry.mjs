#!/usr/bin/env node
/**
 * Registry check.
 *
 * Validates watches.yaml and products.yaml against their schemas, then applies
 * the cross-file and semantic rules a JSON schema cannot express. A broken
 * entry must fail here — loudly, in CI — rather than silently mis-resolving a
 * real ticket later.
 *
 *   node scripts/validate-registry.mjs            # schema + semantic checks
 *   node scripts/validate-registry.mjs --repos    # also clone-check every repo
 *
 * Exit 0 = every entry is dispatchable. Exit 1 = at least one is not.
 *
 * No dependencies: the YAML subset used by the registry is parsed here rather
 * than pulling a package into a repo whose whole point is being the trusted
 * root of the pipeline.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
const notes = []
const fail = (where, msg) => problems.push(`${where}: ${msg}`)
const note = (where, msg) => notes.push(`${where}: ${msg}`)

// ── Minimal YAML reader ───────────────────────────────────────────────────
// Handles the subset the registry uses: nested maps, "- " sequences, inline
// [a, b] flow sequences, quoted scalars, > folded blocks and # comments.
// Anything outside that subset is a parse error, not a silent misread.
function parseYaml(text) {
  const lines = text.split('\n')
  const root = {}
  const stack = [{ indent: -1, node: root }]
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
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim()
      if (!inner) return []
      return inner.split(',').map(s => scalar(s))
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
        if (kv[2].trim() === '' || kv[2].trim() === '>-') {
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
    if (!kv) { fail('yaml', `line ${i + 1}: cannot parse "${body}"`); i++; continue }
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

  // Collapse the sequence marker into real arrays.
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
  return collapse(root)
}

// ── Schema validation ─────────────────────────────────────────────────────
// A focused subset of JSON Schema: enough to enforce our own schemas honestly,
// without pretending to be a general validator.
function validate(node, schema, path, defs) {
  const D = defs ?? schema.$defs ?? {}
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '')
    return validate(node, D[name] ?? {}, path, D)
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null
  if (types) {
    const actual = node === null ? 'null' : Array.isArray(node) ? 'array'
      : Number.isInteger(node) ? 'integer' : typeof node
    const ok = types.some(t => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) { fail(path, `expected ${types.join(' or ')}, got ${actual}`); return }
  }

  if (schema.enum && !schema.enum.includes(node)) {
    fail(path, `"${node}" is not one of ${schema.enum.filter(e => e !== null).join(', ')}`)
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
  if (schema.maximum !== undefined && typeof node === 'number' && node > schema.maximum) {
    fail(path, `${node} is above the maximum ${schema.maximum}`)
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      fail(path, `needs at least ${schema.minItems} item(s)`)
    }
    if (schema.uniqueItems && new Set(node.map(String)).size !== node.length) {
      fail(path, 'contains duplicates')
    }
    if (schema.items) node.forEach((v, idx) => validate(v, schema.items, `${path}[${idx}]`, D))
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
      if (sub) { validate(v, sub, `${path}.${k}`, D); continue }
      if (schema.additionalProperties === false) {
        fail(`${path}.${k}`, 'is not a recognised key (typo, or the schema needs updating)')
      } else if (typeof schema.additionalProperties === 'object') {
        validate(v, schema.additionalProperties, `${path}.${k}`, D)
      }
    }
  }
}

// ── Load ──────────────────────────────────────────────────────────────────
const read = (p) => readFileSync(join(root, p), 'utf8')
const watchesDoc = parseYaml(read('registry/watches.yaml'))
const productsDoc = parseYaml(read('registry/products.yaml'))
const watchesSchema = JSON.parse(read('registry/schemas/watches.schema.json'))
const productsSchema = JSON.parse(read('registry/schemas/products.schema.json'))

validate(watchesDoc, watchesSchema, 'watches.yaml')
validate(productsDoc, productsSchema, 'products.yaml')

const watches = watchesDoc.watches ?? []
const products = productsDoc.products ?? {}

// ── Semantic rules a schema cannot express ────────────────────────────────

// Watch ids appear in every bundle and metrics record; a collision corrupts history.
const seen = new Set()
for (const w of watches) {
  if (seen.has(w.id)) fail(`watches.${w.id}`, 'duplicate watch id')
  seen.add(w.id)
}

for (const w of watches) {
  // A watch that dispatches must say into which state, or the transition that
  // fires the build loop is undefined.
  if (w.mode === 'live' && w.daily_dispatch_cap !== 0 && !w.dispatch_state) {
    fail(`watches.${w.id}`, 'is live and can dispatch but names no dispatch_state')
  }
  // requires: [spec] only means something for work types that carry a spec.
  if (w.requires?.includes('spec')) {
    const specable = ['feature', 'change_request']
    if (!w.work_types.some(t => specable.includes(t))) {
      fail(`watches.${w.id}`, 'requires a spec but handles no work type that produces one')
    }
  }
  // A watch above its own dispatch ceiling would dispatch nothing; likely a typo.
  if (w.max_blast_radius === 'docs' && w.work_types.some(t => t !== 'docs')) {
    note(`watches.${w.id}`, 'max_blast_radius is docs, so only docs-labelled changes can ever dispatch')
  }
}

const ORDER = ['docs', 'ui_parsing', 'schema', 'protocol', 'money']
for (const [name, p] of Object.entries(products)) {
  const where = `products.${name}`

  // A bug branch template referencing {version} needs somewhere to get it.
  if (typeof p.branches?.bug === 'string' && p.branches.bug.includes('{version}') && !p.version_source) {
    fail(where, 'branches.bug uses {version} but the product declares no version_source')
  }
  // Forward-porting only means something when bugs land on a release branch.
  if (p.forward_port && !String(p.branches?.bug ?? '').includes('{version}')) {
    note(where, 'declares forward_port but its bug branch is not a release branch — the port would be a no-op')
  }
  // multi_repo is a claim the repo list has to support.
  if (p.multi_repo === true && (p.repos?.length ?? 0) < 2) {
    fail(where, 'is marked multi_repo but lists fewer than two repos')
  }
  if (p.multi_repo !== true && (p.repos?.length ?? 0) > 1) {
    fail(where, 'lists several repos but is not marked multi_repo, so no merge order would be produced')
  }
  // Rollback between attempts is what makes three attempts safe.
  if (p.stack?.liquibase !== true) {
    note(where, 'has no Liquibase tag, so a retry cannot roll the database back between attempts')
  }
  // An ATDD suite that does not emit xunit cannot be read as a verdict.
  if (p.tests?.atdd && !/--xunit|xunit/.test(p.tests.atdd)) {
    fail(where, 'declares an atdd command that does not emit xunit; the loop would have to grep logs')
  }
  if (!p.tests?.atdd && !p.tests?.compose_test) {
    note(where, 'has no atdd or compose_test suite, so only unit tests can serve as its oracle')
  }
  // Money and protocol are never auto-merged, so they must name a human group.
  for (const label of ['money', 'protocol']) {
    if (p.owners?.[label] && !String(p.owners[label]).trim()) {
      fail(where, `owners.${label} is empty; a ${label} change would have no named approver`)
    }
  }
  // Placeholder repo names would clone-fail at the worst possible moment.
  for (const r of p.repos ?? []) {
    if (/[<>]/.test(r)) fail(where, `repo "${r}" is still a placeholder`)
  }
}

// Every watch must be able to reach at least one product, or it triages into a void.
const allComponents = new Set()
const allProjects = new Set()
for (const p of Object.values(products)) {
  for (const c of p.match?.components ?? []) allComponents.add(String(c).toLowerCase())
  for (const pr of p.match?.projects ?? []) allProjects.add(String(pr).toUpperCase())
}
for (const w of watches) {
  const proj = (w.jql.match(/project\s*=\s*"?([A-Z][A-Z0-9]+)"?/i) ?? [])[1]
  if (!proj) { note(`watches.${w.id}`, 'jql names no single project; component matching is the only resolution path'); continue }
  const reachable = allProjects.has(proj.toUpperCase()) || allComponents.size > 0
  if (!reachable) fail(`watches.${w.id}`, `no product in the registry can match project ${proj}`)
}

// Blast-radius ceiling must be a label some product actually owns.
for (const w of watches) {
  if (!w.max_blast_radius) continue
  const idx = ORDER.indexOf(w.max_blast_radius)
  const ownedSomewhere = Object.values(products).some(p =>
    Object.keys(p.owners ?? {}).some(l => ORDER.indexOf(l) <= idx))
  if (!ownedSomewhere) {
    fail(`watches.${w.id}`, `max_blast_radius ${w.max_blast_radius} but no product owns a label at or below it`)
  }
}

// ── Optional: the repo half of the registry check ─────────────────────────
if (process.argv.includes('--repos')) {
  for (const [name, p] of Object.entries(products)) {
    for (const repo of p.repos ?? []) {
      const local = join('/home/alepo', repo.split('/')[1])
      if (!existsSync(local)) { note(`products.${name}`, `${repo} not checked out at ${local}; skipped`); continue }
      for (const required of ['AGENTS.md', 'REVIEW.md']) {
        if (!existsSync(join(local, required))) {
          fail(`products.${name}`, `${repo} is missing ${required} — it is not on the paved road`)
        }
      }
      try {
        const branch = execFileSync('git', ['-C', local, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        note(`products.${name}`, `${repo} checked out on ${branch}`)
      } catch {
        fail(`products.${name}`, `${repo} at ${local} is not a git repository`)
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  note  ${n}`)
if (problems.length) {
  console.error(`\n✗ registry check failed — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\nA product with a failing entry is not dispatchable. Fix the entry, not the pipeline.\n')
  process.exit(1)
}
console.log(`\n✓ registry check passed — ${watches.length} watch(es), ${Object.keys(products).length} product(s)\n`)
