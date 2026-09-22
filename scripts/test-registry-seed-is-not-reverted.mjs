/**
 * A registry edited here survives a restart.
 *
 * teamSync rewrites its seeded items at EVERY boot. That is deliberate — it is
 * how a team standard stays a standard — and `TeamStatus.reverted` exists
 * because the loss used to be silent: an operator's edit to a shipped agent
 * worked on the next run and was gone after the next restart, with nothing in
 * the UI, the boot log or the filesystem saying so.
 *
 * The registry must not join that set. A developer who corrects a product's
 * branch policy from the Products page and finds it back on the plugin's
 * version tomorrow morning has a pipeline that silently cuts branches from the
 * wrong base, and no way to tell that is what happened.
 *
 * So the guarantee is structural rather than a flag: productStore.ensureSeeded
 * writes only when the file does not exist, and teamSync has no path that
 * writes the registry at all. This asserts both, through the real boot call.
 *
 *   node scripts/test-registry-seed-is-not-reverted.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'registry-seed-'))
process.env.TEAM_SEED_ON_BOOT = '1'
delete process.env.AGENT_REGISTRY_PATH

const store = await import('../server/utils/productStore.ts')
const { teamSync } = await import('../server/utils/teamSync.ts')

const STORE = store.storePath()
const read = () => readFileSync(STORE, 'utf-8')

// Seed, then make a routing change of exactly the kind a person would.
await store.readStore()
const before = await store.readStore()
await store.writeProduct('crm', { ...before.products.crm, branches: { ...before.products.crm.branches, bug: 'a-branch-a-person-chose' } })
const edited = read()
assert.match(edited, /a-branch-a-person-chose/, 'the edit is on disk before the boot')

// Two boots, which is what it took for the agent case to disappear.
const first = await teamSync('boot')
const second = await teamSync('boot')

assert.equal(read(), edited,
  'THE REQUIREMENT: the registry store is byte-identical after two boots — nothing copies the seed over an existing store')

const after = await store.readStore()
assert.equal(after.products.crm.branches.bug, 'a-branch-a-person-chose',
  'and the routing change a person made is still the one in force')

for (const status of [first, second]) {
  assert.ok(Array.isArray(status.reverted), 'teamSync still reports what it reverted')
  assert.deepEqual(status.reverted.filter(r => r.kind === 'product'), [],
    'THE REQUIREMENT: the registry is never among the items an apply overwrites')
  assert.ok(status.registry.products > 0, 'and the Team page still reports the registry it read')
}

// The seed sidecar still describes the SEED, not the current file: it is the
// answer to "where did this come from", not "what is in it now".
const seed = store.seedInfo()
assert.ok(seed?.seededAt, 'the sidecar survives')
assert.notEqual(seed.seedSha256, '', 'and still records the hash of what was originally copied')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry seed is not reverted: all assertions passed')
