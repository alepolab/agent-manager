/**
 * Watch configuration store — what the scheduler is asked to poll.
 *
 * Persisted at `resolveClaudePath('watches.json')`, one file for every watch
 * (there is no per-watch state here — that is `watchStateStore.ts`, keyed by
 * ticket). A missing or corrupt file reads back as `[]`, the same
 * never-throw contract as `watchStateStore.ts` and `ticketSource.ts`: a
 * broken config file must degrade to "no watches configured", not crash the
 * scheduler or the API routes that will sit on top of this.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { getClaudeDir, resolveClaudePath } from './claudeDir.ts'
import type { Watch } from '../../shared/types/watch.ts'

export const WATCHES_FILE_NAME = 'watches.json'

const watchesPath = () => resolveClaudePath(WATCHES_FILE_NAME)

async function ensureDir() {
  const dir = getClaudeDir()
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
}

/** All configured watches, in whatever order they were saved. */
export async function listWatches(): Promise<Watch[]> {
  const path = watchesPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as Watch[]) : []
  } catch {
    // Malformed JSON, permission error, etc. — degrade to "no watches"
    // rather than throwing out of a caller that may be the scheduler boot.
    return []
  }
}

export async function getWatch(id: string): Promise<Watch | null> {
  const all = await listWatches()
  return all.find(w => w.id === id) ?? null
}

async function writeWatches(watches: Watch[]): Promise<void> {
  await ensureDir()
  await writeFile(watchesPath(), JSON.stringify(watches, null, 2), 'utf-8')
}

/**
 * Persists one watch (insert if its id is new, replace if it already
 * exists).
 *
 * A watch whose id does not already exist is forced to `enabled: false`
 * regardless of what the caller passed — a brand-new watch, however it was
 * created, must never dispatch on its first tick. A mistyped JQL that
 * matches thousands of tickets must cost nothing until an operator has seen
 * the watch behave and deliberately flips it on with a second save against
 * the same id. Updating an *existing* watch honors whatever `enabled` value
 * the caller passed — that second save is exactly how enabling happens.
 */
export async function saveWatch(watch: Watch): Promise<Watch> {
  const all = await listWatches()
  const index = all.findIndex(w => w.id === watch.id)
  const isNew = index === -1
  const toSave: Watch = isNew ? { ...watch, enabled: false } : watch

  if (isNew) all.push(toSave)
  else all[index] = toSave

  await writeWatches(all)
  return toSave
}
