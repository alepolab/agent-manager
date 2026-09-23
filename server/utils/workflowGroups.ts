/**
 * The concurrency group registry — which groups exist and what each one's cap
 * is.
 *
 * Persisted at `resolveClaudePath('workflow-groups.json')`, one file for every
 * group, and edited as a whole array rather than row by row: it is a short
 * table an operator fills in one modal, so per-id CRUD would buy nothing and
 * invent a "what happens to the runs" question on every delete.
 *
 * A missing or corrupt file reads back as `[]` — the same never-throw contract
 * as scheduleConfig.ts and watchConfig.ts, and it matters more here: this file
 * is consulted on the path that STARTS runs, so a broken config must degrade to
 * "everything uses the default cap", never to "nothing can start".
 *
 * Which workflow is in which group is not here. That lives on the workflow
 * definition (`Workflow.group`), so a workflow carries its own membership and
 * this file never has to be kept in step with a renamed or deleted workflow.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { DEFAULT_GROUP_ID, WORKFLOW_GROUPS_FILE_NAME, type WorkflowGroup } from '../../shared/types/workflowGroup.ts'

const groupsPath = () => resolveClaudePath(WORKFLOW_GROUPS_FILE_NAME)

async function ensureDir() {
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** Every configured group, in the order it was saved. */
export async function listGroups(): Promise<WorkflowGroup[]> {
  const path = groupsPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as WorkflowGroup[]) : []
  } catch {
    // Malformed JSON, permission error: degrade to "no groups configured", so
    // every workflow falls back to the default cap and runs still start.
    return []
  }
}

/**
 * The one thing a group id has to answer: how many at once.
 *
 * Falls back to AGENT_MAX_CONCURRENT_PIPELINES for a group with no entry -
 * which covers both the implicit default group and an id a workflow names that
 * has since been deleted from the registry. Falling back rather than treating
 * an unknown id as unlimited is deliberate: a typo in a group name must not
 * quietly remove the cap.
 */
export async function capFor(groupId?: string): Promise<number> {
  const id = groupId?.trim() || DEFAULT_GROUP_ID
  const found = (await listGroups()).find(g => g.id === id)
  return found ? found.maxConcurrent : defaultMaxConcurrent()
}

/** The cap for anything the registry does not name. Two is what the dispatcher
 *  agent this whole mechanism replaces claimed to enforce, and a sane default
 *  for one machine. */
export function defaultMaxConcurrent(): number {
  const configured = Number(process.env.AGENT_MAX_CONCURRENT_PIPELINES)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 2
}

/** Refused reasons for one group row, or null when it is fine to save. */
export function validateGroup(group: Partial<WorkflowGroup>): string | null {
  if (!group.id?.trim()) return 'a group needs an id'
  if (!group.name?.trim()) return `group "${group.id}" needs a name`
  // Integer, and at least one. See WorkflowGroup.maxConcurrent for why 0 is
  // refused rather than accepted as "paused".
  if (!Number.isInteger(group.maxConcurrent) || (group.maxConcurrent as number) < 1) {
    return `group "${group.id}" needs a whole number of concurrent runs, at least 1`
  }
  return null
}

/**
 * Replaces the whole registry.
 *
 * Whole-array rather than per-row because that is how the editor works: the
 * operator sees every group at once and saves once. Validating every row before
 * writing any of them means a table with one bad cap is refused intact, rather
 * than half-written.
 */
export async function replaceGroups(groups: WorkflowGroup[]): Promise<WorkflowGroup[]> {
  const seen = new Set<string>()
  for (const g of groups) {
    const invalid = validateGroup(g)
    if (invalid) throw new Error(invalid)
    if (seen.has(g.id)) throw new Error(`group "${g.id}" is listed twice`)
    seen.add(g.id)
  }
  const clean = groups.map(g => ({ id: g.id.trim(), name: g.name.trim(), maxConcurrent: g.maxConcurrent }))
  await ensureDir()
  await writeFile(groupsPath(), JSON.stringify(clean, null, 2), 'utf-8')
  return clean
}
