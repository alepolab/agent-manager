/**
 * Who leads whom: `resolveClaudePath('hierarchy.json')`, a `{ login: { level,
 * lead? } }` map beside roles.json. See shared/types/hierarchy.ts for the model.
 *
 * Same never-throw contract as roles.ts: a missing or corrupt file reads back
 * as "nobody is placed", which is exactly the instance before levels existed -
 * everyone sees every run. A broken file must not hide a team's work from it.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { isLevel, placementProblem, teamOf, type Placement } from '../../shared/types/hierarchy.ts'

export const HIERARCHY_FILE_NAME = 'hierarchy.json'

const hierarchyPath = () => resolveClaudePath(HIERARCHY_FILE_NAME)

/** Every placed login. Entries with a bad level are dropped, not coerced. */
export async function listPlacements(): Promise<Record<string, Placement>> {
  const path = hierarchyPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, Placement> = {}
    for (const [login, p] of Object.entries(parsed as Record<string, any>)) {
      if (!login.trim() || !p || !isLevel(p.level)) continue
      out[login] = { level: p.level, ...(typeof p.lead === 'string' && p.lead.trim() ? { lead: p.lead.trim() } : {}) }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Place a login, or take them out of the hierarchy with null. Refuses a
 * placement that would make a loop or put a lead below the person they lead,
 * and refuses to remove someone who still leads others: their team would
 * silently lose its supervisor.
 */
export async function setPlacement(login: string, next: Placement | null): Promise<Record<string, Placement>> {
  const all = await listPlacements()
  if (next === null) {
    const led = Object.entries(all).filter(([, p]) => p.lead === login).map(([m]) => m)
    if (led.length) throw new Error(`@${login} still leads ${led.map(m => `@${m}`).join(', ')}; give them another lead first`)
    delete all[login]
  } else {
    const problem = placementProblem(login, next, all)
    if (problem) throw new Error(problem)
    all[login] = { level: next.level, ...(next.lead ? { lead: next.lead } : {}) }
  }
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(hierarchyPath(), `${JSON.stringify(all, null, 2)}\n`, 'utf-8')
  return all
}

/**
 * Whose work a login may see: everyone (`all`), or themselves and their team.
 * Unplaced, or no login at all (auth disabled is one person), sees everyone.
 */
export type Scope = { all: true } | { all: false, logins: Set<string> }

export async function scopeFor(login: string | undefined): Promise<Scope> {
  if (!login) return { all: true }
  const placements = await listPlacements()
  if (!placements[login]) return { all: true }
  return { all: false, logins: new Set([login, ...teamOf(login, placements)]) }
}

/** Whether a scope covers work owned by `owner`. Ownerless work is only for the unscoped. */
export function inScope(scope: Scope, owner: string | undefined): boolean {
  if (scope.all) return true
  return !!owner && scope.logins.has(owner)
}

/** True when `actor` leads `owner`, directly or through others. Not true of oneself. */
export async function supervises(actor: string | undefined, owner: string | undefined): Promise<boolean> {
  if (!actor || !owner || actor === owner) return false
  return teamOf(actor, await listPlacements()).includes(owner)
}

/**
 * When `actor` acts on work `owner` started, on what authority: as their lead
 * (at any distance), or by role - an operator, or a reviewer answering the gate
 * their role owns. Null when it is their own work, or nobody started it.
 */
export async function actingFor(actor: string | undefined, owner: string | undefined): Promise<{ onBehalfOf: string, authority: 'lead' | 'role' } | null> {
  if (!actor || !owner || actor === owner) return null
  return { onBehalfOf: owner, authority: await supervises(actor, owner) ? 'lead' : 'role' }
}
