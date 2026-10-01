/**
 * The quota block survives a restart: the queue sweep rebuilds it from the
 * runs paused on the quota before starting anything. The block lived only in
 * memory, and the boot sweep ran before the paused runs were read, so a
 * restart while the quota was spent started four runs straight into it.
 *
 *   node scripts/test-quota-block-survives-restart.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../server/utils/runQueue.ts', import.meta.url), 'utf8')
const drain = src.slice(src.indexOf('export function drainRunQueue'))
const rebuild = drain.indexOf("r.question?.reason === 'quota'")
assert.ok(rebuild > 0, 'the sweep reads the quota-paused runs')
assert.ok(rebuild < drain.indexOf('const queued = runs.filter'), 'before it looks at what is queued')
assert.match(drain, /if \(spentUntil > Date\.now\(\)\) \{\s*blockForQuota\(spentUntil\)\s*return 0/, 'and starts nothing while the quota is spent')
console.log('ok - the quota block survives a restart')
