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
import { isLevel, placementProblem, teamOf, type Level, type Placement } from '../../shared/types/hierarchy.ts'
import { roleFor } from './roles.ts'

export const HIERARCHY_FILE_NAME = 'hierarchy.json'

const hierarchyPath = () => resolveClaudePath(HIERARCHY_FILE_NAME)

async function readRaw(): Promise<Record<string, any>> {
  const path = hierarchyPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Every placed login. Entries with a bad level are dropped, not coerced. */
export async function listPlacements(): Promise<Record<string, Placement>> {
  const out: Record<string, Placement> = {}
  for (const [login, p] of Object.entries(await readRaw())) {
    if (!login.trim() || !p || !isLevel(p.level)) continue
    out[login] = { level: p.level, ...(typeof p.lead === 'string' && p.lead.trim() ? { lead: p.lead.trim() } : {}) }
  }
  return out
}

/**
 * Logins an operator took out of the hierarchy on purpose (`{"level": null}`).
 * Kept apart from "never placed", because with a default level those two mean
 * different things: never placed takes the default, taken out sees everything.
 */
export async function listUnplacedOnPurpose(): Promise<string[]> {
  return Object.entries(await readRaw()).filter(([l, p]) => l.trim() && p && p.level === null).map(([l]) => l)
}

/**
 * The level of anyone who is not an operator and has no entry: 1, 2 or 3 from
 * AGENT_MANAGER_DEFAULT_LEVEL, else none (sees everything, the behaviour before
 * levels). Operators are left out: an admin who sees only their own runs cannot
 * administer, and promoting someone to operator should not leave them blind.
 */
export const DEFAULT_LEVEL_VAR = 'AGENT_MANAGER_DEFAULT_LEVEL'
export function defaultLevel(): Level | null {
  const n = Number(process.env[DEFAULT_LEVEL_VAR])
  return isLevel(n) ? n : null
}

/**
 * Place a login, or take them out of the hierarchy with null. Refuses a
 * placement that would make a loop or put a lead below the person they lead,
 * and refuses to remove someone who still leads others: their team would
 * silently lose its supervisor.
 */
export async function setPlacement(login: string, next: Placement | null | 'default'): Promise<Record<string, Placement>> {
  const all = await listPlacements()
  const raw = await readRaw()
  if (next === null || next === 'default') {
    const led = Object.entries(all).filter(([, p]) => p.lead === login).map(([m]) => m)
    if (led.length) throw new Error(`@${login} still leads ${led.map(m => `@${m}`).join(', ')}; give them another lead first`)
    // null = out of the hierarchy on purpose (sees everything, kept even when a
    // default level exists); 'default' = no entry, so the default applies.
    if (next === null) raw[login] = { level: null }
    else delete raw[login]
  } else {
    const problem = placementProblem(login, next, all)
    if (problem) throw new Error(problem)
    raw[login] = { level: next.level, ...(next.lead ? { lead: next.lead } : {}) }
  }
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(hierarchyPath(), `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
  return listPlacements()
}

/**
 * Whose work a login may see: everyone (`all`), or themselves and their team.
 * Unplaced, or no login at all (auth disabled is one person), sees everyone.
 */
export type Scope = { all: true } | { all: false, logins: Set<string> }

export async function scopeFor(login: string | undefined): Promise<Scope> {
  if (!login) return { all: true }
  const placements = await listPlacements()
  if (placements[login]) return { all: false, logins: new Set([login, ...teamOf(login, placements)]) }
  // Not placed: the default level, for anyone not taken out on purpose and not
  // an operator. Nobody leads a defaulted person, so they see their own work.
  if (defaultLevel() !== null && !(await listUnplacedOnPurpose()).includes(login) && (await roleFor(login)) !== 'operator') {
    return { all: false, logins: new Set([login]) }
  }
  return { all: true }
}

/** Where a login stands, for the UI: placed, defaulted, or outside (sees everything). */
export async function effectivePlacement(login: string): Promise<{ level: Level, lead?: string, source: 'set' | 'default' } | null> {
  const p = (await listPlacements())[login]
  if (p) return { ...p, source: 'set' }
  const d = defaultLevel()
  if (d !== null && !(await listUnplacedOnPurpose()).includes(login) && (await roleFor(login)) !== 'operator') return { level: d, source: 'default' }
  return null
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
