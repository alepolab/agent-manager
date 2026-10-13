/**
 * L1/L2/L3 by team: who sees and acts on whose runs and chats.
 *
 *   node scripts/test-hierarchy.mjs
 *
 * The rules are small and the cost of getting one wrong is a person seeing a
 * colleague's work they should not, or a lead locked out of their own team's.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hierarchy-'))
process.env.CLAUDE_DIR = join(root, 'claude')
process.env.AGENT_USERS_DIR = join(root, 'users')
process.env.AGENT_SESSION_OWNERS_FILE = join(root, 'session-owners.json')
delete process.env.AGENT_RUN_AS
delete process.env.AUTH_DISABLED

const { teamOf, placementProblem } = await import('../shared/types/hierarchy.ts')
const h = await import('../server/utils/hierarchy.ts')
const so = await import('../server/utils/sessionOwners.ts')

try {
  // ── nobody placed: the instance as it was, everyone sees everything ──
  assert.deepEqual(await h.scopeFor('anyone'), { all: true })
  assert.equal(h.inScope(await h.scopeFor('anyone'), 'someone-else'), true)

  // ── a team: carol L3 → bob L2 → alice L1, dave L1; erin L2 in another team under carol; frank L1 under erin ──
  await h.setPlacement('carol', { level: 3 })
  await h.setPlacement('bob', { level: 2, lead: 'carol' })
  await h.setPlacement('erin', { level: 2, lead: 'carol' })
  await h.setPlacement('alice', { level: 1, lead: 'bob' })
  await h.setPlacement('dave', { level: 1, lead: 'bob' })
  await h.setPlacement('frank', { level: 1, lead: 'erin' })
  const all = await h.listPlacements()

  assert.deepEqual(teamOf('bob', all).sort(), ['alice', 'dave'])
  assert.deepEqual(teamOf('carol', all).sort(), ['alice', 'bob', 'dave', 'erin', 'frank'])
  assert.deepEqual(teamOf('alice', all), [])

  // seeing: own + team, by team not by level
  const see = async (who, owner) => h.inScope(await h.scopeFor(who), owner)
  assert.equal(await see('alice', 'alice'), true, 'an L1 sees their own')
  assert.equal(await see('alice', 'dave'), false, 'not a fellow L1')
  assert.equal(await see('alice', 'bob'), false, 'not their lead')
  assert.equal(await see('bob', 'alice'), true, 'an L2 sees their L1')
  assert.equal(await see('bob', 'frank'), false, "an L2 does not see another L2's L1")
  assert.equal(await see('bob', 'erin'), false, 'nor a fellow L2')
  assert.equal(await see('carol', 'frank'), true, 'an L3 sees through their L2s')
  assert.equal(await see('alice', undefined), false, 'ownerless work is not a placed person\'s')
  assert.equal(await see('zed', 'alice'), true, 'someone unplaced still sees everything')

  // supervising: strictly above, never oneself
  assert.equal(await h.supervises('bob', 'alice'), true)
  assert.equal(await h.supervises('carol', 'alice'), true)
  assert.equal(await h.supervises('alice', 'alice'), false)
  assert.equal(await h.supervises('erin', 'alice'), false)

  // ── placements that would break the tree are refused ──
  await assert.rejects(h.setPlacement('alice', { level: 1, lead: 'dave' }), /cannot lead an L1/, 'a lead must be higher')
  await assert.rejects(h.setPlacement('bob', { level: 2, lead: 'bob' }), /nobody leads themselves/)
  await assert.rejects(h.setPlacement('carol', { level: 3, lead: 'alice' }), /cannot lead an L3/)
  await assert.rejects(h.setPlacement('bob', { level: 1, lead: 'carol' }), /alice is L1 and led by @bob/, 'demoting a lead below their team')
  await assert.rejects(h.setPlacement('alice', { level: 1, lead: 'ghost' }), /has no level/)
  await assert.rejects(h.setPlacement('bob', null), /still leads @alice, @dave|still leads/, 'removing a lead orphans a team')
  assert.equal(placementProblem('x', { level: 4 }, {}), 'level must be 1, 2 or 3')
  // moving alice to erin's team is fine
  await h.setPlacement('alice', { level: 1, lead: 'erin' })
  assert.equal(await see('bob', 'alice'), false)
  assert.equal(await see('erin', 'alice'), true)
  await h.setPlacement('alice', { level: 1, lead: 'bob' })

  // ── a corrupt file reads as nobody placed, never as a lock-out ──
  writeFileSync(join(root, 'claude', 'hierarchy.json'), '{not json')
  assert.deepEqual(await h.scopeFor('alice'), { all: true })
  writeFileSync(join(root, 'claude', 'hierarchy.json'), JSON.stringify(all))

  // ── chat sessions: owners recorded, scoped like runs, continued only by their owner ──
  await so.recordSessionOwner('s-alice', 'alice')
  await so.recordSessionOwner('s-frank', 'frank')
  await so.recordSessionOwner('s-alice', 'bob')
  assert.equal(await so.sessionOwner('s-alice'), 'alice', 'the first owner stands')
  assert.equal(await so.sessionOwner('s-unknown'), undefined)

  const ids = ['s-alice', 's-frank', 's-unknown'].map(id => ({ id }))
  assert.deepEqual((await so.visibleSessions(await h.scopeFor('bob'), ids)).map(s => s.id), ['s-alice'])
  assert.deepEqual((await so.visibleSessions(await h.scopeFor('carol'), ids)).map(s => s.id), ['s-alice', 's-frank'])
  assert.equal((await so.visibleSessions(await h.scopeFor('zed'), ids)).length, 3, 'unplaced: all, unowned included')

  assert.equal(await so.resumeProblem('alice', 's-alice'), null, 'the owner continues their own')
  assert.match(await so.resumeProblem('bob', 's-alice'), /@alice's session.*only they can continue/, 'a lead reads, does not take over')
  assert.equal(await so.resumeProblem('dave', 's-alice'), 'Session not found', 'a peer does not even learn it exists')
  assert.match(await so.resumeProblem('alice', 's-unknown'), /no recorded owner/)
  assert.equal(await so.resumeProblem('zed', 's-unknown'), null, 'unplaced: an unowned session, as before')
  // Owner-only holds for the unplaced too: before anyone is placed everyone is
  // unplaced, and they could otherwise continue anyone's chat on their own
  // credential (review on #150).
  assert.match(await so.resumeProblem('zed', 's-alice'), /@alice's session.*only they can continue/, 'unplaced cannot continue an owned session')
  assert.equal(await so.resumeProblem(undefined, 's-alice') !== null, true, 'nor can nobody')

  assert.equal(await so.sessionInScope('bob', 's-alice'), true)
  assert.equal(await so.sessionInScope('bob', 's-frank'), false)

  // owner index survives a reload from disk
  const fresh = await import(`../server/utils/sessionOwners.ts?reload=${Date.now()}`)
  assert.equal(await fresh.sessionOwner('s-frank'), 'frank')

  // ── what the hierarchy may grant, per route (review on #150) ──
  // Placing someone must not hand them every capability on their runs: an L1
  // deleting their rejected run (and its evidence) or restarting past the gate
  // that rejected it is exactly what the role guards exist to stop.
  {
    const { readFileSync } = await import('node:fs')
    const route = (f) => readFileSync(join(import.meta.dirname, '..', 'server', 'api', 'runs', f), 'utf8')
    const grant = (f) => /requireRunAccess\(event, '\w+'(?:, '([\w-]+)')?\)/.exec(route(f))?.[1] ?? 'role only'
    const expected = {
      '[id].delete.ts': 'role only', '[id]/restart.post.ts': 'role only', '[id]/test.post.ts': 'role only',
      '[id]/stop.post.ts': 'owner-or-lead', '[id]/note.post.ts': 'owner-or-lead', '[id]/dismiss.post.ts': 'owner-or-lead',
      '[id]/continue.post.ts': 'lead', '[id]/reject.post.ts': 'lead', '[id]/rework.post.ts': 'lead',
      '[id]/respond.post.ts': 'lead', '[id]/decisions.post.ts': 'lead',
    }
    for (const [f, want] of Object.entries(expected)) assert.equal(grant(f), want, `${f}: the hierarchy grants ${want}`)
  }

  console.log('hierarchy: scope by team, tree kept sound, chats owned and continued only by their owner')
} finally {
  rmSync(root, { recursive: true, force: true })
}
