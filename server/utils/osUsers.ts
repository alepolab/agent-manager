/**
 * Each developer's agents run as that developer's own Unix user.
 *
 * Withholding secrets from an agent's environment (agentBaseEnv) keeps them out
 * of what it is handed and prints. It does not stop one that goes looking: an
 * agent running as the server's user can read whatever the server can - the
 * key in ~/.agent-manager/secret every stored token is sealed under, the app's
 * .env, and every other developer's workspace and credentials. Only a
 * different user, and ordinary file permissions, wall those off.
 *
 * So with AGENT_RUN_AS=user every Claude Code process an agent or a chat
 * starts is spawned through sudo as `am-<login>`, by a root-owned launcher
 * that the one sudoers rule names (scripts/install-run-as.sh). Each developer
 * has a private directory, owned by their user and shared with the server
 * through their group, holding their home, Claude config and transcripts,
 * and the credential files their tools read. Nobody else's agents can open it.
 *
 * Off by default, so a single-person host and the test suite behave exactly
 * as they did. On, there is no fallback: a developer whose user has not been
 * provisioned is refused, not quietly run as the server.
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const execFileP = promisify(execFile)

export const RUN_AS_VAR = 'AGENT_RUN_AS'

/** Where the sudoers rule lets the server start processes as a developer. */
export const DEFAULT_LAUNCHER = '/usr/local/libexec/agent-manager/launch'

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_')

/** True when agents run as their developer's own Unix user. */
export function runAsUsers(): boolean {
  return process.env[RUN_AS_VAR] === 'user'
}

export function launcherPath(): string {
  return process.env.AGENT_RUN_AS_LAUNCHER || DEFAULT_LAUNCHER
}

/**
 * The Unix user a login's agents run as. Lower-cased and cut to 32 characters,
 * the most `useradd` accepts; a GitHub login is at most 39, so two logins that
 * differ only past the cut would collide - provisioning refuses the second.
 */
export function osUserFor(login: string): string {
  const prefix = process.env.AGENT_OS_USER_PREFIX ?? 'am-'
  return `${prefix}${safe(login).toLowerCase().replace(/^[^a-z_]+/, '')}`.slice(0, 32)
}

export function developersRoot(): string {
  return process.env.AGENT_DEVELOPERS_ROOT || '/srv/agent-manager/developers'
}

/** One developer's private directory, and what lives in it. */
export function developerPaths(login: string) {
  const root = join(developersRoot(), safe(login))
  const home = join(root, 'home')
  return {
    root,
    home,
    /** CLAUDE_CONFIG_DIR: their settings and, above all, their transcripts. */
    claudeConfig: join(home, '.claude'),
    /** Their transcripts, for the chat sidebar and session resume. */
    projects: join(home, '.claude', 'projects'),
    /** docker and jira-cli config written from their stored tokens. */
    credentials: join(root, 'credentials'),
  }
}

/**
 * Why this login's agents cannot be started as their own user, or null.
 * Checked before every launch and in preflight. Asks the system, not a list:
 * a user removed by hand must not still look provisioned.
 */
export function osUserProblem(login: string | undefined): string | null {
  if (!runAsUsers()) return null
  if (!login) return 'Agents run as their developer\'s own user on this instance, and this was started by nobody. Give the watch or schedule an owner.'
  const user = osUserFor(login)
  const fix = `An operator must run: sudo scripts/provision-developer.sh ${login}`
  try {
    execFileSync('id', ['-u', user], { stdio: 'ignore' })
  } catch {
    return `@${login} has no Unix user (${user}) on this host, so their agents cannot start. ${fix}`
  }
  const { root } = developerPaths(login)
  if (!existsSync(root)) return `@${login}'s directory ${root} does not exist. ${fix}`
  if (!existsSync(launcherPath())) return `The launcher ${launcherPath()} is not installed. An operator must run: sudo scripts/install-run-as.sh`
  return null
}

/** Directories transcripts may be in: the server's own, then every developer's. */
export function developerProjectsDirs(): string[] {
  if (!runAsUsers()) return []
  const root = developersRoot()
  try {
    return readdirSync(root)
      .map(d => join(root, d, 'home', '.claude', 'projects'))
      .filter(d => { try { return statSync(d).isDirectory() } catch { return false } })
  } catch { return [] }
}

/**
 * The env a developer's Claude Code process gets on top of agentEnvFor's: their
 * own home and Claude config dir, and the PATH carried through sudo, which
 * would otherwise replace it with secure_path and lose nvm's node.
 */
export function runAsEnv(login: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const p = developerPaths(login)
  return {
    ...env,
    HOME: p.home,
    CLAUDE_CONFIG_DIR: p.claudeConfig,
    USER: osUserFor(login),
    LOGNAME: osUserFor(login),
    AM_PATH: env.PATH,
    AM_HOME: p.home,
  }
}

/** The command line sudo is given. Env never goes here: `ps` shows argv to everyone. */
export function runAsArgv(login: string, command: string, args: string[]): string[] {
  return ['-n', '-E', '-u', osUserFor(login), '--', launcherPath(), command, ...args]
}

/**
 * The SDK's `spawnClaudeCodeProcess` for a developer, or undefined when agents
 * run as the server. sudo -E carries the environment, which the sudoers rule
 * permits with SETENV for this launcher alone; the launcher restores PATH and
 * HOME and sets the umask that keeps their files shared with the server's
 * group and nobody else.
 */
export function spawnAs(login: string | undefined) {
  if (!runAsUsers() || !login) return undefined
  return (options: { command: string, args: string[], cwd?: string, env: Record<string, string | undefined>, signal?: AbortSignal }) => {
    const env = runAsEnv(login, options.env) as NodeJS.ProcessEnv
    const child = spawn('sudo', runAsArgv(login, options.command, options.args), {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    // Claude Code writes transcripts 0600, and in a directory with a default
    // ACL that sets the mask to nothing: the server, which lists them in the
    // chat sidebar and reads them to resume, is locked out of its own
    // developer's sessions. Only the owner can reopen the mask, so it is done
    // as them - while the session runs, and once more when it ends.
    //
    // Polled, not an 'exit' listener: the SDK calls removeAllListeners() on
    // the process it is handed, and a listener added here silently vanished.
    let ticks = 0
    const timer = setInterval(() => {
      const ended = child.exitCode !== null || child.signalCode !== null
      if (ended || ++ticks % 15 === 0) reopenTranscripts(login, env)
      if (ended) clearInterval(timer)
    }, 1_000)
    timer.unref?.()
    return child
  }
}

/** The mask on a developer's transcripts, reopened by their own user. Never throws. */
export function reopenTranscripts(login: string, env: NodeJS.ProcessEnv = process.env): void {
  const { projects } = developerPaths(login)
  const fix = spawn('sudo', runAsArgv(login, 'setfacl', ['-R', '-m', 'm::rwX', projects]), { env: { PATH: env.PATH, AM_PATH: env.PATH }, stdio: 'ignore' })
  fix.on('error', () => { /* best effort: the next run reopens it */ })
}

/**
 * Lets a developer's user into one directory the server created for them - a
 * run's artifacts - and everything later made inside it, and nobody else.
 * The parent gets traverse only, so the grant reaches this directory and
 * lists nothing beside it. A no-op when agents run as the server.
 */
export async function grantDeveloper(dir: string, login: string | undefined): Promise<void> {
  if (!runAsUsers() || !login) return
  const user = osUserFor(login)
  // Adding the developer is not enough: the directories were created with the
  // server's umask, readable by every other user, and an ACL entry added
  // beside `other::r-x` leaves it there. So other is removed outright - on the
  // run's directory, everything already in it, and its default for what comes.
  await execFileP('setfacl', ['-m', `u:${user}:x,o::---`, dirname(dir)])
  await execFileP('setfacl', ['-R', '-m', `u:${user}:rwX,m::rwx,o::---`, dir])
  // The server named too: `u::` is whoever creates a file, and for what the
  // agent writes that is the developer's user. Without its own entry the
  // server could not open the shots/ folder or the triage.json its own agent
  // had just written, and reported the file as never written.
  await execFileP('setfacl', ['-R', '-d', '-m', `u::rwx,u:${userInfo().username}:rwx,u:${user}:rwx,g::---,m::rwx,o::---`, dir])
}

/**
 * Lets the server back into what a developer's agent wrote under `dir`, run as
 * that developer, since only a file's owner may change its ACL. Covers what the
 * default ACL cannot: a directory granted before the server was named in it,
 * and a file created with a narrow mode (0600 from `cp` out of /tmp, a 0700
 * mkdir) whose mask shuts out every named user. Never throws; resolves when done.
 */
export function reopenForServer(dir: string, login: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!runAsUsers() || !login) return Promise.resolve()
  return new Promise((resolve) => {
    // Exits non-zero for the server's own files, which the developer cannot
    // change and the server can already read; the rest are still set.
    const fix = spawn('sudo', runAsArgv(login, 'setfacl', ['-R', '-m', `u:${userInfo().username}:rwX,m::rwX`, dir]), { env: { PATH: env.PATH, AM_PATH: env.PATH }, stdio: 'ignore' })
    const timer = setTimeout(() => { fix.kill(); resolve() }, 30_000)
    timer.unref?.()
    fix.on('error', () => { clearTimeout(timer); resolve() })
    fix.on('close', () => { clearTimeout(timer); resolve() })
  })
}

/**
 * git refuses a repository owned by another user ("dubious ownership"), and
 * with agents running as developers the server and an agent each own some of
 * the same checkouts. Both sides trust them: the server here, at boot, and an
 * agent through agentEnvFor. Only in this mode - elsewhere one user owns all.
 */
export const SAFE_DIRECTORY_CONFIG = { key: 'safe.directory', value: '*' } as const

/**
 * The first of these directories the developer's user cannot use, with what it
 * cannot do, or null. Asked as that user, through the same launcher an agent
 * starts through, because nothing else answers for their permissions.
 *
 * An agent whose working directory its user cannot enter fails every shell
 * command with exit 1 and no output - `whoami` included - and one that cannot
 * reach its run's artifacts cannot write its report. A real run spent two steps
 * and $0.55 on that before anything said why; preflight asks this instead.
 */
export function unreachableFor(login: string, dirs: { enter?: string[], write?: string[] }): string | null {
  const checks = [
    ...(dirs.enter ?? []).map(d => ({ d, test: '-x', what: 'enter' })),
    ...(dirs.write ?? []).map(d => ({ d, test: '-w', what: 'write to' })),
  ]
  for (const { d, test, what } of checks) {
    const r = spawnSync('sudo', runAsArgv(login, 'test', [test, d]), { env: { PATH: process.env.PATH, AM_PATH: process.env.PATH }, stdio: 'ignore', timeout: 10_000 })
    if (r.status !== 0) return `${osUserFor(login)} cannot ${what} ${d}`
  }
  return null
}

/**
 * What developers' agents may read in the server's Claude directory: the team
 * configuration, and `github`, which imported skills and agents are symlinks
 * into - closing it broke every imported skill for developer users. Everything
 * else (run records, roles, the hierarchy, watches, schedules, the server
 * user's own Claude data) is closed to them. install-run-as.sh carries the
 * same list; a test keeps the two equal.
 */
export const SHARED_CLAUDE_ENTRIES = ['agents', 'skills', 'commands', 'output-styles', 'plugins', 'settings.json', 'CLAUDE.md', 'github'] as const

/**
 * Close every top-level entry of the server's Claude directory that is not
 * shared and is open to other users; returns what it closed. Symlinks are left
 * alone (chmod would act on their target).
 *
 * The installer can only close what exists when it runs. The server creates
 * roles.json, hierarchy.json, watches.json, schedules and the rest later, with
 * its 022 umask - world-readable - so this runs at boot, on every new entry,
 * and on a sweep. Never throws: an entry it cannot close is left for the next.
 */
export function closePrivateClaudeEntries(dir: string): string[] {
  const shared = new Set<string>(SHARED_CLAUDE_ENTRIES)
  const closed: string[] = []
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return closed }
  for (const name of entries) {
    if (shared.has(name)) continue
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      if (st.isSymbolicLink() || (st.mode & 0o007) === 0) continue
      chmodSync(path, st.mode & 0o7770)
      closed.push(name)
    } catch { /* gone, or not ours: the next sweep tries again */ }
  }
  return closed
}
