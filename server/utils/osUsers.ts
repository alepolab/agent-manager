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
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  return (options: { command: string, args: string[], cwd?: string, env: Record<string, string | undefined>, signal?: AbortSignal }) =>
    spawn('sudo', runAsArgv(login, options.command, options.args), {
      cwd: options.cwd,
      env: runAsEnv(login, options.env) as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
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
  await execFileP('setfacl', ['-m', `u:${user}:x`, dirname(dir)])
  await execFileP('setfacl', ['-R', '-m', `u:${user}:rwX,m::rwx`, dir])
  await execFileP('setfacl', ['-R', '-d', '-m', `u::rwx,u:${user}:rwx,g::---,m::rwx,o::---`, dir])
}

/**
 * git refuses a repository owned by another user ("dubious ownership"), and
 * with agents running as developers the server and an agent each own some of
 * the same checkouts. Both sides trust them: the server here, at boot, and an
 * agent through agentEnvFor. Only in this mode - elsewhere one user owns all.
 */
export const SAFE_DIRECTORY_CONFIG = { key: 'safe.directory', value: '*' } as const
