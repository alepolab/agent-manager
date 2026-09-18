/**
 * Who is on this team, and what each of them may decide.
 *
 * The role model has existed since the six-role split, and there has been no
 * way to USE it: `roles.json` is edited by curl or by hand, `/team` is about
 * plugin drift rather than people, and VIEW-AS is a per-browser toggle that
 * changes nothing about who really holds a gate. So gate ownership - "this is
 * QA's decision" - pointed at a role nobody had been assigned.
 *
 * This pins the data behind a roles surface, and the two ways it could lie:
 *
 *  - INVENTED PEOPLE. A list that pads itself out, or defaults an unknown login
 *    to a role it was never given, describes a team that does not exist. The
 *    honest answer on a one-person instance is one person.
 *  - A ROLE THAT SILENTLY GOES MISSING. If the offerable roles are a hardcoded
 *    copy of the model, adding a seventh role to shared/types/role.ts leaves it
 *    unassignable with nothing failing. The list must be DERIVED.
 *
 *   node scripts/test-team-roles.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const claudeDir = mkdtempSync(join(tmpdir(), 'team-roles-claude-'))
const usersDir = mkdtempSync(join(tmpdir(), 'team-roles-users-'))
process.env.CLAUDE_DIR = claudeDir
process.env.AGENT_USERS_DIR = usersDir

const { ROLES, DEFAULT_ROLE, ROLE_LABEL, capabilitiesFor } = await import('../shared/types/role.ts')
const { listTeamMembers, assignRole, RoleAssignmentError } = await import('../server/utils/team.ts')
const { listRoles } = await import('../server/utils/roles.ts')

const profile = (login, name) => writeFileSync(
  join(usersDir, `${login}.json`),
  JSON.stringify({ login, name, updatedAt: Date.now() }, null, 2),
)

// ---- one person is one person -----------------------------------------------
// The instance this ships on genuinely has a single signed-in human. A table
// padded with placeholder teammates would be a lie told by the UI.
{
  profile('sandeep-patel-alepo-fifth', 'Sandeep Patel')
  const members = await listTeamMembers()
  assert.equal(members.length, 1, `one profile means one member; got ${JSON.stringify(members.map(m => m.login))}`)
  assert.equal(members[0].login, 'sandeep-patel-alepo-fifth')
  assert.equal(members[0].name, 'Sandeep Patel', 'the display name comes from the real profile')
  assert.equal(members[0].role, DEFAULT_ROLE, 'an unlisted login holds the default role')
  assert.equal(members[0].assigned, false,
    'and it is marked NOT assigned, so "nobody chose this" is distinguishable from "someone chose operator"')
}

// ---- an assignment persists through the real code path ----------------------
{
  const after = await assignRole('sandeep-patel-alepo-fifth', 'qa', { actorRole: 'operator' })
  assert.equal(after.role, 'qa')
  assert.equal(after.assigned, true, 'an explicit assignment is marked as one')

  const onDisk = await listRoles()
  assert.equal(onDisk['sandeep-patel-alepo-fifth'], 'qa',
    'the role reaches roles.json, which is what roleFor() and every gate read')

  const members = await listTeamMembers()
  assert.equal(members.find(m => m.login === 'sandeep-patel-alepo-fifth').role, 'qa', 'and the list reflects it')
}

// ---- a person listed in roles.json but with no profile still appears -------
// Otherwise assigning a role to a teammate who has not signed in yet makes them
// vanish from the very screen that assigned it.
{
  await assignRole('jitendrajaware-alepo', 'architect', { actorRole: 'operator' })
  const members = await listTeamMembers()
  const jitendra = members.find(m => m.login === 'jitendrajaware-alepo')
  assert.ok(jitendra, `a login with a role but no profile is still a member; got ${JSON.stringify(members.map(m => m.login))}`)
  assert.equal(jitendra.role, 'architect')
  assert.equal(jitendra.hasProfile, false, 'and the list says they have not signed in, rather than inventing a name')
}

// ---- only an operator may assign ------------------------------------------
// Enforced where it matters, not only hidden in the UI: a control the browser
// does not draw is still reachable by curl.
{
  for (const role of ROLES.filter(r => r !== 'operator')) {
    await assert.rejects(
      () => assignRole('sandeep-patel-alepo-fifth', 'developer', { actorRole: role }),
      (err) => {
        assert.ok(err instanceof RoleAssignmentError, `a ${role} is refused with the typed error`)
        assert.equal(err.statusCode, 403)
        assert.match(err.message, /operator/i, 'and the message says who may do it')
        return true
      },
      `${role} must not be able to assign roles`,
    )
  }
  // The refusal must not have changed anything.
  assert.equal((await listRoles())['sandeep-patel-alepo-fifth'], 'qa', 'a refused assignment leaves the stored role alone')
}

// ---- a role outside the model is refused ----------------------------------
{
  await assert.rejects(
    () => assignRole('sandeep-patel-alepo-fifth', 'reviewer', { actorRole: 'operator' }),
    (err) => {
      assert.equal(err.statusCode, 400)
      // Named from ROLES rather than spelled out, the way view-as.post.ts does
      // it: a hardcoded list in the message ends up lying about what would
      // have been accepted.
      for (const role of ROLES) assert.match(err.message, new RegExp(role), `the message names ${role}`)
      return true
    },
    'a role that does not exist cannot be assigned',
  )
}

// ---- clearing returns someone to the default ------------------------------
{
  const cleared = await assignRole('sandeep-patel-alepo-fifth', null, { actorRole: 'operator' })
  assert.equal(cleared.role, DEFAULT_ROLE)
  assert.equal(cleared.assigned, false, 'cleared is not the same as assigned-to-the-default')
  assert.equal((await listRoles())['sandeep-patel-alepo-fifth'], undefined, 'and the entry is gone from roles.json')
}

// ---- the offerable roles are DERIVED from the model -----------------------
// The guard against a seventh role being added and silently unassignable.
{
  const { assignableRoles } = await import('../server/utils/team.ts')
  assert.deepEqual(assignableRoles(), [...ROLES],
    'every role in the model is assignable, in the model\'s own order')
  for (const role of assignableRoles()) {
    assert.ok(ROLE_LABEL[role], `${role} has a label to render`)
    assert.ok(capabilitiesFor(role), `${role} has a capability row, so the UI can say what it grants`)
  }
}

rmSync(claudeDir, { recursive: true, force: true })
rmSync(usersDir, { recursive: true, force: true })
console.log('team roles: real people only, assignment is operator-only, and every role in the model is assignable')
