import assert from 'node:assert/strict'
const M = await import('../server/utils/memo.ts')
let calls = 0
const fn = async () => { calls++; return calls }
assert.equal(await M.memo('agents:x', 30_000, fn), 1)
assert.equal(await M.memo('agents:x', 30_000, fn), 1, 'a second hit within the TTL is served from cache')
assert.equal(calls, 1)
M.invalidate('agents')
assert.equal(await M.memo('agents:x', 30_000, fn), 2, 'invalidate forces a fresh scan')
assert.equal(await M.memo('skills:y', 30_000, fn), 3, 'other keys are independent')
M.invalidate('nothing')
assert.equal(await M.memo('skills:y', 30_000, fn), 3, 'unrelated prefixes leave entries alone')
assert.equal(await M.memo('ttl', 1, fn), 4); await new Promise(r => setTimeout(r, 5)); assert.equal(await M.memo('ttl', 1, fn), 5, 'an expired entry is recomputed')
let fails = 0
const bad = async () => { fails++; throw new Error('boom') }
await assert.rejects(M.memo('bad', 30_000, bad)); await new Promise(r => setTimeout(r, 0))
await assert.rejects(M.memo('bad', 30_000, bad)); assert.equal(fails, 2, 'a failed scan is not cached')
console.log('memo: all assertions passed')
