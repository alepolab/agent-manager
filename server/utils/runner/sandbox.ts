/**
 * The sandboxed runner: one step's Claude Code process inside a disposable
 * container, driven by the SDK on the host over stdin/stdout.
 *
 * What the container gets, and only that:
 *   - the run's git worktree, bind-mounted at the SAME path it has on the
 *     host, so every absolute path the run record, the hooks and the agents
 *     already use is true inside as well. The clone the worktree belongs to is
 *     mounted beside it read-only: `git` resolves `.git` through a gitdir
 *     file that points into the clone, and a worktree without its clone is not
 *     a repository.
 *   - a minimal Claude config directory staged per run (stageSandboxConfig):
 *     the pipeline agents, skills and settings this instance was staged with,
 *     never the host's `~/.claude`, whose credentials and transcripts are the
 *     reason a sandbox exists. Authentication reaches the CLI as an
 *     environment variable (ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN),
 *     never as a mounted credentials file.
 *   - the shipped engineering/ tree (hooks, scripts, skills), read-only, at the
 *     path the host env (SDLC_SCRIPTS_DIR and friends) already names.
 *   - an ALLOWLISTED environment (SANDBOX_ENV_ALLOW): model credentials and
 *     proxy settings, Jira, the GitHub token, this instance's URL and API
 *     token, git identity, and the pipeline's own flags. Nothing else from the
 *     host process reaches it: no server secret, no session key, no SMTP.
 *   - cpu, memory and pid limits, and a wall-clock limit derived from the run
 *     budget (`docker run --stop-timeout` plus a `timeout` inside).
 *   - a dedicated bridge network (SANDBOX_NETWORK) rather than the default
 *     bridge. v1 egress control is at the network level: see
 *     engineering/docs/runner.md for the iptables and `--network` notes and the
 *     residual risk this leaves.
 *
 * One container PER STEP (fresh container, same worktree). Per-step is the
 * simpler choice: no container has to outlive the SDK process it was spawned
 * for, so teardown is "the process exited" plus a `docker rm` sweep by label,
 * and nothing has to reconcile a long-lived container with a run that was
 * stopped between steps.
 *
 * GitHub token: the existing AGENT_GH_TOKEN / profile-token resolution
 * (agentCaller.ts's launchEnv) is used as-is. TODO: mint a GitHub App
 * installation token scoped to the run's repositories here instead
 * (githubTokenFor), so a leaked token expires in an hour and reaches one repo.
 *
 * Everything that only shapes the spec is pure and tested without Docker
 * (scripts/test-sandbox-env-allowlist.mjs). Only `spawnSandboxed` and the
 * image probe talk to the daemon.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { agentManagerSettings, envString } from '../appSettings.ts'
import { getClaudeDir } from '../claudeDir.ts'
import { createLogger } from '../log.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

/** Default image: built from engineering/runner/Dockerfile. AGENT_SANDBOX_IMAGE or settings.sandbox.image overrides. */
export const DEFAULT_SANDBOX_IMAGE = 'ghcr.io/alepolab/agent-manager-runner:latest'
/** The dedicated network every sandbox joins. Created on demand (`docker network create`). */
export const SANDBOX_NETWORK = 'agent-manager-sandbox'
/** The label every sandbox container carries, with the run id as its value; teardown sweeps by it. */
export const SANDBOX_LABEL = 'agent-manager.sandbox'
/** Where the staged config directory is mounted; CLAUDE_CONFIG_DIR inside points here. */
export const SANDBOX_CONFIG_MOUNT = '/sandbox/claude'

/**
 * Environment names, and prefixes, that may cross into the container.
 * Everything else in the host process environment is dropped. A name has to
 * be here to reach an agent: an omission is a step that cannot find its token,
 * which is loud; a leak is silent, so the list errs short.
 */
export const SANDBOX_ENV_ALLOW: { exact: string[], prefixes: string[] } = {
  exact: [
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    'GH_TOKEN', 'GITHUB_TOKEN',
    'AGENT_MANAGER_URL', 'AGENT_MANAGER_API_TOKEN', 'AGENT_MANAGER_TOKEN',
    'ALEPO_PIPELINE', 'ALEPO_STOP_GATE',
    'SDLC_SCRIPTS_DIR', 'SDLC_SKILLS_DIR', 'CE_SKILLS_DIR', 'ALEPO_SKILLS_DIR',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT',
    'LANG', 'LC_ALL', 'TZ',
  ],
  prefixes: ['ANTHROPIC_', 'JIRA_', 'GIT_AUTHOR_', 'GIT_COMMITTER_', 'OTEL_', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_ENHANCED_TELEMETRY'],
}

/** Names the SDK sets for its own child that must NOT be forwarded: they describe the host process. */
const SANDBOX_ENV_DENY = new Set(['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'NODE_OPTIONS', 'PWD', 'DOCKER_CONFIG'])

/** The variables of `env` that may cross into the container, plus the ones every sandbox gets. */
export function allowlistEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || SANDBOX_ENV_DENY.has(k)) continue
    if (SANDBOX_ENV_ALLOW.exact.includes(k) || SANDBOX_ENV_ALLOW.prefixes.some(p => k.startsWith(p))) out[k] = v
  }
  // The SDK marks its child with this; inside the container it is the same protocol.
  if (env.CLAUDE_CODE_ENTRYPOINT) out.CLAUDE_CODE_ENTRYPOINT = env.CLAUDE_CODE_ENTRYPOINT
  out.CLAUDE_CONFIG_DIR = SANDBOX_CONFIG_MOUNT
  out.ALEPO_PIPELINE = '1'
  out.ALEPO_STOP_GATE = '1'
  return out
}

export interface SandboxLimits {
  cpus: string
  memory: string
  pidsLimit: number
  /** Seconds the container may live before `timeout` ends the CLI; from the run budget. */
  wallClockSeconds: number
}

/** Limits from settings.sandbox, with the wall clock from the run's minute budget plus a margin for the CLI to finish and report. */
export function sandboxLimits(run: { budget?: { maxMinutes?: number } }, s = agentManagerSettings().sandbox ?? {}): SandboxLimits {
  const minutes = run.budget?.maxMinutes && run.budget.maxMinutes > 0 ? run.budget.maxMinutes : 180
  return {
    cpus: s.cpus ?? '2',
    memory: s.memory ?? '4g',
    pidsLimit: s.pidsLimit ?? 512,
    wallClockSeconds: Math.ceil(minutes * 60) + 300,
  }
}

export interface SandboxMounts {
  worktree: string
  /** The clone the worktree belongs to (`<clone>@<branch>` → `<clone>`), or undefined when the directory is not a worktree. */
  clone?: string
  configDir: string
  engineeringDir: string
}

/** `-v` arguments: same path inside as out, so no recorded path has to be translated. */
export function mountArgs(m: SandboxMounts): string[] {
  const args = ['-v', `${m.worktree}:${m.worktree}`]
  if (m.clone && m.clone !== m.worktree) args.push('-v', `${m.clone}:${m.clone}`)
  args.push('-v', `${m.configDir}:${SANDBOX_CONFIG_MOUNT}`)
  args.push('-v', `${m.engineeringDir}:${m.engineeringDir}:ro`)
  return args
}

/** `<clone>@<branch>` is this repo's worktree naming (workspace.ts); the clone is the part before the `@`. */
export function cloneOf(worktree: string): string | undefined {
  const m = worktree.match(/^(.*)@[^/\\]+$/)
  return m ? m[1] : undefined
}

export interface SandboxSpec {
  image: string
  args: string[]
  env: Record<string, string>
  limits: SandboxLimits
}

/**
 * The full `docker run` argument list for one step, given the SDK's spawn
 * request. Pure: the daemon is not consulted. `command` and `args` are what
 * the SDK would have run locally (`claude --output-format stream-json ...`);
 * inside the container the CLI is `claude` on PATH, so the host binary path is
 * replaced and the arguments kept verbatim.
 */
export function buildSandboxSpec(opts: {
  runId: string
  stepId: string
  image: string
  cwd: string
  mounts: SandboxMounts
  hostEnv: Record<string, string | undefined>
  cliArgs: string[]
  limits: SandboxLimits
  network?: string
  user?: string
}): SandboxSpec {
  const env = allowlistEnv(opts.hostEnv)
  const args = [
    'run', '--rm', '-i',
    '--name', `am-sandbox-${opts.runId.slice(0, 8)}-${opts.stepId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 30)}-${Date.now().toString(36)}`,
    '--label', `${SANDBOX_LABEL}=${opts.runId}`,
    '--label', `agent-manager.run=${opts.runId}`,
    '--network', opts.network ?? SANDBOX_NETWORK,
    '--cpus', opts.limits.cpus,
    '--memory', opts.limits.memory,
    '--pids-limit', String(opts.limits.pidsLimit),
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--stop-timeout', '20',
    '-w', opts.cwd,
    ...(opts.user ? ['--user', opts.user] : []),
    ...mountArgs(opts.mounts),
  ]
  for (const k of Object.keys(env)) args.push('-e', k)
  args.push(opts.image, 'timeout', '--signal=TERM', '--kill-after=30', String(opts.limits.wallClockSeconds), 'claude', ...opts.cliArgs)
  return { image: opts.image, args, env, limits: opts.limits }
}

/** The configured image name. */
export function sandboxImageName(): string {
  return envString('AGENT_SANDBOX_IMAGE') ?? agentManagerSettings().sandbox?.image ?? DEFAULT_SANDBOX_IMAGE
}

export interface SandboxImage { name: string, digest?: string, egressProfile: string }

/** The egress profile name, recorded on the run: what engineering/docs/runner.md documents under that name. */
export function egressProfile(): string {
  return envString('AGENT_SANDBOX_EGRESS') ?? agentManagerSettings().sandbox?.egressProfile ?? 'bridge-proxy-only'
}

/** The image, if the daemon has it; null when docker is absent, the daemon is down or the image is not pulled. Never throws. */
export async function sandboxImageAvailable(name = sandboxImageName()): Promise<SandboxImage | null> {
  try {
    const { stdout } = await execFileP('docker', ['image', 'inspect', '--format', '{{.Id}}', name], { timeout: 15_000 })
    const digest = stdout.trim() || undefined
    return { name, ...(digest ? { digest } : {}), egressProfile: egressProfile() }
  } catch {
    return null
  }
}

/** Makes sure the dedicated network exists. Best effort: a failure is reported by `docker run` itself. */
export async function ensureSandboxNetwork(name = SANDBOX_NETWORK): Promise<void> {
  try {
    await execFileP('docker', ['network', 'inspect', name], { timeout: 15_000 })
  } catch {
    await execFileP('docker', ['network', 'create', '--driver', 'bridge', '--label', SANDBOX_LABEL, name], { timeout: 30_000 }).catch(() => {})
  }
}

/** What the staged config carries: the same allowlist stage-claude-config.sh uses, minus workflows (the runner holds those). */
const CONFIG_ALLOW = ['agents', 'skills', 'commands', 'output-styles', 'plugins']

/**
 * Stages a minimal Claude config directory for one run, following
 * scripts/stage-claude-config.sh: an allowlist of config entries copied from
 * this instance's directory, never credentials, transcripts or history, and a
 * settings.json that disables telemetry-unrelated discovery. Returned path is
 * what the container sees at SANDBOX_CONFIG_MOUNT. Removed by removeSandboxConfig.
 */
export async function stageSandboxConfig(runId: string, source = getClaudeDir(), root = join(tmpdir(), 'agent-manager-sandbox')): Promise<string> {
  const dir = join(root, runId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const entry of CONFIG_ALLOW) {
    const from = join(source, entry)
    if (!existsSync(from)) continue
    await cp(from, join(dir, entry), {
      recursive: true, dereference: true,
      filter: (src) => !/[\\/](\.git|node_modules|marketplaces)([\\/]|$)/.test(src) && !/\.(pem|key|p12|pfx|log)$/.test(src) && !/[\\/]\.(credentials\.json|env(\..*)?)$/.test(src),
    })
  }
  // Nothing of the host's settings.json: the SDK passes settingSources: [] and
  // the hooks explicitly, so the file only has to exist and say so.
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ agentManager: { sandboxed: true, runId } }, null, 2))
  return dir
}

export async function removeSandboxConfig(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/**
 * The GitHub token a sandboxed step runs with. Today: whatever launchEnv
 * resolved (profile token, else AGENT_GH_TOKEN, else nothing), passed through.
 *
 * TODO(github-app): when AGENT_GH_APP_ID / AGENT_GH_APP_PRIVATE_KEY /
 * AGENT_GH_APP_INSTALLATION_ID are set, mint an installation token here scoped
 * to `repos` (POST /app/installations/{id}/access_tokens with `repositories`),
 * hand it in as GH_TOKEN/GITHUB_TOKEN, and let it expire with the step. The
 * hook is here so the spec builder does not change when that lands.
 */
export async function githubTokenFor(env: Record<string, string>, _repos: string[]): Promise<Record<string, string>> {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}
}

export interface SandboxContext {
  runId: string
  stepId: string
  worktree: string
  budget?: { maxMinutes?: number }
  repos?: string[]
  image: string
}

/**
 * The `spawnClaudeCodeProcess` the SDK is handed for a sandboxed step. The
 * SDK's `env` is what agentCaller's launchEnv built (host process env plus the
 * step's identity); the allowlist cuts it down. Returns the docker client
 * process, which satisfies SpawnedProcess: its stdin and stdout ARE the CLI's,
 * and killing the client ends the container (`--rm`, foreground `docker run`).
 */
export function spawnSandboxed(ctx: SandboxContext, configDir: string, engineeringDir: string): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const limits = sandboxLimits({ budget: ctx.budget })
    const spec = buildSandboxSpec({
      runId: ctx.runId,
      stepId: ctx.stepId,
      image: ctx.image,
      cwd: options.cwd ?? ctx.worktree,
      mounts: { worktree: ctx.worktree, clone: cloneOf(ctx.worktree), configDir, engineeringDir },
      hostEnv: options.env,
      cliArgs: options.args,
      limits,
      user: envString('AGENT_SANDBOX_USER'),
    })
    log.info('sandboxed step starting', { runId: ctx.runId, stepId: ctx.stepId, image: spec.image, cpus: limits.cpus, memory: limits.memory, wallClockSeconds: limits.wallClockSeconds, envKeys: Object.keys(spec.env).length })
    const child: ChildProcess = spawn('docker', spec.args, {
      // Only the allowlisted values, by name: `-e NAME` reads from this environment.
      env: { ...spec.env, PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DOCKER_HOST: process.env.DOCKER_HOST ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) log.debug('sandbox stderr', { runId: ctx.runId, stepId: ctx.stepId, line: line.slice(0, 300) })
    })
    return child as unknown as SpawnedProcess
  }
}

/**
 * Removes any container of this run that is still around: a step whose SDK
 * process died without the docker client exiting. Lines for the teardown
 * report; never throws. Called from runTeardown.
 */
export async function reapSandboxContainers(runId: string, exec: (cmd: string, args: string[]) => Promise<string> = async (c, a) => (await execFileP(c, a, { timeout: 60_000 })).stdout): Promise<string[]> {
  let ids: string[] = []
  try {
    ids = (await exec('docker', ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}=${runId}`])).split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
  const lines: string[] = []
  for (const id of ids) {
    try {
      await exec('docker', ['rm', '-f', id])
      lines.push(`Removed sandbox container ${id.slice(0, 12)}.`)
    } catch (err) {
      lines.push(`Could not remove sandbox container ${id.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lines
}

/** The engineering/ directory the sandbox mounts read-only: the one SDLC_SCRIPTS_DIR lives under. */
export function engineeringDirFor(scriptsDir: string): string {
  return dirname(scriptsDir)
}
