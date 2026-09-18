/**
 * Who is on this team, and what each of them may decide.
 *
 * The six-role model has existed since the role split and there was no way to
 * USE it: `roles.json` was edited by curl or by hand, `/team` described plugin
 * drift rather than people, and VIEW-AS is a per-browser lens that changes
 * nothing about who really holds a gate. So a workflow step saying "this is
 * QA's decision" pointed at a role nobody had been assigned.
 *
 * Two positions this file takes, because they are the ways a roles screen lies:
 *
 *  - IT NEVER INVENTS A PERSON. Members come from real signed-in profiles and
 *    from real entries in roles.json, and nothing else. A one-person instance
 *    reports one person; padding the table with plausible teammates would
 *    describe an organisation that does not exist.
 *  - `assigned` IS NOT THE SAME AS `role`. An unlisted login holds
 *    `DEFAULT_ROLE` because roles.ts defaults that way, and "nobody has chosen
 *    a role for this person" is a different fact from "someone deliberately
 *    made them an operator". The screen needs both, or the first real
 *    assignment looks like a no-op.
 *
 * Assignment authority lives here rather than only in the route, because a
 * control the browser declines to draw is still reachable by curl.
 */
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ROLES, DEFAULT_ROLE, ROLE_LABEL, capabilitiesFor, type Role } from '../../shared/types/role.ts'
import { listRoles, setRole } from './roles.ts'
import { getProfile } from './users.ts'

export interface TeamMember {
  login: string
  /** From the real profile; absent when they have never signed in. */
  name?: string
  role: Role
  /** True when a role was explicitly chosen, false when this is just the default. */
  assigned: boolean
  /** False when there is no profile yet: assigned a role but never signed in. */
  hasProfile: boolean
  label: string
  capabilities: ReturnType<typeof capabilitiesFor>
}

export class RoleAssignmentError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
    this.name = 'RoleAssignmentError'
  }
}

/** Every role the model defines, in the model's own order.
 *
 *  Derived rather than listed, so a seventh role added to shared/types/role.ts
 *  is assignable the moment it exists. A hardcoded copy here would leave it
 *  unassignable with nothing failing to say so. */
export function assignableRoles(): Role[] {
  return [...ROLES]
}

const usersDir = () => process.env.AGENT_USERS_DIR || join(process.env.HOME ?? '', '.agent-manager', 'users')

/** The logins this instance has ever seen sign in. */
async function profileLogins(): Promise<string[]> {
  const dir = usersDir()
  if (!existsSync(dir)) return []
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/**
 * Everyone this instance knows about: people who have signed in, plus anyone
 * given a role before their first sign-in.
 *
 * That second group matters. Assigning a role to a teammate who has not signed
 * in yet must not make them vanish from the screen that just assigned it.
 */
export async function listTeamMembers(): Promise<TeamMember[]> {
  const assignedRoles = await listRoles()
  const logins = [...new Set([...(await profileLogins()), ...Object.keys(assignedRoles)])].sort()

  const members: TeamMember[] = []
  for (const login of logins) {
    const profile = await getProfile(login)
    const assigned = assignedRoles[login]
    const role = assigned ?? DEFAULT_ROLE
    members.push({
      login,
      ...(profile?.name ? { name: profile.name } : {}),
      role,
      assigned: assigned !== undefined,
      hasProfile: profile !== null,
      label: ROLE_LABEL[role],
      capabilities: capabilitiesFor(role),
    })
  }
  return members
}

/**
 * Give one person a role, or clear it back to the default.
 *
 * `actorRole` is the role of whoever is asking, resolved from the session by
 * the route. Only an operator may assign: the role model makes `configure` an
 * operator-only capability, and who may decide is the same class of decision.
 */
export async function assignRole(
  login: string,
  role: Role | null | string,
  opts: { actorRole: Role },
): Promise<TeamMember> {
  if (opts.actorRole !== 'operator') {
    throw new RoleAssignmentError(403, 'Only an operator can assign roles.')
  }
  if (!login.trim()) {
    throw new RoleAssignmentError(400, 'A login is required.')
  }
  if (role !== null && !(ROLES as string[]).includes(role as string)) {
    // Named from ROLES rather than spelled out, the way view-as.post.ts does
    // it: a hardcoded list in this message ends up describing the old set,
    // which is how a 400 comes to lie about what it would have accepted.
    throw new RoleAssignmentError(400, `Unknown role. One of: ${ROLES.join(', ')} - or null to clear.`)
  }

  await setRole(login, (role as Role | null))
  const members = await listTeamMembers()
  const member = members.find(m => m.login === login)
  if (member) return member

  // Cleared, and they have no profile either, so they are no longer anyone this
  // instance knows about. Report the state rather than re-adding them.
  return {
    login,
    role: DEFAULT_ROLE,
    assigned: false,
    hasProfile: false,
    label: ROLE_LABEL[DEFAULT_ROLE],
    capabilities: capabilitiesFor(DEFAULT_ROLE),
  }
}
