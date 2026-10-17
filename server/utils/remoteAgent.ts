import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { workspaceRoot } from './workspace.ts'
import { agentRunsRoot } from './runArtifacts.ts'
import { getClaudeDir } from './claudeDir.ts'
import { createLogger } from './log.ts'
import {
  type Machine, keyFileFor, sshOptionArgs, sshTarget, shellQuote, shellPath, loginShellCommand, sshExec,
} from './machines.ts'

/**
 * Running one agent call on a registered machine instead of beside this server.
 *
 * Three things have to be true for a step to run elsewhere and the run not to
 * notice: the Claude Code process has to start there, the checkout and the
 * evidence directory it reads and writes have to be there before it starts,
 * and what it wrote has to be back here when it ends — because everything
 * else in the runner (the diff a gate shows, the brief a reviewer reads, the
 * artifact a later step is handed) reads this server's copy.
 *
 * The process: the SDK's `spawnClaudeCodeProcess` hook. The SDK speaks to the
 * CLI over stdin and stdout in a line protocol, which is exactly what ssh
 * carries, so the hook spawns `ssh host bash -lc 'cd <dir> && exec env … claude
 * <args>'` and hands the SDK the child. Hooks, steering, the result message,
 * the abort — all of it works unchanged, because none of it knows where the
 * other end of the pipe is.
 *
 * The files: git for history and rsync for the rest. The run's commits are
 * pushed to a repository on the machine (history is incremental and cheap),
 * the working tree and the evidence directory are rsync'd over, and after the
 * step the same in reverse. A `git worktree` checkout cannot simply be copied —
 * its `.git` is a file pointing into a main repository that is not there — so
 * the machine gets a real repository of its own and git carries the commits.
 *
 * `shared` transport skips the copying entirely: both sides see one
 * filesystem, and only the path mapping applies.
 */

const log = createLogger('remote')
const execFileP = promisify(execFile)

/** The roots that are re-rooted onto a machine. Taken from this process once per call so a test can hand in its own. */
export interface PathRoots {
  workspace: string
  runs: string
  app: string
  claude: string
}

export function localRoots(): PathRoots {
  return { workspace: workspaceRoot(), runs: agentRunsRoot(), app: process.cwd(), claude: getClaudeDir() }
}

const fwd = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * `local` re-rooted from `fromRoot` to `toRoot`. Unchanged when `toRoot` is
 * empty (the machine shares this server's layout) or `local` is outside
 * `fromRoot`. Forward slashes throughout: the result names a path on a machine
 * the agents reach with ssh, never a path this process opens.
 */
export function mapPath(local: string, fromRoot: string, toRoot: string | undefined): string {
  const l = fwd(local)
  if (!toRoot) return l
  const from = fwd(fromRoot)
  const to = fwd(toRoot)
  if (l === from) return to
  if (l.startsWith(`${from}/`)) return `${to}${l.slice(from.length)}`
  return l
}

/** The path on the machine for one of this server's paths, through whichever root it is under. The longest root wins. */
export function remotePathFor(m: Pick<Machine, 'workspaceRoot' | 'runsRoot' | 'appRoot' | 'claudeDir'>, local: string, roots: PathRoots = localRoots()): string {
  const candidates: [string, string | undefined][] = [
    [roots.workspace, m.workspaceRoot],
    [roots.runs, m.runsRoot],
    [roots.app, m.appRoot],
    [roots.claude, m.claudeDir],
  ]
  const l = fwd(local)
  const match = candidates
    .filter(([from]) => from && (l === fwd(from) || l.startsWith(`${fwd(from)}/`)))
    .sort((a, b) => fwd(b[0]).length - fwd(a[0]).length)[0]
  return match ? mapPath(l, match[0], match[1]) : l
}

/**
 * Which of the launch environment travels to the machine.
 *
 * `launchEnv` spreads this whole process's environment, and most of that is
 * about THIS host — PATH, HOME, the proxy, the port the server listens on. The
 * machine has its own. What travels is the run's identity and what the agents
 * are told about: model credentials, git and GitHub identity, Jira, the paths
 * agents are handed (re-rooted), and Claude Code's own switches.
 */
export const FORWARDED_ENV_PATTERN = /^(ANTHROPIC_|CLAUDE_|GIT_|GH_|GITHUB_|JIRA_|SDLC_|DISABLE_|MAX_THINKING_TOKENS$|API_TIMEOUT_MS$|CE_SKILLS_DIR$|ALEPO_SKILLS_DIR$|AGENT_MANAGER_URL$|AGENT_MANAGER_API_TOKEN$)/
/** Never forwarded, whatever the pattern says: this server's own secrets, and files that only exist here. */
export const NEVER_FORWARDED = new Set(['AGENT_MANAGER_SECRET', 'GITHUB_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'JIRA_CONFIG_FILE', 'DOCKER_CONFIG', 'CLAUDE_DIR', 'GIT_SSH_COMMAND'])
/** Path-valued variables, re-rooted onto the machine. */
const PATH_VARS = new Set(['SDLC_SCRIPTS_DIR', 'SDLC_SKILLS_DIR', 'CE_SKILLS_DIR', 'ALEPO_SKILLS_DIR', 'CLAUDE_CONFIG_DIR'])

export function remoteEnvFor(m: Machine, env: Record<string, string | undefined>, roots: PathRoots = localRoots()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || NEVER_FORWARDED.has(k) || !FORWARDED_ENV_PATTERN.test(k)) continue
    out[k] = PATH_VARS.has(k) && v ? remotePathFor(m, v, roots) : v
  }
  // The machine's own additions win: they are the operator's answer to "this
  // host is different", which is the whole reason the machine is registered.
  return { ...out, ...(m.env ?? {}) }
}

/**
 * The CLI arguments as the machine's `claude` should receive them. The SDK
 * spawns `node <cli.js> …` (or a native binary) with a path that exists here
 * and nowhere else, so when the command is a JavaScript runtime the script path
 * is dropped and the rest is passed to the machine's own executable.
 */
export function remoteCliArgs(command: string, args: string[]): string[] {
  // Split on either separator: the SDK may hand over a Windows path, and
  // posix basename does not know what a backslash is.
  const runtime = /^(node|bun|deno)(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? '')
  return runtime && args[0] && /\.[cm]?js$/i.test(args[0]) ? args.slice(1) : args
}

/** What the SDK hands a custom spawner. Named here rather than imported so plain-node tests load this module without the SDK. */
export interface SpawnRequest {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
  signal?: AbortSignal
}

/** The one shell line the machine runs for an agent call. */
export function remoteAgentCommand(m: Machine, req: Pick<SpawnRequest, 'command' | 'args' | 'env'>, remoteCwd: string, roots: PathRoots = localRoots()): string {
  const env = remoteEnvFor(m, req.env, roots)
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`)
  const claude = m.claudePath || 'claude'
  const argv = remoteCliArgs(req.command, req.args).map(shellQuote)
  return `cd ${shellPath(remoteCwd)} && exec env ${assignments.join(' ')} ${shellQuote(claude)}${argv.length ? ` ${argv.join(' ')}` : ''}`
}

/** The ssh argv for an agent call, before the remote command itself. */
export function remoteSpawnArgs(m: Machine, keyFile: string | undefined, remoteCommand: string): string[] {
  return [...sshOptionArgs(m, keyFile), '-T', sshTarget(m), '--', loginShellCommand(remoteCommand)]
}

/**
 * The SDK's `spawnClaudeCodeProcess` for one machine. Synchronous by the SDK's
 * contract, so the key file is resolved by the caller beforehand.
 */
export function remoteSpawner(m: Machine, opts: { remoteCwd: string, keyFile?: string, roots?: PathRoots }) {
  return (req: SpawnRequest): ChildProcess => {
    const cmd = remoteAgentCommand(m, req, req.cwd ?? opts.remoteCwd, opts.roots)
    const args = remoteSpawnArgs(m, opts.keyFile, cmd)
    log.debug('spawning claude on machine', () => ({ machine: m.name, target: sshTarget(m), cwd: req.cwd ?? opts.remoteCwd }))
    return spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, signal: req.signal })
  }
}

// ── carrying the checkout and the evidence over, and back ───────────────────

/** What the sync needs to know about a run. A subset of WorkflowRun, named so a test can hand one in. */
export interface RemoteRunFacts {
  id: string
  projectDir?: string
  branch?: string
  baseBranch?: string
  baseCommit?: string
  /** This server's evidence directory for the run. */
  artifactsDir: string
}

/** The shell-outs the sync makes, injectable so a test sees the commands without a host. */
export interface SyncTools {
  ssh: (m: Machine, cmd: string, opts?: { timeoutMs?: number }) => Promise<string>
  /** A local command, with its stdout. */
  local: (cmd: string, args: string[], opts: { cwd?: string, env?: Record<string, string>, timeoutMs?: number }) => Promise<string>
}

const realTools: SyncTools = {
  ssh: (m, cmd, opts) => sshExec(m, cmd, opts),
  local: async (cmd, args, opts) => {
    const r = await execFileP(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024 })
    return r.stdout
  },
}

/** A git URL for the repository on the machine. `~/x` becomes `/~/x`, which git's ssh transport expands on the far side. */
export function remoteGitUrl(m: Machine, remoteDir: string): string {
  const path = remoteDir.startsWith('~') ? `/${remoteDir}` : remoteDir
  return `ssh://${sshTarget(m)}${m.port ? `:${m.port}` : ''}${path}`
}

/** The `ssh` command string git and rsync use, carrying the same options as every other connection to the machine. */
export function sshCommandString(m: Machine, keyFile?: string): string {
  return ['ssh', ...sshOptionArgs(m, keyFile)].map(shellQuote).join(' ')
}

/** Names git may receive as refs. A branch the runner made is already safe; this guards the fallback. */
const safeRef = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock')

/** Where the step's files go on the machine, from where they are here. */
export function remoteDirsFor(m: Machine, run: RemoteRunFacts, roots: PathRoots = localRoots()): { worktree?: string, artifacts: string } {
  return {
    worktree: run.projectDir ? remotePathFor(m, run.projectDir, roots) : undefined,
    artifacts: remotePathFor(m, run.artifactsDir, roots),
  }
}

function rsyncArgs(sshCmd: string, from: string, to: string, excludeGit: boolean): string[] {
  // -s (protect args) so a path with a space, or a leading ~ the machine's
  // shell must not see quoted, is taken as one argument on the far side.
  return ['-az', '-s', ...(excludeGit ? ['--exclude=/.git'] : []), '-e', sshCmd, `${from.replace(/\/+$/, '')}/`, `${to.replace(/\/+$/, '')}/`]
}

/**
 * Brings the machine up to date with this server before a step: the
 * repository (commits pushed to a holding ref, then checked out there), the
 * working tree, and the evidence directory. Returns the lines for the step log.
 *
 * The commits are pushed to `refs/agent-manager/incoming`, never to the branch
 * the machine has checked out: git refuses to update a checked-out branch
 * through a push, and a step's uncommitted leftovers from the previous visit
 * would make even `updateInstead` refuse. The machine then moves its branch
 * itself and resets hard to it — which drops exactly those leftovers, and the
 * rsync that follows puts this server's copy of them back.
 */
export async function pushToMachine(m: Machine, run: RemoteRunFacts, opts: { tools?: SyncTools, roots?: PathRoots } = {}): Promise<string[]> {
  if (m.transport === 'shared') return [`Machine ${m.name} shares this server's filesystem; nothing to copy.`]
  const tools = opts.tools ?? realTools
  const roots = opts.roots ?? localRoots()
  const lines: string[] = []
  const keyFile = await keyFileFor(m)
  const sshCmd = sshCommandString(m, keyFile)
  const dirs = remoteDirsFor(m, run, roots)
  const started = Date.now()

  const mk = [dirs.artifacts, ...(dirs.worktree ? [dirs.worktree] : [])].map(d => `mkdir -p ${shellPath(d)}`).join(' && ')
  await tools.ssh(m, mk, { timeoutMs: 60_000 })

  if (dirs.worktree && run.projectDir && existsSync(run.projectDir)) {
    const git = (args: string[]) => tools.local('git', args, { cwd: run.projectDir, env: { GIT_SSH_COMMAND: sshCmd }, timeoutMs: 600_000 })
    const isRepo = await git(['rev-parse', '--is-inside-work-tree']).then(s => s.trim() === 'true', () => false)
    if (isRepo) {
      const head = (await git(['rev-parse', 'HEAD'])).trim()
      const branch = run.branch && safeRef(run.branch) ? run.branch : ((await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim())
      const ref = branch !== 'HEAD' && safeRef(branch) ? branch : 'agent-run'
      const origin = (await git(['remote', 'get-url', 'origin']).catch(() => '')).trim()
      const url = remoteGitUrl(m, dirs.worktree)
      // The repository on the machine, made once: history comes by push, the
      // product's origin so `git push origin` from a step reaches the same place.
      await tools.ssh(m, [
        `cd ${shellPath(dirs.worktree)}`,
        `{ [ -d .git ] || git init -q; }`,
        ...(origin ? [`{ git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shellQuote(origin)}; }`] : []),
      ].join(' && '), { timeoutMs: 60_000 })
      const refspecs = [`+${head}:refs/agent-manager/incoming`]
      if (run.baseCommit && run.baseBranch && safeRef(run.baseBranch) && run.baseBranch !== ref) refspecs.push(`+${run.baseCommit}:refs/heads/${run.baseBranch}`)
      await git(['push', '-q', url, ...refspecs])
      await tools.ssh(m, [
        `cd ${shellPath(dirs.worktree)}`,
        `git update-ref refs/heads/${ref} refs/agent-manager/incoming`,
        `{ [ "$(git symbolic-ref -q HEAD)" = refs/heads/${ref} ] || git checkout -q -f ${ref}; }`,
        `git reset -q --hard refs/agent-manager/incoming`,
      ].join(' && '), { timeoutMs: 120_000 })
      lines.push(`Pushed ${ref} at ${head.slice(0, 8)} to ${m.name}:${dirs.worktree}`)
    } else {
      lines.push(`${run.projectDir} is not a git checkout; copying files only`)
    }
    await tools.local('rsync', rsyncArgs(sshCmd, run.projectDir, `${sshTarget(m)}:${dirs.worktree}`, isRepo), { timeoutMs: 1_800_000 })
  }
  if (existsSync(run.artifactsDir)) {
    await tools.local('rsync', rsyncArgs(sshCmd, run.artifactsDir, `${sshTarget(m)}:${dirs.artifacts}`, false), { timeoutMs: 600_000 })
  }
  lines.push(`Checkout and evidence copied to ${m.name} in ${Math.round((Date.now() - started) / 1000)}s`)
  return lines
}

/**
 * Brings this server up to date with the machine after a step: the commits
 * the agent made (fetched, and the local worktree reset to them), the working
 * tree, and the evidence directory. Never throws for a step that produced
 * nothing: a machine with no new commit is a normal outcome.
 */
export async function pullFromMachine(m: Machine, run: RemoteRunFacts, opts: { tools?: SyncTools, roots?: PathRoots } = {}): Promise<string[]> {
  if (m.transport === 'shared') return []
  const tools = opts.tools ?? realTools
  const roots = opts.roots ?? localRoots()
  const lines: string[] = []
  const keyFile = await keyFileFor(m)
  const sshCmd = sshCommandString(m, keyFile)
  const dirs = remoteDirsFor(m, run, roots)
  const started = Date.now()

  if (dirs.worktree && run.projectDir && existsSync(run.projectDir)) {
    const git = (args: string[]) => tools.local('git', args, { cwd: run.projectDir, env: { GIT_SSH_COMMAND: sshCmd }, timeoutMs: 600_000 })
    const isRepo = await git(['rev-parse', '--is-inside-work-tree']).then(s => s.trim() === 'true', () => false)
    if (isRepo) {
      const facts = await tools.ssh(m, `cd ${shellPath(dirs.worktree)} && git rev-parse HEAD && { git symbolic-ref -q --short HEAD || echo HEAD; }`, { timeoutMs: 60_000 })
      const [remoteHead, remoteBranch] = facts.trim().split('\n').map(s => s.trim())
      const localHead = (await git(['rev-parse', 'HEAD'])).trim()
      if (remoteHead && remoteHead !== localHead) {
        const url = remoteGitUrl(m, dirs.worktree)
        await git(['fetch', '-q', url, remoteHead])
        await git(['reset', '-q', '--hard', remoteHead])
        lines.push(`Fetched ${remoteBranch ?? 'HEAD'} at ${remoteHead.slice(0, 8)} from ${m.name}`)
      }
    }
    await tools.local('rsync', rsyncArgs(sshCmd, `${sshTarget(m)}:${dirs.worktree}`, run.projectDir, isRepo), { timeoutMs: 1_800_000 })
  }
  await tools.local('rsync', rsyncArgs(sshCmd, `${sshTarget(m)}:${dirs.artifacts}`, run.artifactsDir, false), { timeoutMs: 600_000 })
  lines.push(`Results copied back from ${m.name} in ${Math.round((Date.now() - started) / 1000)}s`)
  return lines
}

/**
 * Everything a step needs to run on a machine, done before the agent starts:
 * the files are over there, and `agentOptions` is what callAgent takes. `finish`
 * is the step's own obligation afterwards, success or failure alike — a failed
 * step's half-written evidence is still evidence.
 */
export async function prepareRemoteStep(m: Machine, run: RemoteRunFacts, opts: { tools?: SyncTools, roots?: PathRoots } = {}) {
  const lines = await pushToMachine(m, run, opts)
  return {
    lines,
    machine: m,
    finish: () => pullFromMachine(m, run, opts),
  }
}
