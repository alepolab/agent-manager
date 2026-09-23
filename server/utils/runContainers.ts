/**
 * Containers a step left behind when it was cut short.
 *
 * `docker run` is a client: killing the agent that typed it kills the client,
 * not the container. Run b2470236's test-author started a containerised Gradle
 * build, ran out of its wall-clock budget, and its CLI was aborted mid-wait —
 * the build kept going, holding 1.8GB on a host that later killed a process for
 * lack of memory, with nothing pointing back at the run that started it.
 *
 * The rule is deliberately narrow: only containers created during the step, and
 * only those bind-mounting a path INSIDE this run's own worktree. A product
 * stack stood up from the deployment repo mounts that checkout instead, which is
 * outside the worktree, so a stack a runbook deliberately leaves running for its
 * later steps is out of range here rather than by good luck.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'

const log = createLogger('runner')

const execFileP = promisify(execFile)

/** One running container, as the inspect format below reports it. */
export interface ContainerFacts {
  id: string
  /** Unix ms. */
  createdAt: number
  /** Bind-mount sources on the host. */
  mounts: string[]
}

/**
 * One shape to compare in. Windows hands back both separators and either case,
 * and an agent working in Git Bash reports its own cwd MSYS-style: the probe
 * that proved this mounted `/c/Users/...` while the run recorded
 * `C:\Users\...`, which no amount of separator-swapping makes equal.
 */
const norm = (p: string) => p
  .replace(/\\/g, '/')
  .replace(/^\/([a-zA-Z])\//, '$1:/')
  .replace(/\/+$/, '')
  .toLowerCase()

/**
 * Which of `containers` this step is answerable for.
 *
 * `since` is the step's start, minus nothing: a container created before the
 * step began belongs to whatever started it, however plausible it looks.
 */
export function containersToReap(
  containers: ContainerFacts[], opts: { worktree: string, since: number },
): string[] {
  const root = norm(opts.worktree)
  if (!root) return []
  return containers
    .filter(c => c.createdAt >= opts.since)
    .filter(c => c.mounts.some((m) => {
      const source = norm(m)
      return source === root || source.startsWith(`${root}/`)
    }))
    .map(c => c.id)
}

/** Running containers, or an empty list when docker is absent or unwell. */
export async function runningContainers(): Promise<ContainerFacts[]> {
  const ids = await execFileP('docker', ['ps', '-q'], { timeout: 15_000 })
    .then(r => r.stdout.split('\n').map(s => s.trim()).filter(Boolean), () => [])
  if (!ids.length) return []
  // One inspect for all of them: a call per container is a second of Windows
  // process spawn each, on a path that runs while a step is already failing.
  const format = '{{.Id}}\t{{.Created}}\t{{range .Mounts}}{{.Source}}|{{end}}'
  const out = await execFileP('docker', ['inspect', '--format', format, ...ids], { timeout: 30_000 })
    .then(r => r.stdout, () => '')
  return out.split('\n').map(s => s.trim()).filter(Boolean).flatMap((line) => {
    const [id, created, mounts = ''] = line.split('\t')
    const createdAt = Date.parse(created ?? '')
    if (!id || Number.isNaN(createdAt)) return []
    return [{ id, createdAt, mounts: mounts.split('|').filter(Boolean) }]
  })
}

/**
 * Stops what the step left running and returns a line per container for the
 * step log — silent reaping would trade one invisible leak for another.
 */
export async function reapRunContainers(opts: { worktree: string, since: number }): Promise<string[]> {
  // No worktree, no rule to apply - and no reason to pay for docker. Every
  // failing step reaches here, including the many that never ran a container:
  // shelling out regardless put a Docker round-trip on a path that has to be
  // quick, and test-agent-budgets started missing its 5s settle deadline on a
  // loaded host because of it.
  if (!opts.worktree) return []
  const doomed = containersToReap(await runningContainers(), opts)
  const lines: string[] = []
  for (const id of doomed) {
    try {
      await execFileP('docker', ['stop', '-t', '10', id], { timeout: 60_000 })
      lines.push(`Stopped container ${id.slice(0, 12)}, left running by this step.`)
      log.info('reaped a container left by a step', { container: id.slice(0, 12), worktree: opts.worktree })
    } catch (err) {
      lines.push(`Could not stop container ${id.slice(0, 12)}, left running by this step: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return lines
}
