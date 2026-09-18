/**
 * Driving the infra repo's `deploy/ansible/deploy.sh`, with the dangerous
 * environments gated.
 *
 * That script is the one integration surface for deployment - its own header
 * says Jenkins, a person and an agent drive it identically - and agent-manager
 * knew nothing about it. So an agent asked "is my fix actually on dev?" had no
 * way to look, and an agent that decided to look would invent flags. The same
 * class of mistake as the compose commands: a guess at an unseen interface.
 *
 * WHY THIS IS GATED RATHER THAN SIMPLY WIRED
 *
 * `--env prod` exists. A local `compose down` that keeps its volumes is
 * recoverable; a deploy to a carrier's environment is not. So anything other
 * than `dev` must have passed a human approval gate before a single argument is
 * assembled, and that rule is enforced HERE, where the command is built -
 * not only in the interface that decides whether to show a button. A control
 * the UI declines to draw is still reachable by whatever calls this next.
 *
 * WHAT IS NEVER INVENTED
 *
 *  - The environment list and the step list come from the published contract,
 *    or from `VALID_ENVS` in the script itself. A wrong step name is a deploy
 *    that does nothing and reports success.
 *  - The secrets path comes from configuration. `deploy.sh`'s own usage shows
 *    `--secrets` for prod, and a guessed path is a deploy that fails after
 *    ansible has already started changing things.
 *  - `--yes` is added only when a person approved at the gate. It is a consent
 *    flag, and asserting consent nobody gave is the worst thing this file could
 *    do.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'
import { defaultInfraDir } from './stackRecipe.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

/** The only environment an agent may touch without a person saying yes. */
const UNATTENDED_ENV = 'dev'

export class DeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeployError'
  }
}

export interface DeployPlan {
  infraDir: string
  /** The infra repo's own entrypoint - never an ansible-playbook line assembled here. */
  command: string
  args: string[]
  env: string
  step: string
  check: boolean
  /** True for every environment except dev. */
  requiresApproval: boolean
  /** Configured secrets path, or null when none is configured. */
  secrets: string | null
  /** Where the environment list came from, so a reader can tell. */
  source: 'contract' | 'deploy.sh'
}

export type ExecLike = (cmd: string, args: string[]) => Promise<string>

const realExec: ExecLike = async (cmd, args) => {
  // A real deploy is minutes: image pulls, liquibase, a rolling restart.
  const { stdout } = await execFileP(cmd, args, { timeout: 60 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  return stdout
}

let injectedExec: ExecLike | null = null
/** Test seam, matching stackLifecycle.setStackExec. */
export function setDeployExec(fn: ExecLike | null) { injectedExec = fn }

/** The secrets file configured for an environment, or null. Never a guess. */
export function configuredSecrets(env: string): string | null {
  const specific = process.env[`ALEPO_DEPLOY_SECRETS_${env.toUpperCase()}`]
  return specific?.trim() || null
}

async function environmentsAndSteps(infraDir: string, script: string): Promise<{
  environments: string[]
  steps: string[]
  source: 'contract' | 'deploy.sh'
}> {
  // The published contract first: it is generated from this script and
  // drift-gated by the infra repo's CI.
  const contractPath = join(infraDir, 'agent', 'stack-contract.json')
  if (existsSync(contractPath)) {
    try {
      const doc = JSON.parse(await readFile(contractPath, 'utf-8'))
      const envs = doc?.deploy?.environments
      const steps = doc?.deploy?.steps
      if (Array.isArray(envs) && envs.length) {
        return { environments: envs.map(String), steps: Array.isArray(steps) ? steps.map(String) : [], source: 'contract' }
      }
    } catch {
      // Fall through to the script: an unreadable contract must not stop a
      // deploy that the script itself can still describe.
    }
  }

  const text = await readFile(script, 'utf-8')
  const envs = text.match(/^VALID_ENVS="([^"]+)"/m)?.[1]?.split(/\s+/).filter(Boolean) ?? []
  const steps = text.match(/^VALID_STEPS="([^"]+)"/m)?.[1]?.split(/\s+/).filter(Boolean) ?? []
  if (!envs.length) {
    throw new DeployError(
      `Could not read VALID_ENVS from ${script}, so there is no way to know which environments exist. `
      + 'Refusing to guess one.',
    )
  }
  return { environments: envs, steps, source: 'deploy.sh' }
}

/**
 * Build the exact command, or refuse with the real list.
 *
 * Planning is separate from running so the gate can be decided - and shown to a
 * person - before anything executes.
 */
export async function planDeploy(opts: {
  env: string
  step: string
  infraDir?: string
  app?: string
  limit?: string
  check?: boolean
  secrets?: string
}): Promise<DeployPlan> {
  const infraDir = opts.infraDir ?? defaultInfraDir()
  if (!existsSync(infraDir)) {
    throw new DeployError(
      `The infra checkout is not at ${infraDir}, so nothing can be deployed. `
      + 'Clone alepo-dev-team-infra there, or set ALEPO_INFRA_DIR.',
    )
  }
  const script = join(infraDir, 'deploy', 'ansible', 'deploy.sh')
  if (!existsSync(script)) {
    throw new DeployError(`${script} does not exist, so this checkout has no deploy entrypoint.`)
  }

  const { environments, steps, source } = await environmentsAndSteps(infraDir, script)
  if (!environments.includes(opts.env)) {
    throw new DeployError(
      `"${opts.env}" is not an environment this repo deploys to. It has: ${environments.join(', ')}.`,
    )
  }
  if (steps.length && !steps.includes(opts.step)) {
    throw new DeployError(
      `"${opts.step}" is not a step deploy.sh accepts. It has: ${steps.join(', ')}.`,
    )
  }

  const check = opts.check === true
  const requiresApproval = opts.env !== UNATTENDED_ENV
  const secrets = opts.secrets?.trim() || configuredSecrets(opts.env)

  // Flag order follows deploy.sh's own usage block.
  const args = ['--step', opts.step, '--env', opts.env]
  if (opts.app) args.push('--app', opts.app)
  if (opts.limit) args.push('--limit', opts.limit)
  if (check) args.push('--check')
  if (secrets) args.push('--secrets', secrets)

  return { infraDir, command: script, args, env: opts.env, step: opts.step, check, requiresApproval, secrets, source }
}

export interface DeployResult {
  ok: boolean
  ran: string[]
  summary: string
}

/**
 * Run a planned deploy, if it is allowed to run.
 *
 * `approved` is the answered gate, passed by the caller that owns the run. The
 * check is here rather than only at the call site because this is the last
 * place before ansible starts, and it is the only place that cannot be bypassed
 * by a new caller.
 */
export async function runDeploy(
  plan: DeployPlan,
  opts: { approved: boolean, approvedBy?: string, exec?: ExecLike },
): Promise<DeployResult> {
  if (plan.requiresApproval && !opts.approved) {
    return {
      ok: false,
      ran: [],
      summary: `Refused: deploying to ${plan.env} needs a person's approval and this run has none. `
        + `Only ${UNATTENDED_ENV} proceeds unattended. Nothing was executed - `
        + 'put this behind an approval gate in the workflow, answer it, and run again.',
    }
  }
  // Non-dev without a secrets file would fail partway through ansible rather
  // than before it, which is the worst moment to find out.
  if (plan.requiresApproval && !plan.secrets) {
    return {
      ok: false,
      ran: [],
      summary: `Refused: deploying to ${plan.env} needs a secrets file and none is configured. `
        + `Set ALEPO_DEPLOY_SECRETS_${plan.env.toUpperCase()} to its path. `
        + 'No path was invented, because a wrong one fails after ansible has started changing things.',
    }
  }

  const exec = opts.exec ?? injectedExec ?? realExec
  // `--yes` is consent, so it is added here and only with an answered gate -
  // never in the plan, where it could be shown to a person as though it were
  // part of what they were approving.
  const args = opts.approved && plan.requiresApproval && !plan.check ? [...plan.args, '--yes'] : [...plan.args]
  const ran = [`${plan.command} ${args.join(' ')}`]

  try {
    const stdout = await exec(plan.command, args)
    const who = opts.approvedBy ? ` Approved by ${opts.approvedBy}.` : ''
    log.info('deploy ran', { env: plan.env, step: plan.step, check: plan.check, approvedBy: opts.approvedBy })
    return {
      ok: true,
      ran,
      summary: `${plan.step} on ${plan.env}${plan.check ? ' (--check, nothing changed)' : ''} finished.${who} `
        + `Output: ${stdout.split('\n').filter(Boolean).slice(-3).join(' | ') || '(none)'}`,
    }
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join(' ')
    log.warn('deploy failed', { env: plan.env, step: plan.step, error: why })
    return { ok: false, ran, summary: `${plan.step} on ${plan.env} failed: ${why}` }
  }
}
