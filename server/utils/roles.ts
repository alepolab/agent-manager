/**
 * Which role each signed-in person holds.
 *
 * Persisted at `resolveClaudePath('roles.json')`, a single `{ login: role }`
 * map. Same never-throw contract as `watchConfig.ts`: a missing or corrupt
 * file reads back as "nobody is listed", which — because the default is
 * `operator` — means the instance behaves exactly as it did before roles
 * existed. A broken config must not lock the team out of their own pipeline.
 *
 * The effective role is not always the real one. An operator may look at the
 * app as a lesser role (`viewAs`), which is how anyone checks what a developer
 * actually sees without a second account. It only ever narrows: `effectiveRole`
 * takes the view-as role when the real role is `operator`, and ignores it
 * otherwise, so nobody can promote themselves by asking to.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { DEFAULT_ROLE, ROLES, type Role } from '../../shared/types/role.ts'

export const ROLES_FILE_NAME = 'roles.json'

const rolesPath = () => resolveClaudePath(ROLES_FILE_NAME)

const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as string[]).includes(v)

/** Every listed login and its role. Unlisted logins are absent, not defaulted. */
export async function listRoles(): Promise<Record<string, Role>> {
  const path = rolesPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        // A typo'd role is dropped rather than coerced: silently treating
        // "reviewer" as a developer would hide the typo for good.
        .filter(([login, role]) => login.trim() && isRole(role)),
    ) as Record<string, Role>
  } catch {
    return {}
  }
}

/**
 * The role of anyone not listed. `operator` unless AGENT_MANAGER_DEFAULT_ROLE
 * names another: a team instance where newcomers should start as developers
 * sets it, and lists its admins in roles.json. Read per call, so it follows the
 * environment the server runs in; an unknown name falls back to `operator`
 * rather than locking everyone into something nobody meant.
 */
export const DEFAULT_ROLE_VAR = 'AGENT_MANAGER_DEFAULT_ROLE'
export function defaultRole(): Role {
  const v = process.env[DEFAULT_ROLE_VAR]?.trim()
  return isRole(v) ? v : DEFAULT_ROLE
}

/** The role a login really holds: its roles.json entry, else defaultRole(). */
export async function roleFor(login: string | undefined): Promise<Role> {
  if (!login) return defaultRole()
  const all = await listRoles()
  return all[login] ?? defaultRole()
}

/** Set or clear one login's role. Clearing returns them to the default. */
export async function setRole(login: string, role: Role | null): Promise<Record<string, Role>> {
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const all = await listRoles()
  if (role === null) delete all[login]
  else all[login] = role
  await writeFile(rolesPath(), `${JSON.stringify(all, null, 2)}\n`, 'utf-8')
  return all
}

/**
 * The role to enforce for this request: the real one, narrowed by `viewAs`
 * when the real one is `operator`. Everyone else's `viewAs` is ignored — it is
 * a preview of less, never a claim to more.
 */
export function effectiveRole(real: Role, viewAs?: Role | null): Role {
  if (real !== 'operator' || !viewAs || !isRole(viewAs) || viewAs === 'operator') return real
  return viewAs
}
