/**
 * Every route that changes something says who may change it.
 *
 * This is the test that would have caught all four of this session's role
 * defects at once. Each was the same shape: a handler that mutates the instance
 * and never asks what the caller may do. The auth middleware establishes WHO a
 * request is; it has never said WHAT that person is allowed to do, and four
 * separate routes were written as though it did.
 *
 *   - DELETE /api/runs/[id]      destroyed a run and its evidence for any role
 *   - POST   .../dismiss         mutated a run record for any role
 *   - POST   /api/chat           ran an agent with permissions bypassed, for any role
 *   - PUT    /api/projects/...   wrote files to a caller-supplied path, for any role
 *
 * Reviewing for this by eye does not scale: the guard is one line, its absence
 * looks like nothing, and the route still works perfectly for the person who
 * wrote it. So the rule is mechanical — a mutating method means a capability
 * check, unless the route is on the list below with a reason.
 *
 * Adding a route to ALLOWED is a deliberate act that should be argued for in
 * review. Leaving one out by accident now fails here instead of shipping.
 *
 *   node scripts/test-routes-are-guarded.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const API = 'server/api'
const MUTATING = /\.(post|put|delete|patch)\.ts$/

/**
 * Routes that legitimately carry no capability check, each with the reason it
 * does not need one. Every entry is either unauthenticated by design, acts only
 * on the caller's own account, or enforces something stricter itself.
 */
const ALLOWED = new Map([
  ['auth/logout.post.ts', 'Public auth path; clears the caller\'s own session.'],
  ['auth/token.post.ts', 'Public auth path; authenticates by bearer token and refuses anything else.'],
  ['view-as.post.ts', 'Enforces something stricter itself: refuses anyone whose REAL role is not operator, and only ever narrows.'],
  ['me.put.ts', 'The caller\'s own profile. Every role must be able to set their own Jira credentials.'],
  ['me/jira-test.post.ts', 'Tests the caller\'s own stored credentials; reads nothing else.'],
  ['chat-ws/sessions/[id].delete.ts', 'Legacy no-op: throws 404 unconditionally and deletes nothing.'],
])

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (MUTATING.test(entry.name)) out.push(path)
  }
  return out
}

const files = await walk(API)
assert.ok(files.length > 30, `expected to find the API's mutating routes, found ${files.length}`)

const unguarded = []
for (const file of files) {
  const key = relative(API, file).split(/[\\/]/).join('/')
  const source = readFileSync(file, 'utf8')
  const guarded = source.includes('requireCapability')
  if (guarded) {
    // A route cannot be both guarded and excused: an entry left in ALLOWED
    // after its route grew a real check is a stale excuse, and the next
    // reviewer would trust it.
    assert.ok(!ALLOWED.has(key), `${key} has a capability check now — remove it from ALLOWED`)
    continue
  }
  if (ALLOWED.has(key)) continue
  unguarded.push(key)
}

assert.deepEqual(unguarded, [],
  'these routes mutate the instance and never ask what the caller may do. Add '
  + 'requireCapability(event, ...), or add the route to ALLOWED with the reason it '
  + `does not need one:\n  ${unguarded.join('\n  ')}`)

// Every excuse must name a route that exists, or the list rots into fiction.
for (const key of ALLOWED.keys()) {
  assert.ok(files.some(f => relative(API, f).split(/[\\/]/).join('/') === key),
    `ALLOWED names ${key}, which is not a route any more — delete the entry`)
}

console.log(`routes are guarded: ${files.length} mutating routes, ${ALLOWED.size} documented exceptions, 0 unguarded`)
