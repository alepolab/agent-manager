/**
 * A container repo's modules reach the agent, and an absence has to be measured.
 *
 *   node scripts/test-module-repos.mjs
 *
 * Both halves come from one run (CRM-76) that halted on a sentence that was
 * false. The provisioner cloned `alepolab/ase_lbss`, found modules/ nearly
 * empty — the parent repo tracks one path under it and git-ignores 49 sibling
 * repos — and reported the ticket's target file "not present in any checked-out
 * repo" while that file sat in its own workspace. Every step after it was
 * skipped on the strength of that claim.
 *
 * So: the registry now carries the directory -> repo map, it has to survive the
 * trip to the agent's input, and no step may assert an absence without running
 * the command that found nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = f => readFileSync(join(root, f), 'utf-8')

// ── The registry carries the map, and it is not derivable ────────────────────
{
  const schema = JSON.parse(read('engineering/registry/schemas/products.schema.json'))
  const modules = schema.$defs.product.properties.modules
  assert.ok(modules, 'the product schema knows `modules`')
  assert.equal(modules.additionalProperties.pattern, '^[^/]+/[^/]+$', 'values are owner/name')

  const yaml = read('engineering/registry/products.yaml')
  const block = yaml.slice(yaml.indexOf('\n  crm:'), yaml.indexOf('\n  billing:'))
  assert.ok(block.includes('modules:'), 'crm declares its module repos')

  const pairs = [...block.matchAll(/^ {6}([A-Za-z0-9._-]+): (alepolab\/[A-Za-z0-9._-]+)$/gm)]
  assert.ok(pairs.length >= 40, `the map is populated, found ${pairs.length}`)

  // The reason this is a map and not a rule. `database` is `crm-database_lbss`
  // and four modules carry no suffix at all, so `${dir}_lbss` would resolve to
  // repositories that do not exist - silently, as a clone failure an agent then
  // has to interpret.
  const derived = pairs.filter(([, dir, repo]) => repo === `alepolab/${dir}_lbss`)
  assert.ok(derived.length < pairs.length,
    'at least one module name is not derivable from its directory, which is why the map exists')
}

// ── It survives the trip to the agent ────────────────────────────────────────
{
  const types = read('shared/types/run.ts')
  assert.match(types, /modules\?: Record<string, string>/, 'ProductMatch carries modules')

  const registry = read('server/utils/registry.ts')
  assert.match(registry, /p\.modules/, 'resolveProduct reads modules off the registry entry')

  const artifacts = read('server/utils/runArtifacts.ts')
  assert.match(artifacts, /product\.modules/, "the agent's product block renders modules")
  assert.match(artifacts, /Modules: this product's parent repo is a container/,
    'and says why cloning the parent alone is not enough')
}

// ── An absence is a measurement ──────────────────────────────────────────────
{
  const artifacts = read('server/utils/runArtifacts.ts')
  assert.match(artifacts, /Before reporting that a file, module, table or endpoint does not exist/,
    'every step is told to prove an absence before reporting one')
  assert.match(artifacts, /paste the empty result/, 'and to show the empty result, not describe it')

  // Unconditional on purpose: the run that got this wrong resolved a product
  // fine, and the next one might resolve none at all. Guarding this behind the
  // product block is how the workspace instruction was lost before (see the
  // comment above `Work in:`), and the same mistake would cost the same way.
  const rule = artifacts.indexOf('Before reporting that a file, module, table or endpoint')
  const productBlock = artifacts.indexOf('## Product (from the registry)')
  assert.ok(rule > 0 && productBlock > 0)
  assert.ok(rule < productBlock,
    'the absence rule sits in the unconditional preamble, ahead of the product block: '
    + 'a run that resolves no product still gets it')
}

console.log('module repos: map is declared, reaches the agent, and absences must be measured')
