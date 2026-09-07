import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentRunsRoot } from './runArtifacts.ts'

/**
 * The instance's product checkouts and the two preconditions a run cannot do
 * without: a checkout to work in and a directory to write evidence to. Checked
 * by the runner before any agent spends a token discovering them, and shown to
 * the developer before Start.
 */
const execFileP = promisify(execFile)
const gitRaw = async (cwd: string, args: string[]) =>
  (await execFileP('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout
const git = async (cwd: string, args: string[]) => (await gitRaw(cwd, args)).trim()

export const workspaceRoot = () => process.env.AGENT_WORKSPACE_ROOT || join(homedir(), 'alepo-workspace')
/** Where a product repo is expected on this instance: <workspace>/<repo name>. */
export const checkoutDirFor = (repo: string) => join(workspaceRoot(), repo.split('/').pop() || repo)

export interface CheckoutState {
  path: string
  name: string
  exists: boolean
  git: boolean
  branch?: string
  head?: string
  remote?: string
  /** Uncommitted or untracked paths, counted with -uall so a new directory is not one entry. */
  dirty: number
  dirtyFiles: string[]
}

export async function checkoutState(path: string): Promise<CheckoutState> {
  const name = path.split('/').pop() || path
  if (!existsSync(path)) return { path, name, exists: false, git: false, dirty: 0, dirtyFiles: [] }
  if (!existsSync(join(path, '.git'))) return { path, name, exists: true, git: false, dirty: 0, dirtyFiles: [] }
  try {
    const [branch, head, status] = await Promise.all([
      git(path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'no commits yet'),
      git(path, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
      // Untrimmed: a leading space is the status column of the first line, not padding.
      gitRaw(path, ['status', '--porcelain', '-uall']),
    ])
    const remote = await git(path, ['remote', 'get-url', 'origin']).catch(() => undefined)
    const files = status.split('\n').filter(Boolean).map(l => l.slice(3))
    return { path, name, exists: true, git: true, branch, head, remote, dirty: files.length, dirtyFiles: files.slice(0, 20) }
  } catch {
    return { path, name, exists: true, git: true, dirty: 0, dirtyFiles: [] }
  }
}

export async function listCheckouts(): Promise<CheckoutState[]> {
  const root = workspaceRoot()
  if (!existsSync(root)) return []
  // Dot-directories are tooling state (.claude, editor caches), never a product checkout.
  const names = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort()
  return Promise.all(names.map(n => checkoutState(join(root, n))))
}

/** Parks uncommitted work under a named stash so a run starts from a clean tree. `git stash pop` brings it back. */
export async function stashCheckout(path: string, login: string): Promise<{ stashed: boolean, message: string }> {
  const s = await checkoutState(path)
  if (!s.git) throw new Error(`${path} is not a git checkout`)
  if (!s.dirty) return { stashed: false, message: 'already clean' }
  const message = `agent-manager: parked by ${login} ${new Date().toISOString()}`
  await git(path, ['stash', 'push', '--include-untracked', '-m', message])
  return { stashed: true, message }
}

/** A run works on its own branch off the checkout's current HEAD. Creating it is the runner's job, not an agent's. */
export async function ensureRunBranch(path: string, branch: string): Promise<void> {
  await git(path, ['checkout', '--quiet', '-B', branch])
}

/** Somewhere to write evidence: the one precondition every run has. */
export async function artifactsWritable(): Promise<{ ok: boolean, path: string, error?: string }> {
  const path = agentRunsRoot()
  try {
    await mkdir(path, { recursive: true })
    const probe = join(path, `.probe-${process.pid}-${Date.now()}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return { ok: true, path }
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : String(err) }
  }
}
