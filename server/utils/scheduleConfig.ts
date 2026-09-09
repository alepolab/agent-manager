/**
 * Schedule configuration store — which workflows fire on a cron expression.
 *
 * Persisted at `resolveClaudePath('schedules.json')`, one file for every
 * schedule. Per-fire outcomes are NOT here: they live in `scheduleState.ts`,
 * keyed by schedule id, because this file is read-modify-write with no lock
 * (the same gap server/utils/teamSync.ts flags for watches.json) and a write
 * on every fire would race the API's.
 *
 * A missing or corrupt file reads back as `[]` — the same never-throw contract
 * as watchConfig.ts: a broken config must degrade to "nothing scheduled", not
 * crash the scheduler at boot or the routes sitting on top of it.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import { SCHEDULES_FILE_NAME, type Schedule } from '../../shared/types/schedule.ts'

const schedulesPath = () => resolveClaudePath(SCHEDULES_FILE_NAME)

async function ensureDir() {
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** Every configured schedule, in whatever order it was saved. */
export async function listSchedules(): Promise<Schedule[]> {
  const path = schedulesPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as Schedule[]) : []
  } catch {
    // Malformed JSON, permission error: degrade to "nothing scheduled" rather
    // than throwing out of a caller that may be the scheduler's boot.
    return []
  }
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const all = await listSchedules()
  return all.find(s => s.id === id) ?? null
}

async function writeSchedules(schedules: Schedule[]): Promise<void> {
  await ensureDir()
  await writeFile(schedulesPath(), JSON.stringify(schedules, null, 2), 'utf-8')
}

/**
 * Persists one schedule (insert if its id is new, replace if it exists).
 *
 * A schedule whose id does not already exist is forced to `enabled: false`
 * whatever the caller passed — the same invariant saveWatch enforces, for the
 * same reason. `0 * * * *` and `* * * * *` differ by one character and by a
 * factor of sixty in what they cost, so a brand-new schedule never fires until
 * someone has read back what it will do and enabled it with a second save
 * against the same id. Updating an existing schedule honours whatever
 * `enabled` it is given — that second save is exactly how enabling happens.
 */
export async function saveSchedule(schedule: Schedule): Promise<Schedule> {
  const all = await listSchedules()
  const index = all.findIndex(s => s.id === schedule.id)
  const isNew = index === -1
  const toSave: Schedule = isNew ? { ...schedule, enabled: false } : schedule

  if (isNew) all.push(toSave)
  else all[index] = toSave

  await writeSchedules(all)
  return toSave
}

/**
 * Removes one schedule. Returns whether it existed.
 *
 * Deliberately does not touch that schedule's state file — config and state
 * are separate stores here on purpose, and `DELETE /api/schedules/[id]` is
 * where the decision to remove both is made and carried out.
 */
export async function deleteSchedule(id: string): Promise<boolean> {
  const all = await listSchedules()
  const index = all.findIndex(s => s.id === id)
  if (index === -1) return false
  all.splice(index, 1)
  await writeSchedules(all)
  return true
}
