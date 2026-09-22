/**
 * Reading and writing a product's recipe.
 *
 * Four properties, and three of them are silent when broken:
 *
 * 1. A WRITE ONLY EVER LANDS LOCALLY. The plugin's copy and the checkout's are
 *    not this app's files. A write that reached either would edit a directory a
 *    plugin update replaces wholesale, so the edit disappears at the next
 *    install with nothing anywhere recording that it was made.
 * 2. THE LOCAL COPY ANNOUNCES WHAT IT HIDES. Copy-on-write means a local
 *    `crm.md` shadows the plugin's permanently, on one machine. Nothing merges
 *    them and nothing warns at read time except `shadows`, so a page that had
 *    no way to say it would leave a developer running bring-up instructions
 *    three plugin releases stale and looking at a green badge.
 * 3. A CONCURRENT WRITE IS REFUSED. Two tabs on the same recipe, and the one
 *    that saves second would otherwise silently discard the first.
 * 4. A KEY THAT IS NOT A PRODUCT KEY IS REFUSED. The key arrives as a router
 *    param and names a file; `../../settings` must not be a path.
 *
 *   node scripts/test-recipe-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'recipe-store-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
delete process.env.AGENT_REGISTRY_PATH

const store = await import('../server/utils/recipeStore.ts')
const LOCAL = join(CLAUDE_DIR, 'recipes', 'crm.md')

// ══ 1. reads the shipped copy, and says it is the shipped copy ═════════════
{
  const r = await store.readRecipe('crm')
  assert.equal(r.source, 'shipped', 'with no plugin and no local copy, the recipe shipped in the repo is the one in force')
  assert.match(r.path ?? '', /engineering[/\\]recipes[/\\]crm\.md$/)
  assert.ok(r.content.includes('## Compose'), 'and its content comes back, not just the fact that it exists')
  assert.equal(r.shadows, null, 'nothing is being hidden yet')

  const none = await store.readRecipe('no-such-product')
  assert.equal(none.source, 'none')
  assert.equal(none.content, '', 'a product with no recipe reads as empty, never as a path to a file that is not there')
  assert.equal(none.mtimeMs, null)
}

// ══ 2. a write lands locally and says what it now hides ════════════════════
{
  const before = await store.readRecipe('crm')
  const { path } = await store.writeRecipe('crm', '# crm\n\nlocally edited', { expectedMtimeMs: before.mtimeMs })
  assert.equal(path, LOCAL, 'THE REQUIREMENT: the write goes to the config directory, never to the shipped copy')
  assert.ok(readFileSync(before.path, 'utf-8').includes('## Compose'), 'and the shipped copy is untouched')

  const after = await store.readRecipe('crm')
  assert.equal(after.source, 'local')
  assert.equal(after.content, '# crm\n\nlocally edited\n', 'a trailing newline is added; the content is otherwise byte-for-byte')
  assert.equal(after.shadows, before.path,
    'THE REQUIREMENT: the local copy names the copy it is hiding — nothing else ever reports this fork')
}

// ══ 3. a stale write is refused ════════════════════════════════════════════
{
  const r = await store.readRecipe('crm')
  await assert.rejects(
    () => store.writeRecipe('crm', 'second tab', { expectedMtimeMs: r.mtimeMs - 60_000 }),
    (e) => e instanceof store.StaleRecipeError && typeof e.mtimeMs === 'number',
    'a save carrying an mtime that has moved is refused rather than silently discarding the other edit',
  )
  assert.equal((await store.readRecipe('crm')).content, '# crm\n\nlocally edited\n', 'and nothing was written')

  // null means "I was shown no recipe at all", which a local file contradicts.
  await assert.rejects(() => store.writeRecipe('crm', 'x', { expectedMtimeMs: null }), store.StaleRecipeError)
  // Absent means "do not check" - writing the first recipe a product ever had.
  await store.writeRecipe('ffm', '# ffm\n\nfirst')
  assert.equal((await store.readRecipe('ffm')).source, 'local')
}

// ══ 4. empty is refused; a bad key is refused ══════════════════════════════
{
  await assert.rejects(() => store.writeRecipe('crm', '   \n'), /worse than none/,
    'the stack step reads a missing recipe as "improvise" and an empty one as instructions')

  for (const bad of ['../../settings', 'a/b', 'Crm', '.hidden', '']) {
    await assert.rejects(() => store.writeRecipe(bad, 'x'), /is not a product key/, `"${bad}" is refused`)
    await assert.rejects(() => store.readRecipe(bad), /is not a product key/, `"${bad}" is refused on read too`)
  }
  assert.equal(existsSync(join(CLAUDE_DIR, 'settings.md')), false, 'and nothing escaped the recipes directory')
}

// ══ 5. delete removes only the local copy ══════════════════════════════════
{
  const { fellBackTo } = await store.deleteRecipe('crm')
  assert.match(fellBackTo ?? '', /engineering[/\\]recipes[/\\]crm\.md$/, 'the shipped copy is live again')
  assert.equal(existsSync(LOCAL), false, 'the local copy is gone')
  assert.equal((await store.readRecipe('crm')).source, 'shipped')
  assert.ok(existsSync(fellBackTo), 'THE REQUIREMENT: the shipped copy still exists — a delete here is never a delete there')

  await assert.rejects(() => store.deleteRecipe('crm'), /no local recipe/,
    'a second delete does not fall through to removing the shipped one')
}

// ══ 6. with a plugin installed, local shadows the PLUGIN and not the repo ══
{
  const cache = join(CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '9.9.9')
  mkdirSync(join(cache, 'recipes'), { recursive: true })
  writeFileSync(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '9.9.9' }] },
  }))
  writeFileSync(join(cache, 'recipes', 'vms.md'), '# plugin vms recipe\n')

  assert.equal((await store.readRecipe('vms')).source, 'plugin')
  await store.writeRecipe('vms', '# local vms', { expectedMtimeMs: (await store.readRecipe('vms')).mtimeMs })
  const r = await store.readRecipe('vms')
  assert.equal(r.source, 'local')
  assert.equal(r.shadows, join(cache, 'recipes', 'vms.md'), 'the plugin copy is what is hidden')

  // The non-fall-through rule holds: crm.md exists in engineering/recipes/, but
  // a plugin is installed, so the shipped copy is not a source at all.
  assert.equal((await store.readRecipe('crm')).source, 'none',
    'a stale plugin must not have its registry entry paired with the checkout\'s recipe')
}

rmSync(CLAUDE_DIR, { recursive: true, force: true })
console.log('recipe store: all assertions passed')
