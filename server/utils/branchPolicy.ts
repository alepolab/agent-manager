/**
 * Which branch a run starts from, and where its pull request goes, from the
 * kind of work and where the defect was found.
 *
 * Everything starts from `develop` and is promoted develop -> ci-release ->
 * main, a production or QA bug included. This used to cut a production bug
 * from `main` and a QA bug from `ci-release`, merging back afterwards, and
 * that is the flow Alepo's repositories forbid: lum-selfcare's CLAUDE.md says
 * "Never PR or push directly to `main`" and "Hotfixes go to `develop` first",
 * because a fix landed downstream of develop is lost on the next promotion
 * unless someone remembers the merge-back (its PR #537). The merge-back was
 * only ever a sentence in a PR body, which is the step that gets forgotten.
 *
 * A product that really does hotfix from a release branch says so in its
 * registry entry: `hotfix` (or `production`) for production bugs, `qa` (or
 * `release`) for release-candidate bugs. Only then does a run cut from it and
 * name the merge-back. `bug`, `feature` and `infra` rename develop per kind.
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
  const release = branches.release ?? branches.qa
  const main = branches.hotfix ?? branches.production
  const kind = workType ?? 'bug'
  if (main && origin === 'production' && HOTFIX_KINDS.has(kind)) {
    return { base: main, reason: `a ${kind} found in production is a hotfix from ${main}`, mergeBack: [release ?? 'ci-release', develop].filter((b, i, a) => b !== main && a.indexOf(b) === i) }
  }
  if (release && origin === 'qa' && HOTFIX_KINDS.has(kind)) {
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
