/**
 * Which branch a run starts from, and where its pull request goes, from the
 * kind of work and where the defect was found. The team's standard flow:
 *
 *   - a task or a bug found in development: from `develop`, promoted
 *     develop -> ci-release -> main;
 *   - a bug found in production (a customer or support incident): a hotfix
 *     from `main`, merged back into ci-release and develop afterwards;
 *   - a bug found by QA or CI on a release candidate: a hotfix from
 *     `ci-release`, merged back into develop afterwards.
 *
 * A product's registry entry may name its own branches (`bug`, `feature`,
 * `infra`, and optionally `hotfix`, `qa`, `release`); the defaults above apply
 * where it does not.
 */
export type WorkOrigin = 'production' | 'qa' | 'development'

export interface BranchChoice {
  /** The branch the run branch is cut from and the pull request targets. */
  base: string
  /** One sentence for the run header and the PR body. */
  reason: string
  /** Branches the base must be merged into after the pull request lands, in order; empty when promotion carries it. */
  mergeBack: string[]
}

const HOTFIX_KINDS = new Set(['bug', 'security', 'infra'])

export function baseBranchFor(workType: string | undefined, origin: string | undefined, branches: Record<string, string> = {}): BranchChoice {
  const develop = branches.feature ?? branches.bug ?? 'develop'
  const release = branches.release ?? branches.qa ?? 'ci-release'
  const main = branches.hotfix ?? branches.production ?? 'main'
  const kind = workType ?? 'bug'
  if (origin === 'production' && HOTFIX_KINDS.has(kind)) {
    return { base: main, reason: `a ${kind} found in production is a hotfix from ${main}`, mergeBack: [release, develop].filter((b, i, a) => b !== main && a.indexOf(b) === i) }
  }
  if (origin === 'qa' && HOTFIX_KINDS.has(kind)) {
    return { base: release, reason: `a ${kind} found by QA or CI on the release candidate is a hotfix from ${release}`, mergeBack: [develop].filter(b => b !== release) }
  }
  const base = branches[kind] ?? develop
  return { base, reason: `a ${kind}${origin ? ` found in ${origin}` : ''} starts from ${base} and is promoted with the next release`, mergeBack: [] }
}

/** The sentence the run header carries so every step and the PR body say the same thing. */
export function describeBranchChoice(branch: string, choice: BranchChoice): string {
  const back = choice.mergeBack.length
    ? ` After it merges, ${choice.base} is merged into ${choice.mergeBack.join(' and then ')}; say so in the pull request body.`
    : ''
  return `Run branch ${branch} was cut from origin/${choice.base}: ${choice.reason}. The pull request targets ${choice.base}.${back}`
}
