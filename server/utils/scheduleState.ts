/**
 * What happened on each schedule's last fire, one file per schedule at
 * `resolveClaudePath('schedule-state/<id>.json')`.
 *
 * Separate from scheduleConfig.ts because the writers are different: the API
 * owns the config, the scheduler owns this. Folding the two together would put
 * a write on every fire into a file that is read-modify-write with no lock.
 *
 * Never throws, the same contract as watchStateStore.ts: a corrupt or missing
 * state file reads back empty. Losing the record of the last fire is a
 * cosmetic loss; refusing to fire again because of it is not.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveClaudePath } from './claudeDir.ts'
import { SCHEDULE_STATE_DIR_NAME, type ScheduleState } from '../../shared/types/schedule.ts'

const stateDir = () => resolveClaudePath(SCHEDULE_STATE_DIR_NAME)
const statePath = (id: string) => resolveClaudePath(SCHEDULE_STATE_DIR_NAME, `${id}.json`)

async function ensureDir() {
  const dir = stateDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

export async function getScheduleState(id: string): Promise<ScheduleState> {
  const path = statePath(id)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ScheduleState) : {}
  } catch {
    return {}
  }
}

/**
 * Records one fire's outcome. Swallows its own write errors for the reason in
 * the file docstring: a state file that cannot be written must not turn a
 * successful run into a thrown error inside a cron callback nobody is awaiting.
 */
export async function recordScheduleFire(id: string, state: ScheduleState): Promise<ScheduleState> {
  const next: ScheduleState = { ...state, lastFiredAt: state.lastFiredAt ?? Date.now() }
  try {
    await ensureDir()
    await writeFile(statePath(id), JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    // The run still happened; only the note about it is lost.
  }
  return next
}

/** Removes one schedule's state file. Returns whether there was one. */
export async function deleteScheduleState(id: string): Promise<boolean> {
  const path = statePath(id)
  if (!existsSync(path)) return false
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    return true
  } catch {
    return false
  }
}
