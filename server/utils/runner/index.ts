/**
 * Where a step's Claude Code process runs: on this host, as it always has, or
 * inside a disposable container.
 *
 * The SDK's `query()` loop stays on the host either way. agentCaller.ts hands
 * the SDK a `spawnClaudeCodeProcess` function for the sandbox case, and the SDK
 * speaks the same stream-json control protocol over that process's stdin and
 * stdout as it does to a local child. Hooks, steering, the result
 * interpretation and the progress lines are therefore identical in both modes:
 * nothing between the SDK message stream and the run record changes. See
 * sandbox.ts for what the container is given and denied.
 *
 * Selection is `settings.runnerMode`:
 *   - 'host'    (default) every step on the host. Nothing changes.
 *   - 'sandbox' every step in a container; a run whose image is missing falls
 *               back to the host and says so in its record.
 *   - 'policy'  the risk policy decides (shared/utils/riskPolicy.ts, in
 *               flight on another branch): `sandbox: required` for the run's
 *               blast radius means a container, anything else the host. With
 *               no policy module on this build, 'policy' behaves as 'host'.
 *
 * `selectRunner` is pure so the mapping is tested without Docker
 * (scripts/test-runner-selection.mjs).
 */
import { agentManagerSettings, envString } from '../appSettings.ts'
import { createLogger } from '../log.ts'
import { sandboxImageAvailable, type SandboxImage } from './sandbox.ts'

const log = createLogger('runner')

export type RunnerMode = 'host' | 'sandbox' | 'policy'
export const RUNNER_MODES: RunnerMode[] = ['host', 'sandbox', 'policy']

/** What the risk policy says about a tier, as riskPolicy.ts spells it. */
export type SandboxRequirement = 'required' | 'preferred' | 'optional'

/** What a run records about where its steps ran. Absent: the host. */
export interface RunSandbox {
  image: string
  /** The image id Docker reported when the run started; absent when it could not be asked. */
  digest?: string
  egressProfile: string
}

export interface RunnerChoice {
  kind: 'host' | 'sandbox'
  /** One line for the log and the run record: why this, and not the other. */
  reason: string
}

/** The mode in force: AGENT_RUNNER_MODE (non-empty) over the saved setting over 'host'. */
export function runnerMode(): RunnerMode {
  const raw = envString('AGENT_RUNNER_MODE') ?? agentManagerSettings().runnerMode
  return RUNNER_MODES.includes(raw as RunnerMode) ? raw as RunnerMode : 'host'
}

/**
 * The pure decision. `requirement` is what the risk policy demands for the
 * run's tier, or undefined when no policy is available; `imageAvailable` is
 * whether the sandbox image can be run right now.
 */
export function selectRunner(opts: {
  mode: RunnerMode
  requirement?: SandboxRequirement
  imageAvailable: boolean
}): RunnerChoice {
  const { mode, requirement, imageAvailable } = opts
  if (mode === 'host') return { kind: 'host', reason: 'runnerMode is host' }
  const wants = mode === 'sandbox' ? 'runnerMode is sandbox'
    : requirement === 'required' ? 'the risk policy requires a sandbox for this blast radius'
    : null
  if (!wants) {
    return {
      kind: 'host',
      reason: requirement
        ? `the risk policy marks a sandbox ${requirement} for this blast radius; only required selects one`
        : 'runnerMode is policy and no risk policy is available on this build',
    }
  }
  if (!imageAvailable) return { kind: 'host', reason: `${wants}, but the sandbox image is not available; falling back to the host` }
  return { kind: 'sandbox', reason: wants }
}

/**
 * The policy's sandbox column for a blast radius, when the risk policy module
 * exists on this build. Loaded by a computed path so a checkout without the
 * riskPolicy branch still typechecks and runs; the import then rejects and the
 * answer is undefined.
 */
export async function policySandboxRequirement(blastRadius: string | undefined): Promise<SandboxRequirement | undefined> {
  try {
    const name = 'riskPolicy.ts'
    const mod = await import(/* @vite-ignore */ `../../../shared/utils/${name}`) as {
      getRiskPolicy?: () => unknown
      DEFAULT_RISK_POLICY?: unknown
      tierFor?: (policy: unknown, radius: string | undefined) => { sandbox?: SandboxRequirement } | undefined
    }
    if (typeof mod.tierFor !== 'function') return undefined
    const policy = typeof mod.getRiskPolicy === 'function' ? mod.getRiskPolicy() : mod.DEFAULT_RISK_POLICY
    if (!policy) return undefined
    return mod.tierFor(policy, blastRadius)?.sandbox
  } catch {
    return undefined
  }
}

/**
 * Decides for one run and records the choice. Returns what the run stores as
 * `run.sandbox`: the image, its digest and the egress profile, or undefined
 * for the host. Never throws: a sandbox decision that fails is the host.
 */
export async function decideRunner(run: { id: string, blastRadius?: string, ticketKey?: string }): Promise<{ choice: RunnerChoice, sandbox?: RunSandbox }> {
  const mode = runnerMode()
  if (mode === 'host') return { choice: { kind: 'host', reason: 'runnerMode is host' } }
  let requirement: SandboxRequirement | undefined
  let image: SandboxImage | null = null
  try {
    if (mode === 'policy') requirement = await policySandboxRequirement(run.blastRadius)
    // Only asked when a sandbox could be chosen: `docker image inspect` is a
    // process spawn on every run start otherwise.
    if (mode === 'sandbox' || requirement === 'required') image = await sandboxImageAvailable()
  } catch (err) {
    log.warn('runner decision could not be made; using the host', { runId: run.id, error: err instanceof Error ? err.message : String(err) })
  }
  const choice = selectRunner({ mode, requirement, imageAvailable: image !== null })
  log.info('runner selected', { runId: run.id, ticketKey: run.ticketKey, mode, blastRadius: run.blastRadius ?? '(unclassified)', requirement: requirement ?? '(none)', runner: choice.kind, reason: choice.reason })
  if (choice.kind !== 'sandbox' || !image) return { choice }
  return { choice, sandbox: { image: image.name, ...(image.digest ? { digest: image.digest } : {}), egressProfile: image.egressProfile } }
}
