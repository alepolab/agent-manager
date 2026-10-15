/**
 * Files a person uploads to start a run with: a workflow input of type `file`
 * (shared/utils/workflowParameters.ts) takes the path this returns.
 *
 * Agents run on this host and can only read what is on it, so a file on the
 * starter's own laptop has to arrive here first. It used to arrive by scp and
 * an installer run with sudo; the run dialog's upload replaces both.
 *
 * Each upload gets a folder of its own, named by when and a random id, and is
 * never overwritten: a run's parameters name the exact file it was given, and
 * a later upload of a newer register under the same name cannot change what
 * an earlier run read.
 *
 * Where it lands follows who will read it. With agents running as their
 * developer's own user, in that developer's private directory, whose default
 * ACL already shares it with them and the server and nobody else. Otherwise
 * beside the users directory, which only the server's user can open - and
 * agents run as that user.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { developerPaths, developersRoot, runAsUsers } from './osUsers.ts'
import { usersDir } from './users.ts'

export const UPLOAD_MAX_MB_VAR = 'UPLOAD_MAX_MB'

/** The largest upload accepted, in bytes: UPLOAD_MAX_MB, else 20 MB. */
export function maxUploadBytes(): number {
  const mb = Number(process.env[UPLOAD_MAX_MB_VAR])
  return (Number.isFinite(mb) && mb > 0 ? mb : 20) * 1024 * 1024
}

const safeLogin = (login: string) => login.replace(/[^A-Za-z0-9_.-]/g, '_')

/** Where the server keeps uploads when agents run as the server itself. */
const sharedUploadsBase = () => join(dirname(usersDir()), 'uploads')

/** The folder a login's uploads go in. */
export function uploadsRoot(login: string | undefined): string {
  if (runAsUsers() && login) return join(developerPaths(login).root, 'uploads')
  return join(sharedUploadsBase(), safeLogin(login || 'anonymous'))
}

/**
 * A file name safe to put on disk and in a prompt: no directories, no leading
 * dots, nothing a shell or a step header would misread. Spaces are kept - the
 * register is called "ase-crm Defect Register_12Oct.html" and should still be.
 */
export function safeFileName(name: string | undefined): string {
  const base = basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._ ()-]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
  return base || 'upload'
}

export interface SavedUpload { path: string, name: string, size: number }

/** Write one upload into a folder of its own; returns its path. */
export async function saveUpload(login: string | undefined, name: string | undefined, data: Uint8Array): Promise<SavedUpload> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  const dir = join(uploadsRoot(login), `${stamp}-${randomUUID().slice(0, 8)}`)
  await mkdir(dir, { recursive: true, mode: 0o770 })
  const file = safeFileName(name)
  const path = join(dir, file)
  await writeFile(path, data, { mode: 0o640, flag: 'wx' })
  return { path, name: file, size: data.byteLength }
}

/**
 * Whose upload a path is, or undefined when it is not an upload at all (a
 * typed path, a default). Read from where it sits, since that is what decides
 * who can open it.
 */
export function uploadOwnerOf(path: string): string | undefined {
  const abs = resolve(path)
  const bases = runAsUsers() ? [developersRoot()] : [sharedUploadsBase()]
  for (const base of bases) {
    if (!abs.startsWith(resolve(base) + sep)) continue
    const parts = abs.slice(resolve(base).length + 1).split(sep)
    if (runAsUsers()) return parts[1] === 'uploads' ? parts[0] : undefined
    return parts[0]
  }
  return undefined
}

/**
 * Why a file input's value cannot be used by this starter, or null. Only
 * uploads are checked: someone else's is refused, as their agents' file and
 * not this run's to read, and one of the starter's own that is gone is caught
 * here rather than by an agent that cannot find it. A typed path is the
 * starter's own business, as any text input is.
 */
export function uploadProblem(path: string, login: string | undefined): string | null {
  const owner = uploadOwnerOf(path)
  if (owner === undefined) return null
  if (owner !== safeLogin(login || 'anonymous')) return 'that file was uploaded by someone else'
  if (!existsSync(path)) return 'that uploaded file is no longer there; upload it again'
  return null
}
