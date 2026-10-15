/**
 * Who a chat session belongs to, so the hierarchy can scope chats the way it
 * scopes runs (hierarchy.ts, runAccess.ts).
 *
 * A run carries its starter; a Claude Code transcript carries nothing of the
 * kind. So the owner is recorded the moment the SDK names the session - in the
 * /cli chat and in every pipeline agent call - in a small index beside the
 * users directory. With agents running as their developers' own users there is
 * a second witness: whose directory the transcript is in.
 *
 * A session nobody recorded - older than this file, or started by a CLI
 * outside the app - has no owner, and like a run with no starter is visible
 * only to people outside the hierarchy.
 */
import type { H3Event } from 'h3'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { can, rolesWith, type Capabilities } from '../../shared/types/role.ts'
import { usersDir } from './users.ts'
import { developerProjectsDirs } from './osUsers.ts'
import { inScope, scopeFor, supervises, type Scope } from './hierarchy.ts'
import { currentRole, currentUser } from './session.ts'

const ownersFile = () => process.env.AGENT_SESSION_OWNERS_FILE || join(dirname(usersDir()), 'session-owners.json')

let cache: Record<string, string> | null = null
let writing: Promise<void> = Promise.resolve()

async function load(): Promise<Record<string, string>> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(await readFile(ownersFile(), 'utf8'))
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    cache = {}
  }
  return cache!
}

/** Record that `login` owns `sessionId`. The first owner stands: a resume does not change hands. */
export async function recordSessionOwner(sessionId: string, login: string | undefined): Promise<void> {
  if (!sessionId || !login) return
  const owners = await load()
  if (owners[sessionId]) return
  owners[sessionId] = login
  // Serialised, and written whole through a rename, so two sessions starting
  // together cannot interleave a half-written file.
  writing = writing.then(async () => {
    const file = ownersFile()
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(owners), { mode: 0o600 })
    await rename(tmp, file)
  }).catch(err => console.warn('[sessionOwners] could not record owner:', err instanceof Error ? err.message : err))
  await writing
}

/**
 * The login a session belongs to, or undefined. The index first; then, with
 * agents running as their own users, the developer whose directory holds it
 * (developers/<login>/home/.claude/projects/<project>/<id>.jsonl).
 */
export async function sessionOwner(sessionId: string): Promise<string | undefined> {
  const recorded = (await load())[sessionId]
  if (recorded) return recorded
  for (const projects of developerProjectsDirs()) {
    try {
      for (const project of readdirSync(projects)) {
        if (existsSync(join(projects, project, `${sessionId}.jsonl`))) {
          return projects.split('/').slice(-4, -3)[0]
        }
      }
    } catch { /* unreadable: not theirs to claim */ }
  }
  return undefined
}

/** The caller's scope, for filtering a list of sessions. */
export async function callerScope(event: H3Event): Promise<Scope> {
  return scopeFor((await currentUser(event))?.login)
}

/** Sessions from a list that this scope covers. */
export async function visibleSessions<T extends { id: string }>(scope: Scope, sessions: T[]): Promise<T[]> {
  if (scope.all) return sessions
  const out: T[] = []
  for (const s of sessions) if (inScope(scope, await sessionOwner(s.id))) out.push(s)
  return out
}

/**
 * The gate on a route that names a session: 404 outside your scope, and -
 * given a capability - the same two doors as a run: the capability by role, or
 * being placed in the hierarchy with the session yours or your team's.
 */
export async function requireSessionAccess(event: H3Event, sessionId: string, capability?: keyof Capabilities): Promise<void> {
  const scope = await callerScope(event)
  if (!inScope(scope, await sessionOwner(sessionId))) {
    throw createError({ statusCode: 404, message: 'Session not found' })
  }
  if (!capability) return
  const role = await currentRole(event)
  if (can(role, capability) || !scope.all) return
  throw createError({ statusCode: 403, message: `Your role (${role}) cannot do this. Ask ${rolesWith(capability).join(' or ')}.` })
}

/**
 * Whether `login` may continue `sessionId` in the chat. Only its owner: in a
 * shared instance the continuation runs on the continuer's Claude credential
 * and, with agents as their own users, as their user - which cannot even open
 * someone else's transcript. A lead reads their team's sessions; they do not
 * take them over. Unowned sessions stay open to people outside the hierarchy.
 */
export async function resumeProblem(login: string | undefined, sessionId: string): Promise<string | null> {
  const owner = await sessionOwner(sessionId)
  if (owner && owner === login) return null
  const scope = await scopeFor(login)
  if (!owner) return scope.all ? null : 'This session has no recorded owner, so it can only be continued by someone outside the team hierarchy.'
  // Owned by someone else: refused whatever the hierarchy says. The reason -
  // their credential, their Unix user - holds for the unplaced too; before
  // anyone is placed everyone is unplaced, and "anyone may continue anyone's
  // chat" was exactly the hole. Only how much the refusal reveals differs.
  if (!inScope(scope, owner)) return 'Session not found'
  return `This is @${owner}'s session. You can read it, but only they can continue it.`
}

/**
 * One page of a project's sessions, scoped. Unplaced callers get the page as
 * it always was; for someone in a team every session is read, the visible ones
 * kept, and the page cut from those - paging first and filtering after would
 * hand them short, uneven pages and a total that counts other people's.
 */
export async function scopedSessionPage<T extends { id: string }>(
  event: H3Event,
  fetchPage: (limit: number, offset: number) => Promise<{ sessions: T[], hasMore: boolean, total: number }>,
  limit: number,
  offset: number,
): Promise<{ sessions: T[], hasMore: boolean, total: number }> {
  const scope = await callerScope(event)
  if (scope.all) return fetchPage(limit, offset)
  const all = await visibleSessions(scope, (await fetchPage(Number.MAX_SAFE_INTEGER, 0)).sessions)
  return { sessions: all.slice(offset, offset + limit), hasMore: offset + limit < all.length, total: all.length }
}

/**
 * Projects with their session counts cut to what the caller may see, dropping
 * those with none. `idsOf` names a project's sessions (its transcript files).
 */
export async function scopedProjects<P extends { name: string, sessionCount?: number, sessionsCount?: number }>(
  event: H3Event,
  projects: P[],
  idsOf: (projectName: string) => Promise<string[]>,
): Promise<P[]> {
  const scope = await callerScope(event)
  if (scope.all) return projects
  const out: P[] = []
  for (const p of projects) {
    const visible = await visibleSessions(scope, (await idsOf(p.name)).map(id => ({ id })))
    if (!visible.length) continue
    out.push({
      ...p,
      ...('sessionCount' in p ? { sessionCount: visible.length } : {}),
      ...('sessionsCount' in p ? { sessionsCount: visible.length } : {}),
    })
  }
  return out
}

/** Whether `login` may touch `sessionId` at all - for paths with no H3Event, like the chat socket. */
export async function sessionInScope(login: string | undefined, sessionId: string): Promise<boolean> {
  return inScope(await scopeFor(login), await sessionOwner(sessionId))
}
