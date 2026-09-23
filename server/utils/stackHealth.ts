/**
 * Whether the stack the runner just started is actually serving, and where.
 *
 * `stackLifecycle.stackUp` proves one thing: `docker compose up` exited zero.
 * That is not the same as a stack a step can work against, and the difference
 * was paid for twice - a visual step with no address to open, and a run that
 * spent its budget against a container that had been restarting since the
 * second it was created. Compose exits zero for both.
 *
 * WHAT THIS IS ALLOWED TO KNOW
 *
 * Only what docker itself reports. `docker compose ps --format json` is the
 * one source here: per service its state, its healthcheck verdict (the one the
 * compose file declares, not one invented here) and the ports it actually
 * published. A URL is derived ONLY from a published port; a service on the
 * host network publishes nothing through compose and is reported as such
 * rather than given a guessed `localhost:8080`. The registry may name real
 * entry points (`stack.urls`), and those are passed through verbatim.
 *
 * The same `-f`, `--env-file` and run-id environment as the `up` are used, or
 * `ps` would resolve a different compose project than the one that was started
 * and report an empty stack as confidently as a broken one.
 *
 * A one-shot stage that exited zero is healthy: `<p>-init` and `<p>-liquibase`
 * are supposed to be gone by the time anyone looks. A non-zero exit is not.
 *
 * Nothing here starts, stops or changes anything.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'
import { labelEnv } from './dockerReap.ts'
import type { StackRecipe } from './stackRecipe.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

export type ExecLike = (cmd: string, args: string[], env?: Record<string, string>) => Promise<string>

const realExec: ExecLike = async (cmd, args, env) => {
  const { stdout } = await execFileP(cmd, args, {
    timeout: 2 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return stdout
}

let injectedExec: ExecLike | null = null
/** Test seam, matching `stackLifecycle.setStackExec`. No test may reach the real daemon. */
export function setStatusExec(fn: ExecLike | null) { injectedExec = fn }

export interface StackPublisher {
  /** The address docker published on, as docker reports it. */
  host: string
  published: number
  target: number
  protocol: string
}

export interface StackServiceStatus {
  service: string
  /** running, exited, restarting - docker's own word for it. */
  state: string
  /** The compose file's own healthcheck verdict, absent when it declares none. */
  health?: string
  exitCode?: number
  publishers: StackPublisher[]
}

export interface StackProbe {
  url: string
  status?: number
  error?: string
  ms: number
}

export interface StackFacts {
  product: string
  composeFile: string
  profiles: string[]
  checkedAt: string
  services: StackServiceStatus[]
  /** Addresses derived from published ports. Never a guess: no publisher, no URL. */
  endpoints: string[]
  /** Entry points the registry names for this product, passed through unchanged. */
  registryUrls: string[]
  probes: StackProbe[]
  healthy: boolean
  waitedMs: number
  summary: string
}

/** A service that exited cleanly is a finished one-shot stage, not a fault. */
function serviceOk(s: StackServiceStatus): boolean {
  if (s.state === 'exited') return (s.exitCode ?? 0) === 0
  if (s.state !== 'running') return false
  return s.health === undefined || s.health === '' || s.health === 'healthy'
}

/** Still settling: worth waiting for, unlike a service that has already failed. */
function servicePending(s: StackServiceStatus): boolean {
  if (s.state === 'restarting' || s.state === 'created' || s.state === 'starting') return true
  return s.state === 'running' && s.health === 'starting'
}

function parsePublishers(raw: unknown): StackPublisher[] {
  if (!Array.isArray(raw)) return []
  const out: StackPublisher[] = []
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue
    const published = Number((p as Record<string, unknown>).PublishedPort ?? 0)
    // PublishedPort 0 means the port is declared but not published to the host;
    // an address built from it would not answer.
    if (!published) continue
    out.push({
      host: String((p as Record<string, unknown>).URL || '0.0.0.0'),
      published,
      target: Number((p as Record<string, unknown>).TargetPort ?? 0),
      protocol: String((p as Record<string, unknown>).Protocol || 'tcp'),
    })
  }
  return out
}

/**
 * `docker compose ps` output, one JSON object per line (compose emits JSON
 * Lines; a JSON array is accepted too, because older compose versions emit
 * one and a consumer that breaks on it would be broken by an upgrade).
 */
export function parseStatus(stdout: string): StackServiceStatus[] {
  const rows: Record<string, unknown>[] = []
  const trimmed = stdout.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) rows.push(...arr.filter(r => r && typeof r === 'object'))
    }
    catch { /* fall through to line parsing */ }
  }
  if (!rows.length) {
    for (const line of trimmed.split('\n')) {
      const text = line.trim()
      if (!text.startsWith('{')) continue
      try {
        const row = JSON.parse(text)
        if (row && typeof row === 'object') rows.push(row)
      }
      catch { /* a warning line docker wrote to stdout is not a service */ }
    }
  }
  return rows.map((r) => {
    const health = typeof r.Health === 'string' && r.Health ? r.Health : undefined
    const exit = Number(r.ExitCode ?? 0)
    return {
      service: String(r.Service || r.Name || 'unknown'),
      state: String(r.State || '').toLowerCase(),
      ...(health ? { health } : {}),
      ...(Number.isFinite(exit) ? { exitCode: exit } : {}),
      publishers: parsePublishers(r.Publishers),
    }
  })
}

/** What docker says about this stack right now. Never throws: an unreadable
 *  daemon is a fact the caller reports, not an exception that fails a step. */
export async function readStackStatus(
  recipe: StackRecipe,
  opts: { exec?: ExecLike, runId?: string } = {},
): Promise<{ services: StackServiceStatus[], error?: string, command: string }> {
  const exec = opts.exec ?? injectedExec ?? realExec
  const args = ['compose', '-f', recipe.composePath, '--env-file', recipe.envFile]
  for (const stage of recipe.stages) args.push('--profile', stage.profile)
  args.push('ps', '--all', '--format', 'json')
  const command = `docker ${args.join(' ')}`
  try {
    const stdout = await exec('docker', args, opts.runId ? labelEnv(opts.runId) : undefined)
    return { services: parseStatus(stdout), command }
  }
  catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join(' ').trim()
    return { services: [], error: why, command }
  }
}

const sleepReal = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** An HTTP probe of an address docker published. The port is a fact; the path
 *  is deliberately `/` and nothing else, because a route is not. */
async function probe(url: string, timeoutMs: number, fetchLike: typeof fetch): Promise<StackProbe> {
  const started = Date.now()
  try {
    const res = await fetchLike(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return { url, status: res.status, ms: Date.now() - started }
  }
  catch (err) {
    return { url, error: (err instanceof Error ? err.message : String(err)).slice(0, 200), ms: Date.now() - started }
  }
}

/**
 * Wait for the stack to settle, then say what it is and where it answers.
 *
 * The wait is bounded and polls docker rather than sleeping a fixed time: a
 * stack that is healthy in four seconds returns in four, and one that never
 * comes up returns a fault with the failing service named instead of an
 * optimistic sentence after an arbitrary pause.
 */
export async function verifyStack(
  recipe: StackRecipe,
  opts: {
    exec?: ExecLike
    runId?: string
    /** Entry points the registry names for this product. Passed through, never invented. */
    urls?: string[]
    deadlineMs?: number
    pollMs?: number
    probeTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    fetchLike?: typeof fetch
  } = {},
): Promise<StackFacts> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepReal
  const deadlineMs = opts.deadlineMs ?? 5 * 60_000
  const pollMs = opts.pollMs ?? 5_000
  const startedAt = now()
  const profiles = recipe.stages.map(s => s.profile)

  let services: StackServiceStatus[] = []
  let error: string | undefined
  let command = ''
  for (;;) {
    const read = await readStackStatus(recipe, { exec: opts.exec, runId: opts.runId })
    services = read.services
    error = read.error
    command = read.command
    const settled = services.length > 0 && !services.some(servicePending)
    if (settled || error) break
    if (now() - startedAt >= deadlineMs) break
    await sleep(pollMs)
  }

  const waitedMs = now() - startedAt
  const endpoints = [...new Set(services.flatMap(s => s.publishers
    .filter(p => p.protocol === 'tcp')
    .map(p => `http://localhost:${p.published}`)))]
  const registryUrls = [...new Set((opts.urls ?? []).filter(Boolean))]

  const probes: StackProbe[] = []
  if (!error) {
    const fetchLike = opts.fetchLike ?? fetch
    const timeoutMs = opts.probeTimeoutMs ?? 5_000
    for (const url of [...registryUrls, ...endpoints]) probes.push(await probe(url, timeoutMs, fetchLike))
  }

  const faulted = services.filter(s => !serviceOk(s))
  const healthy = !error && services.length > 0 && faulted.length === 0

  const where = registryUrls.length
    ? `Entry points from the registry: ${registryUrls.join(', ')}.`
    : endpoints.length
      ? `Published addresses: ${endpoints.join(', ')}.`
      : 'No service in this stack publishes a host port through compose - one on the host network binds directly, so read the compose file for its port rather than assuming localhost.'

  const probeNote = probes.length
    ? ` Probes: ${probes.map(p => `${p.url} -> ${p.status ?? p.error}`).join('; ')}.`
    : ''

  const summary = error
    ? `${recipe.product}: docker could not be asked what is running (${error}), so nothing about this stack is verified.`
    : !services.length
      ? `${recipe.product}: docker reports no containers for ${recipe.composeFile} with profiles ${profiles.join(', ')}. The stack is not running, whatever the up command returned.`
      : healthy
        ? `${recipe.product}: ${services.length} service(s) up and healthy after ${Math.round(waitedMs / 1000)}s. ${where}${probeNote}`
        : `${recipe.product}: ${faulted.length} of ${services.length} service(s) are not healthy - ${faulted.map(s => `${s.service} (${s.state}${s.health ? `, ${s.health}` : ''}${s.state === 'exited' ? `, exit ${s.exitCode}` : ''})`).join(', ')}. ${where}${probeNote}`

  log.info('stack verified', { product: recipe.product, healthy, services: services.length, waitedMs, command })

  return {
    product: recipe.product,
    composeFile: recipe.composeFile,
    profiles,
    checkedAt: new Date(now()).toISOString(),
    services,
    endpoints,
    registryUrls,
    probes,
    healthy,
    waitedMs,
    summary,
  }
}
