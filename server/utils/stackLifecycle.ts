/**
 * Starting and stopping a product's stack, as the runner's job rather than the
 * agent's.
 *
 * The commands here are exactly the ones the infra repo documents for itself
 * (`docs/crm-installation-guide.md`, `README.md`): `docker compose -f <file>
 * --profile <p> --env-file .env up` for the one-shot stages and `up -d` for the
 * services. Flag order included. Nothing is invented - the first draft of the
 * test for this file expected `--abort-on-container-failure`, a flag compose
 * does not have, which is exactly the class of mistake an agent makes when it
 * has to guess at a command it cannot see.
 *
 * Two rules, both from the person who owns the box:
 *
 *  - TEARDOWN NEVER REMOVES VOLUMES. `down`, never `down -v`. Seeded data
 *    survives a run, and nothing gets a clean database by accident. There is
 *    deliberately no option to opt into the destructive form: a flag like that
 *    is passed by mistake exactly once.
 *  - THE `.env` IS READ, NEVER WRITTEN. It comes from a human running
 *    `setup.sh`; `stackRecipe.ts` refuses to proceed without it.
 *
 * A failed migration stops the sequence: a stack serving a half-migrated
 * database is worse than no stack, because it looks like it works.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from './log.ts'
import { labelEnv } from './dockerReap.ts'
import type { StackRecipe } from './stackRecipe.ts'

const log = createLogger('runner')
const execFileP = promisify(execFile)

/**
 * `env` carries the run id to the docker child, and only ever adds to the
 * process environment - see dockerReap.ts for why a compose stack cannot be
 * labelled with a flag, and what a compose file has to do to pick this up.
 * Optional, so every existing caller and test seam is unchanged.
 */
export type ExecLike = (cmd: string, args: string[], env?: Record<string, string>) => Promise<string>

const realExec: ExecLike = async (cmd, args, env) => {
  // Generous: a first `up` pulls images, and a liquibase stage on a real
  // schema is minutes rather than seconds.
  const { stdout } = await execFileP(cmd, args, {
    timeout: 30 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return stdout
}

let injectedExec: ExecLike | null = null
/**
 * Test seam, matching `ciPoller.setCheckReader` and
 * `reviewComments.setReviewReaders`. The runner calls `stackUp`/`stackDown`
 * without an exec, so this is how a test drives the real code path without
 * starting a single container. Pass null to restore.
 */
export function setStackExec(fn: ExecLike | null) { injectedExec = fn }

export interface StackResult {
  ok: boolean
  /** One line per command actually run, in order. */
  ran: string[]
  summary: string
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join(' ').trim()

/** The documented argument order, not a rearrangement of it. */
function upArgs(recipe: StackRecipe, profile: string, detach: boolean): string[] {
  const args = ['compose', '-f', recipe.composePath, '--profile', profile, '--env-file', recipe.envFile, 'up']
  if (detach) args.push('-d')
  return args
}

/**
 * Bring the stack up: init, then migrations, then the services.
 *
 * Stages the compose file does not declare are skipped rather than faked, and
 * the summary says which - a product with no liquibase profile genuinely has no
 * migrations, and inventing a command for it would fail confusingly.
 */
export async function stackUp(recipe: StackRecipe, opts: { exec?: ExecLike, runId?: string } = {}): Promise<StackResult> {
  const exec = opts.exec ?? injectedExec ?? realExec
  const ran: string[] = []
  // Whose stack this is. 150 GB of containers, images and build cache leaked
  // because nothing said; dockerReap.ts removes only what this marks.
  const env = opts.runId ? labelEnv(opts.runId) : undefined

  for (const stage of recipe.stages) {
    const args = upArgs(recipe, stage.profile, stage.detach)
    ran.push(`docker ${args.join(' ')}`)
    try {
      await exec('docker', args, env)
    } catch (err) {
      const why = message(err)
      log.warn('stack stage failed', { product: recipe.product, profile: stage.profile, error: why })
      return {
        ok: false,
        ran,
        summary: `${recipe.product}: the ${stage.profile} stage failed - ${why}. `
          + 'The remaining stages were not run: a stack serving a half-migrated database is worse than no stack.',
      }
    }
  }

  const skipped = recipe.missingStages.length
    ? ` No ${recipe.missingStages.join(' or ')} stage is declared for this product, so none was run.`
    : ''
  log.info('stack up', { product: recipe.product, stages: recipe.stages.map(s => s.profile) })
  return {
    ok: true,
    ran,
    summary: `${recipe.product} is up via ${recipe.composeFile} (${recipe.stages.map(s => s.profile).join(' -> ')}).${skipped}`,
  }
}

/**
 * Take the stack down, keeping its data.
 *
 * Every profile is named, including the one-shot ones: `down` scoped to a
 * single profile leaves the init and liquibase containers behind, and a box
 * accumulating those is how the next run fails for a reason nobody can find.
 */
export async function stackDown(recipe: StackRecipe, opts: { exec?: ExecLike, runId?: string } = {}): Promise<StackResult> {
  const exec = opts.exec ?? injectedExec ?? realExec
  const args = ['compose', '-f', recipe.composePath, '--env-file', recipe.envFile]
  for (const stage of recipe.stages) args.push('--profile', stage.profile)
  args.push('down')

  const ran = [`docker ${args.join(' ')}`]
  try {
    // Same environment as the `up`: a compose file that interpolated the run id
    // into a label must resolve it the same way here, or `down` sees a
    // different project than the one that was started.
    await exec('docker', args, opts.runId ? labelEnv(opts.runId) : undefined)
  } catch (err) {
    const why = message(err)
    log.warn('stack down failed', { product: recipe.product, error: why })
    return {
      ok: false,
      ran,
      summary: `${recipe.product}: taking the stack down failed - ${why}. It may still be running; check with docker ps.`,
    }
  }
  log.info('stack down', { product: recipe.product })
  return {
    ok: true,
    ran,
    summary: `${recipe.product} is down. Volumes were kept, so its data and seed survive.`,
  }
}
