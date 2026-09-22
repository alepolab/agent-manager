/**
 * Where a product's recipe is looked up.
 *
 * It used to be derived from the registry file's own path,
 * `<registry>/../../recipes`, which only worked while the registry could be
 * nothing but the plugin's copy or the shipped one. Once the registry can live
 * anywhere - a store under the Claude directory, a path named by
 * AGENT_REGISTRY_PATH - that derivation points at a directory holding nothing,
 * and every recipe silently stops being found. Nothing reports it: `recipe`
 * simply goes absent, and absent is a legitimate state for eighteen of the
 * twenty-four products, so the stack step improvises the bring-up instead.
 *
 *   node scripts/test-recipe-resolution.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'recipe-resolution-'))
process.env.CLAUDE_DIR = CLAUDE_DIR

const { recipePathFor } = await import('../server/utils/registry.ts')

// ══ 1. no plugin: the copy shipped in the product ══════════════════════════
{
  // `crm` is one of the six the repo ships a recipe for. This is the
  // container's normal case, where there is no plugin at all.
  assert.match(recipePathFor('crm') ?? '', /engineering[/\\]recipes[/\\]crm\.md$/,
    'with no plugin installed, the shipped recipe is the one found')
  assert.equal(recipePathFor('no-such-product'), undefined,
    'a product nothing ships a recipe for has none — never a path to a file that is not there')
}

// ══ 2. the Claude directory wins ═══════════════════════════════════════════
{
  mkdirSync(join(CLAUDE_DIR, 'recipes'), { recursive: true })
  writeFileSync(join(CLAUDE_DIR, 'recipes', 'crm.md'), '# a local crm recipe\n')
  assert.equal(recipePathFor('crm'), join(CLAUDE_DIR, 'recipes', 'crm.md'),
    'a recipe in the config directory is preferred, so recipes can become editable here without another migration')
  rmSync(join(CLAUDE_DIR, 'recipes'), { recursive: true, force: true })
}

// ══ 3. with a plugin installed, the plugin is the ONE other source ══════════
{
  const cache = join(CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '9.9.9')
  mkdirSync(join(cache, 'recipes'), { recursive: true })
  writeFileSync(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '9.9.9' }] },
  }))
  writeFileSync(join(cache, 'recipes', 'vms.md'), '# plugin vms recipe\n')

  assert.equal(recipePathFor('vms'), join(cache, 'recipes', 'vms.md'),
    'the installed plugin supplies the recipe')

  // The important one. `crm.md` exists in engineering/recipes/, but the plugin
  // is what supplied the registry entry, so the two must not be mixed.
  assert.equal(recipePathFor('crm'), undefined,
    'THE REQUIREMENT: no fall-through to the shipped copy while a plugin is installed — '
    + 'a stale plugin must not have its registry entry paired with the checkout\'s recipe for a product that has moved on')
}

// ══ 4. moving the registry does not move the recipes ═══════════════════════
{
  // The whole point of the change: the registry can be read from anywhere now,
  // and recipe resolution does not depend on where that was.
  process.env.AGENT_REGISTRY_PATH = join(CLAUDE_DIR, 'somewhere', 'else', 'products.yaml')
  const cache = join(CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '9.9.9')
  assert.equal(recipePathFor('vms'), join(cache, 'recipes', 'vms.md'),
    'a registry read from an unrelated path still finds its recipes')
  delete process.env.AGENT_REGISTRY_PATH
}

rmSync(CLAUDE_DIR, { recursive: true, force: true })
console.log('recipe resolution: all assertions passed')
