import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { encrypt, decrypt } from './users.ts'
import { createLogger } from './log.ts'

/**
 * Remote machines a run's agents can execute on.
 *
 * An agent call is a Claude Code process reading and writing a checkout. By
 * default that process runs beside this server, on whatever this container
 * has: its CPU, its memory, its docker socket, its JDK. A machine registered
 * here is somewhere else that process can run instead — a build box with the
 * toolchain a product needs, a host with the GPU, a developer's own workstation
 * — reached over ssh, with the checkout and the run's evidence directory
 * carried over before the step and back after it (see remoteAgent.ts).
 *
 * The registry is one file under ~/.agent-manager, beside the profiles and the
 * channels, for the reason both of those give: nothing in the Claude config
 * tree holds a secret, and a pasted private key is one. The key is sealed with
 * the same AES-256-GCM-under-AGENT_MANAGER_SECRET as a Jira token, and leaves
 * the server only as a 0600 file ssh reads.
 *
 * What is deliberately NOT here: a machine's own credentials for the model and
 * for GitHub. The run's identity (envForUser, AGENT_GH_TOKEN, ANTHROPIC_*)
 * travels with each call as environment, exactly as it does for a local one,
 * so a machine is a place to run and never a second identity to keep in step.
 */

const log = createLogger('machines')
const execFileP = promisify(execFile)

/** Where a run's agents execute: on this server, or on one of the machines registered here. */
export type MachineTransport = 'sync' | 'shared'

export interface Machine {
  id: string
  name: string
  host: string
  /** ssh port; absent means 22. */
  port?: number
  /** ssh login; absent means whatever the server's ssh config says for the host. */
  user?: string
  /** Sealed private key (`v1:iv:tag:data`, see users.ts). Never returned to the browser. */
  privateKey?: string
  /** A key file on THIS server, used when no key was pasted. Absent with no pasted key: ssh's own agent and default keys. */
  keyPath?: string
  /** The `claude` executable on the machine. Absent means `claude` on the PATH of a login shell. */
  claudePath?: string
  /**
   * Where checkouts live on the machine. The run's local checkout path is
   * re-rooted from this server's AGENT_WORKSPACE_ROOT to this; absent means the
   * same absolute path on both sides, which is right for a shared mount or two
   * hosts with the same user and layout.
   */
  workspaceRoot?: string
  /** Where run evidence lives on the machine; absent means the same path as here. Re-roots AGENT_RUNS_DIR. */
  runsRoot?: string
  /** An agent-manager checkout on the machine, for the scripts and vendored skills agents are handed by absolute path. Absent: the same path as here. */
  appRoot?: string
  /** The Claude config directory on the machine, for the seeded skills. Absent: the same path as here. */
  claudeDir?: string
  /**
   * `sync`: the checkout is pushed to the machine before each step and pulled
   * back after it (git for history, rsync for the working tree and evidence).
   * `shared`: both sides see one filesystem, so nothing is copied.
   */
  transport: MachineTransport
  /** Extra environment for every agent on this machine. Stored in clear: a path, a flag, never a secret. */
  env?: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  updatedBy?: string
  lastCheck?: MachineCheck
}

/** What the last connection test found. */
export interface MachineCheck {
  at: number
  ok: boolean
  detail: string
  claudeVersion?: string
  gitVersion?: string
  rsync?: boolean
  workspaceWritable?: boolean
}

export type PublicMachine = Omit<Machine, 'privateKey'> & { hasPrivateKey: boolean }

/** The id a run, a workflow or the instance uses to say "run here, on this server, whatever is set above me". */
export const LOCAL_MACHINE = 'local'

interface MachineStore {
  machines: Machine[]
  /** Every run not saying otherwise runs here. Absent: on this server. */
  defaultMachineId?: string
}

export const machinesFile = () => process.env.AGENT_MACHINES_FILE || join(homedir(), '.agent-manager', 'machines.json')
/** Key files ssh reads, one per machine, 0600 in a 0700 directory beside the store. */
const keysDir = () => join(dirname(machinesFile()), 'machine-keys')

async function readStore(): Promise<MachineStore> {
  const p = machinesFile()
  if (!existsSync(p)) return { machines: [] }
  try {
    const raw = JSON.parse(await readFile(p, 'utf8'))
    return { machines: Array.isArray(raw?.machines) ? raw.machines : [], defaultMachineId: typeof raw?.defaultMachineId === 'string' ? raw.defaultMachineId : undefined }
  } catch (err) {
    log.warn('machines file unreadable; treating as empty', { path: p, error: err instanceof Error ? err.message : String(err) })
    return { machines: [] }
  }
}

async function writeStore(store: MachineStore): Promise<void> {
  const p = machinesFile()
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  await rename(tmp, p)
}

export async function listMachines(): Promise<Machine[]> {
  return (await readStore()).machines
}

export async function getMachine(id: string): Promise<Machine | null> {
  return (await readStore()).machines.find(m => m.id === id) ?? null
}

export async function defaultMachineId(): Promise<string | undefined> {
  const store = await readStore()
  const id = store.defaultMachineId
  return id && store.machines.some(m => m.id === id) ? id : undefined
}

export async function setDefaultMachine(id: string | null): Promise<void> {
  const store = await readStore()
  if (id && !store.machines.some(m => m.id === id)) throw new Error(`No machine with id ${id}`)
  store.defaultMachineId = id ?? undefined
  await writeStore(store)
}

export function toPublicMachine(m: Machine): PublicMachine {
  const { privateKey, ...rest } = m
  return { ...rest, hasPrivateKey: !!privateKey }
}

// ── validation ──────────────────────────────────────────────────────────────
// Every value here ends up on an ssh or rsync command line. The one injection
// worth refusing outright is a value starting with '-', which ssh would read
// as an option; the rest is quoted (see shellQuote) and only has to be sane.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^[0-9a-fA-F:]+$/
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateMachineName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    throw new Error('A machine name must start with a letter or digit and use only letters, digits, spaces, dots, hyphens and underscores (60 characters max)')
  }
  return name.trim()
}

export function validateHost(host: unknown): string {
  const h = typeof host === 'string' ? host.trim() : ''
  if (!h || !HOST_RE.test(h)) throw new Error('Host must be a hostname or an IP address')
  return h
}

export function validatePort(port: unknown): number | undefined {
  if (port === undefined || port === null || port === '') return undefined
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port must be a whole number between 1 and 65535')
  return n === 22 ? undefined : n
}

export function validateUser(user: unknown): string | undefined {
  const u = typeof user === 'string' ? user.trim() : ''
  if (!u) return undefined
  if (!USER_RE.test(u)) throw new Error('The ssh user may use only letters, digits, dots, hyphens and underscores')
  return u
}

/** A path on the machine: absolute, or under its home as `~/…`. Empty means "same as here". */
export function validateRemotePath(value: unknown, label: string): string | undefined {
  const p = typeof value === 'string' ? value.trim() : ''
  if (!p) return undefined
  if (!(p.startsWith('/') || p === '~' || p.startsWith('~/'))) throw new Error(`${label} must be an absolute path on the machine, or start with ~/`)
  if (/[\n\r\0]/.test(p)) throw new Error(`${label} contains a control character`)
  return p.replace(/\/+$/, '') || '/'
}

/** The `claude` executable: a bare command name on the PATH, or a path. */
export function validateClaudePath(value: unknown): string | undefined {
  const p = typeof value === 'string' ? value.trim() : ''
  if (!p) return undefined
  if (p.startsWith('-') || /[\n\r\0\s]/.test(p)) throw new Error('The claude path must be a single command name or path')
  return p
}

export function validateTransport(value: unknown): MachineTransport {
  if (value === undefined || value === null || value === '') return 'sync'
  if (value !== 'sync' && value !== 'shared') throw new Error('Transport must be "sync" or "shared"')
  return value
}

export function validateEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('env must be an object of NAME: value')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`"${k}" is not an environment variable name`)
    if (typeof v !== 'string') throw new Error(`env.${k} must be a string`)
    if (/[\n\r\0]/.test(v)) throw new Error(`env.${k} contains a control character`)
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** Pasted key material: an OpenSSH or PEM private key block, nothing else. */
export function validatePrivateKey(value: unknown): string {
  const k = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(k)) {
    throw new Error('That is not a private key: paste the whole block, from -----BEGIN to -----END')
  }
  return `${k}\n`
}

export interface MachineInput {
  id?: string
  name: unknown
  host: unknown
  port?: unknown
  user?: unknown
  /** Plain text, sealed here once. '' clears a stored key; absent keeps it. */
  privateKeyPlain?: unknown
  keyPath?: unknown
  claudePath?: unknown
  workspaceRoot?: unknown
  runsRoot?: unknown
  appRoot?: unknown
  claudeDir?: unknown
  transport?: unknown
  env?: unknown
  enabled?: unknown
}

/** Creates or replaces one machine. Validation throws a plain Error the route turns into a 400. */
export async function saveMachine(input: MachineInput, by?: string): Promise<Machine> {
  const store = await readStore()
  const existing = input.id ? store.machines.find(m => m.id === input.id) : undefined
  if (input.id && !existing) throw new Error(`No machine with id ${input.id}`)
  const name = validateMachineName(input.name)
  const clash = store.machines.find(m => m.id !== existing?.id && m.name.toLowerCase() === name.toLowerCase())
  if (clash) throw new Error(`A machine called "${clash.name}" already exists`)
  const keyPath = validateRemotePathOnServer(input.keyPath)
  const next: Machine = {
    id: existing?.id ?? randomUUID(),
    name,
    host: validateHost(input.host),
    port: validatePort(input.port),
    user: validateUser(input.user),
    privateKey: existing?.privateKey,
    keyPath,
    claudePath: validateClaudePath(input.claudePath),
    workspaceRoot: validateRemotePath(input.workspaceRoot, 'Workspace root'),
    runsRoot: validateRemotePath(input.runsRoot, 'Evidence root'),
    appRoot: validateRemotePath(input.appRoot, 'Agent Manager checkout'),
    claudeDir: validateRemotePath(input.claudeDir, 'Claude config directory'),
    transport: validateTransport(input.transport),
    env: validateEnv(input.env),
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    updatedBy: by,
    // A changed connection invalidates what the last check proved.
    lastCheck: existing && existing.host === input.host && existing.port === validatePort(input.port) && existing.user === validateUser(input.user) ? existing.lastCheck : undefined,
  }
  if (input.privateKeyPlain !== undefined) {
    const plain = typeof input.privateKeyPlain === 'string' ? input.privateKeyPlain : ''
    next.privateKey = plain.trim() ? encrypt(validatePrivateKey(plain)) : undefined
    next.lastCheck = undefined
    // A rotated or cleared key must not leave the old file for ssh to find.
    await rm(join(keysDir(), `${next.id}.key`), { force: true })
  }
  for (const k of Object.keys(next) as (keyof Machine)[]) if (next[k] === undefined) delete next[k]
  store.machines = existing ? store.machines.map(m => (m.id === next.id ? next : m)) : [...store.machines, next]
  await writeStore(store)
  return next
}

/** A key file on this server, where the pasted key is not used. Absolute only: ssh runs from an unknown cwd. */
function validateRemotePathOnServer(value: unknown): string | undefined {
  const p = typeof value === 'string' ? value.trim() : ''
  if (!p) return undefined
  if (!p.startsWith('/') && !p.startsWith('~/')) throw new Error('Key path must be an absolute path on this server')
  if (/[\n\r\0]/.test(p)) throw new Error('Key path contains a control character')
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export async function deleteMachine(id: string): Promise<boolean> {
  const store = await readStore()
  const before = store.machines.length
  store.machines = store.machines.filter(m => m.id !== id)
  if (store.machines.length === before) return false
  if (store.defaultMachineId === id) delete store.defaultMachineId
  await writeStore(store)
  await rm(join(keysDir(), `${id}.key`), { force: true })
  return true
}

export async function recordCheck(id: string, check: MachineCheck): Promise<void> {
  const store = await readStore()
  const m = store.machines.find(x => x.id === id)
  if (!m) return
  m.lastCheck = check
  await writeStore(store)
}

// ── which machine a run uses ────────────────────────────────────────────────

/**
 * The machine a run executes on, by precedence: what the start asked for, then
 * what the workflow says, then the instance default. `LOCAL_MACHINE` at any
 * level stops the cascade — "here, whatever is set above me" — and is the
 * answer when nothing says anything. Pure, so the precedence is testable
 * without a store.
 */
export function resolveMachineId(opts: { requested?: string, workflow?: string, instanceDefault?: string }): string {
  for (const id of [opts.requested, opts.workflow, opts.instanceDefault]) {
    const v = id?.trim()
    if (v) return v
  }
  return LOCAL_MACHINE
}

/**
 * The machine a run will execute on, or null for this server. Throws when the
 * resolved id names nothing, or a machine switched off: a run that cannot
 * start is better than one that silently runs somewhere other than where it
 * was told to.
 */
export async function machineForRun(opts: { requested?: string, workflow?: string }): Promise<Machine | null> {
  const id = resolveMachineId({ ...opts, instanceDefault: await defaultMachineId() })
  if (id === LOCAL_MACHINE) return null
  const m = await getMachine(id)
  if (!m) throw new Error(`This run was to execute on machine ${id}, which is not configured. Pick another in Settings → Machines, or on the workflow.`)
  if (!m.enabled) throw new Error(`Machine "${m.name}" is switched off. Enable it in Settings → Machines, or pick another.`)
  return m
}

// ── ssh plumbing ────────────────────────────────────────────────────────────

/** POSIX single-quoting: safe for any byte but NUL. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * A machine path as a shell word. `~/x` becomes `"$HOME"/'x'` so the machine's
 * own home applies: a quoted tilde does not expand, and this server does not
 * know the remote home directory.
 */
export function shellPath(p: string): string {
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"/${shellQuote(p.slice(2))}`
  return shellQuote(p)
}

/** `user@host` or `host`, as ssh and rsync take it. */
export function sshTarget(m: Pick<Machine, 'host' | 'user'>): string {
  return m.user ? `${m.user}@${m.host}` : m.host
}

/**
 * The options every ssh to this machine carries. Batch mode so a missing key
 * fails in a second rather than hanging on a password prompt nobody can
 * answer; accept-new so the first connection to a new host works and a CHANGED
 * key still refuses.
 */
export function sshOptionArgs(m: Pick<Machine, 'port'>, keyFile?: string): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    // Banners and "permanently added" notices would otherwise land on the
    // CLI's stderr, which the SDK surfaces as if Claude Code had said it.
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=6',
    ...(m.port ? ['-p', String(m.port)] : []),
    ...(keyFile ? ['-i', keyFile, '-o', 'IdentitiesOnly=yes'] : []),
  ]
}

/**
 * The key file ssh reads for this machine: the pasted key, written 0600 on
 * demand (and rewritten each time, so a rotated key takes effect at once), or
 * the server-side path the machine names, or nothing — ssh's own agent and
 * default keys then apply.
 */
export async function keyFileFor(m: Machine): Promise<string | undefined> {
  if (m.privateKey) {
    const dir = keysDir()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const p = join(dir, `${m.id}.key`)
    await writeFile(p, decrypt(m.privateKey), { mode: 0o600 })
    return p
  }
  return m.keyPath
}

/** The command ssh runs on the machine: `cmd` under a login shell, so PATH holds what the user installed. */
export function loginShellCommand(cmd: string): string {
  return `bash -lc ${shellQuote(cmd)}`
}

export interface SshRunner {
  (args: string[], opts?: { timeoutMs?: number, input?: string }): Promise<{ stdout: string, stderr: string }>
}

const defaultSsh: SshRunner = async (args, opts = {}) => {
  const r = await execFileP('ssh', args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, env: process.env })
  return { stdout: r.stdout, stderr: r.stderr }
}

/** Runs one shell command on the machine and returns its output; throws with ssh's stderr on failure. */
export async function sshExec(m: Machine, cmd: string, opts: { timeoutMs?: number, ssh?: SshRunner } = {}): Promise<string> {
  const keyFile = await keyFileFor(m)
  const run = opts.ssh ?? defaultSsh
  try {
    const { stdout } = await run([...sshOptionArgs(m, keyFile), sshTarget(m), '--', loginShellCommand(cmd)], { timeoutMs: opts.timeoutMs })
    return stdout
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
    throw new Error(stderr ? `ssh ${sshTarget(m)}: ${stderr.split('\n').slice(-3).join(' | ')}` : `ssh ${sshTarget(m)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The probe the connection test runs: one round trip answering every question the Settings page asks. */
export function checkCommand(m: Pick<Machine, 'claudePath' | 'workspaceRoot'>): string {
  const claude = shellQuote(m.claudePath || 'claude')
  const ws = m.workspaceRoot ? shellPath(m.workspaceRoot) : '"$HOME"'
  return [
    'echo MACHINE=ok',
    `if command -v ${claude} >/dev/null 2>&1; then printf 'CLAUDE=%s\\n' "$(${claude} --version 2>/dev/null | head -n 1)"; else echo CLAUDE=missing; fi`,
    `if command -v git >/dev/null 2>&1; then printf 'GIT=%s\\n' "$(git --version 2>/dev/null | head -n 1)"; else echo GIT=missing; fi`,
    `if command -v rsync >/dev/null 2>&1; then echo RSYNC=ok; else echo RSYNC=missing; fi`,
    `if mkdir -p ${ws} 2>/dev/null && test -w ${ws}; then echo WS=ok; else echo WS=unwritable; fi`,
  ].join('; ')
}

/** Reads the probe's output into a verdict. Exported so the parse is tested without a host. */
export function parseCheckOutput(out: string, m: Pick<Machine, 'transport' | 'workspaceRoot'>): MachineCheck {
  const kv = new Map<string, string>()
  for (const line of out.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  if (kv.get('MACHINE') !== 'ok') return { at: Date.now(), ok: false, detail: 'ssh connected but the probe did not run; is bash available for the login user?' }
  const claude = kv.get('CLAUDE') ?? 'missing'
  const git = kv.get('GIT') ?? 'missing'
  const rsync = kv.get('RSYNC') === 'ok'
  const ws = kv.get('WS') === 'ok'
  const problems: string[] = []
  if (claude === 'missing' || !claude) problems.push('claude is not on the PATH of a login shell (set the claude path, or install Claude Code there)')
  if (git === 'missing') problems.push('git is not installed')
  if (m.transport === 'sync' && !rsync) problems.push('rsync is not installed, and the sync transport needs it')
  if (!ws) problems.push(`the workspace root ${m.workspaceRoot ?? '(home)'} cannot be created or is not writable`)
  return {
    at: Date.now(),
    ok: !problems.length,
    detail: problems.length ? problems.join('; ') : `${claude}; ${git}${rsync ? '; rsync present' : ''}`,
    claudeVersion: claude === 'missing' ? undefined : claude,
    gitVersion: git === 'missing' ? undefined : git,
    rsync,
    workspaceWritable: ws,
  }
}

/** Connects, probes, records the verdict on the machine, and returns it. Never throws: an unreachable host is a verdict. */
export async function checkMachine(m: Machine, opts: { ssh?: SshRunner } = {}): Promise<MachineCheck> {
  let check: MachineCheck
  try {
    check = parseCheckOutput(await sshExec(m, checkCommand(m), { timeoutMs: 45_000, ssh: opts.ssh }), m)
  } catch (err) {
    check = { at: Date.now(), ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
  await recordCheck(m.id, check).catch(() => {})
  log.info('machine checked', { machine: m.name, ok: check.ok, detail: check.detail })
  return check
}
