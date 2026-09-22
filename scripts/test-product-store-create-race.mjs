// Two creates of the same new product key: one wins, the other is told the
// key is taken, and the winner's entry and rationale survive intact.
//
// The old route asked "is this key taken?" with a readStore() of its own and
// then called writeProduct, which opened the file again. Two file reads apart,
// so both callers saw the key free and the second silently overwrote the
// first - its product and its rationale together. expectedMtimeMs does not
// cover it: it tolerates a second of skew, and a create has no prior mtime to
// send at all, so the check is skipped outright.
//
// Note the store seeds itself with the shipped registry, so every key here is
// one the seed does not use.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'product-race-'))

const store = await import('../server/utils/productStore.ts')

const product = (repo) => ({
  repo,
  branches: { bug: 'develop' },
})

// ── 1. Two concurrent creates of one key ──────────────────────────────────
{
  const results = await Promise.all([
    store.createProduct('zz-probe', product('alepo/zz-first'), { comment: 'first' }),
    store.createProduct('zz-probe', product('alepo/zz-second'), { comment: 'second' }),
  ])

  const won = results.filter(r => r !== null)
  const lost = results.filter(r => r === null)
  assert.equal(won.length, 1, 'exactly one create succeeds')
  assert.equal(lost.length, 1, 'and the other is told the key is taken, rather than silently overwriting it')

  const read = await store.readStore()
  assert.ok(read.products['zz-probe'], 'the product is there')
  // Whichever won, the store must hold ONE coherent entry - not the first
  // caller's product carrying the second's rationale, which is what two
  // interleaved load-modify-saves produced.
  const repo = read.products['zz-probe'].repo
  assert.ok(repo === 'alepo/zz-first' || repo === 'alepo/zz-second', repo)

  const text = readFileSync(read.path, 'utf8')
  const rationale = repo === 'alepo/zz-first' ? 'first' : 'second'
  const orphaned = repo === 'alepo/zz-first' ? 'second' : 'first'
  assert.match(text, new RegExp(`#[^\\n]*${rationale}[\\s\\S]{0,120}zz-probe:`),
    'the surviving entry keeps its own rationale above it')
  assert.doesNotMatch(text, new RegExp(`#[^\\n]*\\b${orphaned}\\b`),
    'and the losing create left no rationale behind for an entry that is not there')
  assert.equal(read.degraded, false, 'the store still parses')
}

// ── 2. A create of a key that is already there is refused, not merged ─────
{
  assert.equal(await store.createProduct('zz-probe', product('alepo/zz-third')), null,
    'a second create of an existing key answers null, which the route turns into a 409')
  const read = await store.readStore()
  assert.notEqual(read.products['zz-probe'].repo, 'alepo/zz-third', 'and it changed nothing')
}

// ── 3. An update still goes through writeProduct ──────────────────────────
{
  const before = await store.readStore()
  await store.writeProduct('zz-probe', product('alepo/zz-updated'), { comment: 'updated' })
  const read = await store.readStore()
  assert.equal(read.products['zz-probe'].repo, 'alepo/zz-updated', 'writeProduct still creates-or-updates')
  assert.notEqual(read.mtimeMs, null)
  assert.equal(Object.keys(before.products).length, Object.keys(read.products).length, 'an update adds no entry')
}

// ── 4. Concurrent writes to DIFFERENT keys all survive ────────────────────
// The serialised section must not be a lock that loses work - every write
// lands, in some order.
{
  const keys = ['zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e']
  await Promise.all(keys.map(k => store.createProduct(k, product(`alepo/${k}`), { comment: k })))
  const read = await store.readStore()
  for (const k of keys) {
    assert.ok(read.products[k], `${k} was lost to a concurrent write`)
    assert.equal(read.products[k].repo, `alepo/${k}`)
  }
  assert.ok(existsSync(read.path))
  // And the file still parses - the point of writing through one section.
  assert.equal(read.degraded, false, 'the store parses after five concurrent writes')
}

// ── 5. A delete of an absent key is still null, not a throw ───────────────
{
  assert.equal(await store.deleteProduct('never-registered'), null)
  assert.notEqual(await store.deleteProduct('zz-a'), null, 'and a present one is removed')
  assert.equal((await store.readStore()).products['zz-a'], undefined)
}

console.log('product store create race: all checks passed')
