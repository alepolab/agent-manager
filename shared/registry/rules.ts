/**
 * What makes a product entry valid, as one rule set two callers share:
 * `server/utils/registryValidate.ts` refuses a bad save from the Products page,
 * and `engineering/scripts/validate-registry.mjs` fails CI on the same thing.
 *
 * Two implementations of these rules is the failure this file exists to
 * prevent: a save the UI accepts and CI later refuses is a change that looks
 * applied, routes runs, and then blocks the next unrelated pull request.
 *
 * Operates on an already-parsed object, never on YAML text, so each caller
 * keeps its own parser - the app uses the `yaml` package, the CI script its own
 * restricted reader.
 *
 * The distinction between the two severities is what a save does with them:
 *
 * - `error` refuses the write. The entry would route runs somewhere nothing can
 *   act on: a clone that fails, a merge order that cannot be produced, an ATDD
 *   verdict that cannot be read, an approver nobody can name.
 * - `warning` saves and is shown. Every product in the shipped registry emits
 *   at least one today (none declares a Liquibase tag), so treating these as
 *   refusals would make the registry unsavable from the page that edits it.
 */

export type Severity = 'error' | 'warning'
export interface Problem { where: string, message: string, severity: Severity }

/** The blast-radius labels, least to most severe. Exported for the owners form. */
export const OWNER_LABELS = ['docs', 'ui_parsing', 'schema', 'protocol', 'money'] as const

/** Owners that must name a real group: neither is ever auto-merged. */
const MUST_NAME_AN_APPROVER = ['money', 'protocol'] as const

/**
 * The semantic rules for one product - everything the JSON Schema cannot say.
 * `key` is the product's registry key, used only to build `where`.
 */
export function productProblems(key: string, p: any): Problem[] {
  const out: Problem[] = []
  const where = `products.${key}`
  const error = (message: string) => out.push({ where, message, severity: 'error' })
  const warning = (message: string) => out.push({ where, message, severity: 'warning' })

  // A bug branch template referencing {version} needs somewhere to get it.
  if (typeof p?.branches?.bug === 'string' && p.branches.bug.includes('{version}') && !p.version_source) {
    error('branches.bug uses {version} but the product declares no version_source')
  }
  // Forward-porting only means something when bugs land on a release branch.
  if (p?.forward_port && !String(p?.branches?.bug ?? '').includes('{version}')) {
    warning('declares forward_port but its bug branch is not a release branch — the port would be a no-op')
  }
  // multi_repo is a claim the repo list has to support, in both directions.
  const repoCount = Array.isArray(p?.repos) ? p.repos.length : 0
  if (p?.multi_repo === true && repoCount < 2) {
    error('is marked multi_repo but lists fewer than two repos')
  }
  if (p?.multi_repo !== true && repoCount > 1) {
    error('lists several repos but is not marked multi_repo, so no merge order would be produced')
  }
  // Rollback between attempts is what makes three attempts safe.
  if (p?.stack?.liquibase !== true) {
    warning('has no Liquibase tag, so a retry cannot roll the database back between attempts')
  }
  // An ATDD suite that does not emit xunit cannot be read as a verdict.
  if (p?.tests?.atdd && !/xunit/.test(String(p.tests.atdd))) {
    error('declares an atdd command that does not emit xunit; the loop would have to grep logs')
  }
  if (!p?.tests?.atdd && !p?.tests?.compose_test) {
    warning('has no atdd or compose_test suite, so only unit tests can serve as its oracle')
  }
  for (const label of MUST_NAME_AN_APPROVER) {
    if (label in (p?.owners ?? {}) && !String(p.owners[label] ?? '').trim()) {
      error(`owners.${label} is empty; a ${label} change would have no named approver`)
    }
  }
  // Placeholder repo names would clone-fail at the worst possible moment.
  for (const r of Array.isArray(p?.repos) ? p.repos : []) {
    if (/[<>]/.test(String(r))) error(`repo "${r}" is still a placeholder`)
  }
  return out
}
