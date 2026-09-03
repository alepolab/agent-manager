#!/usr/bin/env node
/**
 * Evidence bundle validator.
 *
 * Enforces schemas/evidence-bundle.v0.1.schema.json against a bundle, then
 * layers semantic rules the schema's JSON-Schema subset cannot express:
 *
 *   - the pre-fix oracle must have FAILED (a PASS means nothing was reproduced)
 *   - the post-fix oracle must have PASSED (otherwise the fix is unproven)
 *   - a multi-repo fix must declare merge_order (the schema only documents
 *     this requirement in a property description, it does not encode it)
 *
 * A bundle that "passes" without these checks could be schema-valid while
 * proving nothing — a test that exists but never failed, a fix that was
 * never shown to work. Missing evidence fails the PR; this file is what
 * makes that true.
 *
 *   node scripts/validate-bundle.mjs <bundle.json>
 *
 * Exit 0 = the bundle is valid evidence. Exit 1 = printed reasons, one per line.
 *
 * No dependencies: same reasoning as validate-registry.mjs — this is the
 * trusted root of the pipeline.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(readFileSync(join(root, 'schemas/evidence-bundle.v0.1.schema.json'), 'utf8'))

// ── Minimal JSON-Schema subset ─────────────────────────────────────────────
// The same subset proven in validate-registry.mjs — required, types, enums,
// patterns, numeric bounds, array items, additionalProperties: false, $ref
// into $defs — extended with a URI format check and allOf/if/then, which the
// bundle schema uses for its two conditional requirements.
function validate(node, schema, path, defs, problems) {
  const D = defs ?? schema.$defs ?? {}
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '')
    return validate(node, D[name] ?? {}, path, D, problems)
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
  if (schema.format === 'uri' && typeof node === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(node)) {
    problems.push(`${path}: "${node}" is not a URI`)
  }
  if (schema.minLength !== undefined && typeof node === 'string' && node.length < schema.minLength) {
    problems.push(`${path}: is empty`)
  }
  if (schema.minimum !== undefined && typeof node === 'number' && node < schema.minimum) {
    problems.push(`${path}: ${node} is below the minimum ${schema.minimum}`)
  }
  if (schema.maximum !== undefined && typeof node === 'number' && node > schema.maximum) {
    problems.push(`${path}: ${node} is above the maximum ${schema.maximum}`)
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      problems.push(`${path}: needs at least ${schema.minItems} item(s)`)
    }
    if (schema.items) node.forEach((v, idx) => validate(v, schema.items, `${path}[${idx}]`, D, problems))
    return
  }

  if (node && typeof node === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in node)) problems.push(`${path}: missing required key "${req}"`)
    }
    for (const [k, v] of Object.entries(node)) {
      const sub = schema.properties?.[k]
      if (sub) { validate(v, sub, `${path}.${k}`, D, problems); continue }
      if (schema.additionalProperties === false) {
        problems.push(`${path}.${k}: is not a recognised key (typo, or the schema needs updating)`)
      } else if (typeof schema.additionalProperties === 'object') {
        validate(v, schema.additionalProperties, `${path}.${k}`, D, problems)
      }
    }
  }
}

// Does `node` satisfy an `if` clause? Only the subset the bundle schema
// actually uses: const equality and nested properties/required, each checked
// only where present — an `if` clause is a partial match, not a full schema.
function matchesIf(node, ifSchema) {
  if (!ifSchema) return true
  if (ifSchema.const !== undefined) return node === ifSchema.const
  if (ifSchema.enum && !ifSchema.enum.includes(node)) return false
  if (ifSchema.required) {
    for (const k of ifSchema.required) {
      if (node == null || typeof node !== 'object' || !(k in node)) return false
    }
  }
  if (ifSchema.properties) {
    for (const [k, sub] of Object.entries(ifSchema.properties)) {
      if (node && typeof node === 'object' && k in node) {
        if (!matchesIf(node[k], sub)) return false
      }
    }
  }
  return true
}

/**
 * Validate one evidence bundle. Returns an array of problem strings — an
 * empty array means the bundle is valid evidence. Never throws on a
 * malformed bundle; reporting exactly that is what this function is for.
 */
export function validateBundle(bundle) {
  const problems = []
  validate(bundle, schema, 'bundle', schema.$defs, problems)

  for (const clause of schema.allOf ?? []) {
    if (matchesIf(bundle, clause.if)) {
      validate(bundle, clause.then, 'bundle', schema.$defs, problems)
    }
  }

  // ── Semantic rules the schema's if/then subset cannot express ───────────

  // The oracle that ran BEFORE the fix must have failed. A PASS here means
  // the bug was never reproduced, so nothing downstream — the fix, the
  // regression run, the trace — proves anything about it.
  if (bundle?.oracle && typeof bundle.oracle === 'object' && bundle.oracle.verdict !== undefined
    && bundle.oracle.verdict !== 'FAIL') {
    problems.push(`bundle.oracle.verdict: pre-fix oracle must be FAIL (got "${bundle.oracle.verdict}") — a passing pre-fix oracle means nothing was reproduced`)
  }

  // The same oracle, run AFTER the fix, must have passed. FAIL or FLAKY here
  // means the fix is unproven, no matter what else the bundle carries.
  if (bundle?.oracle_after && typeof bundle.oracle_after === 'object' && bundle.oracle_after.verdict !== undefined
    && bundle.oracle_after.verdict !== 'PASS') {
    problems.push(`bundle.oracle_after.verdict: post-fix oracle must be PASS (got "${bundle.oracle_after.verdict}") — the fix is unproven otherwise`)
  }

  // A multi-repo fix with no declared merge order leaves the apply sequence
  // across repos undefined. The schema only documents this in the
  // merge_order property's description, it does not encode it as a
  // conditional requirement, so enforce it here.
  const repos = bundle?.fix?.repos
  if (Array.isArray(repos) && repos.length > 1
    && !(Array.isArray(bundle.fix.merge_order) && bundle.fix.merge_order.length > 0)) {
    problems.push('bundle.fix.merge_order: required when fix.repos has more than one entry — the apply order across repos is otherwise undefined')
  }

  return problems
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/validate-bundle.mjs <bundle.json>')
    process.exit(1)
  }
  let bundle
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`✗ could not read/parse ${file}: ${e.message}`)
    process.exit(1)
  }
  const problems = validateBundle(bundle)
  if (problems.length) {
    console.error(`\n✗ evidence bundle invalid — ${problems.length} problem(s):\n`)
    for (const p of problems) console.error(`  ✗ ${p}`)
    console.error('\nMissing evidence fails the PR. Fix the bundle, not the check.\n')
    process.exit(1)
  }
  console.log(`\n✓ evidence bundle valid — ${bundle.ticket ?? '(no ticket)'}\n`)
  process.exit(0)
}
