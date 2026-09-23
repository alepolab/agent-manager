/**
 * The registry store: seeded once, edited in place, never re-serialised.
 *
 * Three properties, and each one is a failure that would be silent:
 *
 * 1. SEEDED ONCE. A local edit must survive a restart. teamSync rewrites its
 *    seeded items at every boot by design - that is what TeamStatus.reverted
 *    warns about - and a registry that behaved the same way would hand a
 *    developer's routing change back to the plugin's version overnight, with
 *    nothing on the filesystem afterwards showing the edit was ever made.
 * 2. COMMENTS AND ORDER SURVIVE A SAVE. Forty per cent of the registry's lines
 *    are the reasoning behind its entries, and file order is the final
 *    tie-break in resolveProduct. A save that re-serialised the document would
 *    delete the first and reroute live tickets with the second, and neither
 *    would look like a routing change in the diff.
 * 3. A BROKEN STORE DOES NOT STOP ROUTING. A registry that fails to parse used
 *    to make every ticket resolve to no product, silently; the agents then
 *    improvised repos and checkout directories. The store falls back to the
 *    seed and says so.
 *
 *   node scripts/test-product-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'product-store-'))
process.env.CLAUDE_DIR = CLAUDE_DIR
delete process.env.AGENT_REGISTRY_PATH

const store = await import('../server/utils/productStore.ts')
const STORE = join(CLAUDE_DIR, 'products.yaml')
const read = () => readFileSync(STORE, 'utf-8')

// ══ 1. seeds from the shipped copy on first read ═══════════════════════════
{
  assert.equal(existsSync(STORE), false, 'nothing is written until something reads')
  const s = await store.readStore()
  assert.equal(s.ok, true, 'the registry reads')
  assert.equal(s.source, 'store', 'and it is now this app\'s store')
  assert.ok(Object.keys(s.products).length >= 20, 'carrying every shipped product')
  assert.ok(existsSync(STORE), 'the store file exists')

  const info = store.seedInfo()
  assert.ok(info?.seededFrom.includes('engineering'), 'the sidecar records where it came from')
  assert.equal(info.seededKind, 'shipped', 'and that it was the copy shipped in the product')
  assert.match(info.seedSha256, /^[0-9a-f]{64}$/, 'and the hash of what was copied')

  const shipped = readFileSync(join(process.cwd(), 'engineering', 'registry', 'products.yaml'), 'utf-8')
  assert.equal(read(), shipped, 'copied byte for byte — every comment and blank line is content here')
}

// ══ 2. THE "ONCE" GUARANTEE ════════════════════════════════════════════════
{
  const before = await store.readStore()
  await store.writeProduct('crm', { ...before.products.crm, suite: 'edited-by-a-person' })

  await store.ensureSeeded()
  await store.readStore()
  await store.ensureSeeded()

  const after = await store.readStore()
  assert.equal(after.products.crm.suite, 'edited-by-a-person',
    'THE REQUIREMENT: once the store exists, nothing copies the seed over it — a local edit survives every restart')
}

// ══ 3. COMMENTS AND ORDER SURVIVE A SAVE ═══════════════════════════════════
{
  // Compared against the PRISTINE seed, never against an already-saved copy.
  // Measuring the second save against the first hides a whole-file reflow in
  // the first one, which is exactly the bug this section missed once: the
  // registry came back with every flow list re-spaced and the longest one
  // broken over thirteen lines, so a one-field edit arrived for review as a
  // hundred-line diff.
  const pristine = read()
  const orderBefore = Object.keys((await store.readStore()).products)
  const commentLines = t => t.split('\n').filter(l => l.trim().startsWith('#')).length
  const confirms = t => (t.match(/CONFIRM/g) ?? []).length
  const changedAgainstPristine = (t) => {
    const a = pristine.split('\n'); const b = t.split('\n')
    return b.filter((l, i) => l !== a[i]).length
  }

  const products = (await store.readStore()).products
  await store.writeProduct('vms', { ...products['vms'], suite: 'changed-by-a-person' })
  const after = read()

  assert.equal(after.split('\n').length, pristine.split('\n').length,
    'THE REQUIREMENT: a save does not add or remove lines — a reflowed list is a diff nobody can review')
  assert.equal(commentLines(after), commentLines(pristine),
    'THE REQUIREMENT: no comment is lost by saving — the reasoning above an entry is the only place it exists')
  assert.equal(confirms(after), confirms(pristine),
    'every CONFIRM placeholder is still greppable, so a drafted field still reads as drafted')
  assert.deepEqual(Object.keys((await store.readStore()).products), orderBefore,
    'THE REQUIREMENT: key order is unchanged — it is the final tie-break in resolveProduct, so re-sorting reroutes tickets')

  // The one accepted normalisation. `yaml` does not record the whitespace
  // BEFORE an end-of-line comment, so column-aligned `# CONFIRM` markers
  // collapse to a single space the first time the file is written. Asserted
  // rather than ignored, so that if it ever grows into something larger — a
  // reflowed list, a requoted scalar — this fails instead of being explained
  // away afterwards.
  const touched = changedAgainstPristine(after)
  const realignedOnly = after.split('\n').filter((l, i) => {
    const was = pristine.split('\n')[i]
    return l !== was && l.replace(/\s+#/, ' #') === was?.replace(/\s+#/, ' #')
  }).length
  assert.equal(touched - realignedOnly, 1,
    `exactly one line differs for reasons other than comment realignment, got ${touched - realignedOnly}`)

  // A second save from the same content is then a no-op.
  const stable = (await store.readStore()).products
  await store.writeProduct('vms', stable['vms'])
  assert.equal(read(), after, 'saving unchanged content again changes nothing at all')
}

// ══ 4. a new product appends; it never re-sorts ════════════════════════════
{
  const orderBefore = Object.keys((await store.readStore()).products)
  await store.writeProduct('aaa-new-product', {
    suite: 'bss',
    match: { projects: ['NEW'] },
    repos: ['alepolab/new'],
    branches: { bug: 'develop', feature: 'develop' },
    stack: { compose: 'infra/new', topology_default: '1node' },
    tests: { unit: 'make test' },
    owners: { protocol: 'someone' },
  }, { comment: 'Added from the Products page.\nThe reason lives here, where the next reader will find it.' })

  const after = Object.keys((await store.readStore()).products)
  assert.deepEqual(after, [...orderBefore, 'aaa-new-product'],
    'a new product appends — alphabetical would put this one first and change which product wins a tie')
  assert.match(read(), /# Added from the Products page\./, 'and its rationale is written above it as a comment')
}

// ══ 5. reorder is explicit, and refuses a partial list ═════════════════════
{
  const keys = Object.keys((await store.readStore()).products)
  const moved = [keys[1], keys[0], ...keys.slice(2)]
  await store.reorder(moved)
  assert.deepEqual(Object.keys((await store.readStore()).products), moved, 'an explicit reorder is applied')

  await assert.rejects(() => store.reorder(keys.slice(0, 3)), /every product exactly once/,
    'THE REQUIREMENT: a partial order is refused — it would silently drop the products it left out')
  await store.reorder(keys)
}

// ══ 6. delete, backup, atomicity ═══════════════════════════════════════════
{
  const mtime = await store.deleteProduct('aaa-new-product')
  assert.ok(mtime, 'deleting an existing product reports the new mtime')
  assert.equal((await store.readStore()).products['aaa-new-product'], undefined, 'and it is gone')
  assert.equal(await store.deleteProduct('never-existed'), null, 'deleting an absent one is not an error')

  assert.ok(existsSync(`${STORE}.bak`), 'the previous version is kept as .bak for an operator who made it worse')
  assert.equal(existsSync(`${STORE}.tmp`), false, 'and no temp file is left behind')
}

// ══ 7. a stale write is refused ════════════════════════════════════════════
{
  const s = await store.readStore()
  await store.writeProduct('crm', { ...s.products.crm, suite: 'someone-else' })
  await assert.rejects(
    () => store.writeProduct('crm', { ...s.products.crm, suite: 'me' }, { expectedMtimeMs: s.mtimeMs - 5000 }),
    /changed since you loaded it/,
    'THE REQUIREMENT: two tabs, or two instances sharing a config directory, do not clobber each other silently',
  )
}

// ══ 8. A BROKEN STORE FALLS BACK, LOUDLY ═══════════════════════════════════
{
  writeFileSync(STORE, 'products:\n  broken: [this is not\n', 'utf-8')
  const s = await store.readStore()
  assert.equal(s.degraded, true, 'THE REQUIREMENT: a store that does not parse is reported, never silent')
  assert.equal(s.ok, true, 'and routing keeps working')
  assert.ok(Object.keys(s.products).length >= 20, 'on the seed, which is the floor the recorded outage exists to provide')
  assert.notEqual(s.source, 'store', 'and the source says the store is not what is being used')
}

// ══ 9. AGENT_REGISTRY_PATH is read AND written ═════════════════════════════
{
  const elsewhere = join(CLAUDE_DIR, 'elsewhere.yaml')
  writeFileSync(elsewhere, 'products:\n  only:\n    repos: [a/b]\n', 'utf-8')
  process.env.AGENT_REGISTRY_PATH = elsewhere

  const s = await store.readStore()
  assert.deepEqual(Object.keys(s.products), ['only'], 'the override is the registry')
  assert.equal(s.source, 'override', 'and says so')

  await store.writeProduct('only', { repos: ['a/b', 'c/d'] })
  assert.match(readFileSync(elsewhere, 'utf-8'), /c\/d/,
    'and is written, so an operator can point the app at a checkout and edit it there')
  delete process.env.AGENT_REGISTRY_PATH
}

rmSync(CLAUDE_DIR, { recursive: true, force: true })
console.log('product store: all assertions passed')
