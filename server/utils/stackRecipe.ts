/**
 * How to bring one product's stack up, read from the infra repo rather than
 * remembered here.
 *
 * The runner used to tell an agent one thing - "Stack: alepo-dev-team-infra/crm
 * (1node)" - and leave it to work out which compose file, which profile,
 * whether an init stage runs first, whether migrations are a separate command,
 * and which `--env-file`. Every agent solved that puzzle again, differently, and
 * nothing owned taking the stack down afterwards.
 *
 * The answer was already written down: every product's compose file in
 * alepo-dev-team-infra declares its own profiles - `<p>-stack`, `<p>-init`,
 * `<p>-liquibase`, plus the liquibase ops variants that share their logic
 * through `compose/liquibase-ops.yml`. So this module READS those profiles and
 * derives the lifecycle from them.
 *
 * That is the load-bearing decision. A table of profile names kept in
 * agent-manager would be a second copy of the infra repo's contract, and it
 * would drift the first time a product gained a stage. Reading means a new
 * stage is supported with no change here, and a product missing one is
 * reported rather than having a command invented for it.
 *
 * Nothing in this file writes anything. The `.env` is a human's artifact,
 * produced once by `setup.sh` interactively; the runner reads it and never
 * generates, edits or guesses at it.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The infra checkout that owns every product's compose file.
 *
 * Read on every call rather than captured at import: a module-level constant
 * freezes whatever the environment happened to be when the first import ran,
 * which makes ALEPO_INFRA_DIR silently ineffective for anything that sets it
 * later - a test, or a server that resolves its config after boot. That exact
 * mistake cost the first attempt at this feature a debugging round.
 */
export function defaultInfraDir(): string {
  return process.env.ALEPO_INFRA_DIR
    || join(process.env.HOME ?? '', 'alepo-workspace', 'alepo-dev-team-infra')
}

export class StackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StackError'
  }
}

export type StageKind = 'init' | 'liquibase' | 'stack'

export interface StackStage {
  kind: StageKind
  profile: string
  /** The services stay up; the one-shot stages must finish before the next. */
  detach: boolean
}

export interface StackRecipe {
  product: string
  infraDir: string
  composeFile: string
  composePath: string
  envFile: string
  /** Every profile the compose file declares, including ones never run. */
  profilesDeclared: string[]
  /** The stages to run, in order. */
  stages: StackStage[]
  /** Stage kinds this product's compose file does not declare. */
  missingStages: StageKind[]
}

/**
 * The stages of bringing a stack up, in the order the infra repo's own guides
 * run them: init extracts config and the changelog, liquibase migrates, then
 * the services start.
 *
 * `-liquibase-rollback` and `-liquibase-dryrun` exist in the same files and are
 * deliberately absent: a rollback is an operator's decision and must never be a
 * side effect of starting a stack.
 */
const STAGE_ORDER: { kind: StageKind, suffix: string, detach: boolean }[] = [
  { kind: 'init', suffix: '-init', detach: false },
  { kind: 'liquibase', suffix: '-liquibase', detach: false },
  { kind: 'stack', suffix: '-stack', detach: true },
]

/** Every `profiles:` value in a compose file, however it was written.
 *
 *  Deliberately a scan rather than a YAML parse: the compose files use anchors,
 *  aliases and `extends`, and a parser strict enough to be correct about those
 *  is a parser that fails on a file docker itself accepts. The only thing
 *  needed here is the set of profile names, and those are plain strings. */
function profilesIn(text: string): string[] {
  const found = new Set<string>()
  const re = /profiles:\s*(?:\[([^\]]*)\]|((?:\s*\n\s*-\s*[^\s#]+)+))/g
  for (const m of text.matchAll(re)) {
    const inline = m[1]
    const block = m[2]
    const raw = inline !== undefined
      ? inline.split(',')
      : (block ?? '').split('\n').map(l => l.replace(/^\s*-\s*/, ''))
    for (const item of raw) {
      const name = item.trim().replace(/^["']|["']$/g, '')
      if (name) found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * The recipe for a product's stack.
 *
 * `compose` is the registry's own value (`engineering/registry/products.yaml`,
 * e.g. `alepo-dev-team-infra/crm`): a repo and a product, not a filename. The
 * filename is derived from the product because that is the infra repo's
 * convention, and the file is then read - so a wrong guess surfaces here as a
 * named missing file rather than as a docker error halfway through a run.
 */
export async function resolveStackRecipe(opts: {
  compose: string
  infraDir?: string
}): Promise<StackRecipe> {
  const infraDir = opts.infraDir ?? defaultInfraDir()
  const product = opts.compose.split('/').filter(Boolean).pop() ?? ''
  if (!product) {
    throw new StackError(`The registry's stack reference "${opts.compose}" names no product, so there is nothing to bring up.`)
  }
  if (!existsSync(infraDir)) {
    throw new StackError(
      `The infra checkout is not at ${infraDir}, so no stack can be started. `
      + 'Clone alepo-dev-team-infra there, or set ALEPO_INFRA_DIR.',
    )
  }

  const composeFile = `docker-compose.${product}.yml`
  const composePath = join(infraDir, composeFile)
  if (!existsSync(composePath)) {
    throw new StackError(
      `${composeFile} does not exist in ${infraDir}, so "${product}" has no stack to start. `
      + 'The registry names the product; the infra repo owns the compose file.',
    )
  }

  // The env file is a human's artifact: setup.sh generates it interactively and
  // the runner only ever reads it. Saying so here is better than a compose run
  // failing on unset variables halfway through.
  const envFile = join(infraDir, '.env')
  if (!existsSync(envFile)) {
    throw new StackError(
      `${envFile} does not exist. It is generated once by running ./setup.sh in the infra checkout, `
      + 'which is interactive and a person\'s job - the runner reads that file and never writes it.',
    )
  }

  const profilesDeclared = profilesIn(await readFile(composePath, 'utf-8'))
  const stages: StackStage[] = []
  const missingStages: StageKind[] = []
  for (const { kind, suffix, detach } of STAGE_ORDER) {
    const profile = `${product}${suffix}`
    if (profilesDeclared.includes(profile)) stages.push({ kind, profile, detach })
    else missingStages.push(kind)
  }

  if (!stages.some(s => s.kind === 'stack')) {
    throw new StackError(
      `${composeFile} declares no "${product}-stack" profile, so there is nothing to bring up. `
      + `Profiles it does declare: ${profilesDeclared.join(', ') || 'none'}.`,
    )
  }

  return { product, infraDir, composeFile, composePath, envFile, profilesDeclared, stages, missingStages }
}
