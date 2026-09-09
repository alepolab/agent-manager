/**
 * A workflow's declared inputs, and the one function that turns a declaration
 * plus whatever the caller supplied into the values a run actually carries.
 *
 * Pure and I/O-free on purpose, for the same reason workflowGraph.ts is: the
 * server resolves parameters at start time, the dispatch step resolves a
 * child's against its parent's, and scripts/test-workflow-parameters.mjs
 * drives it under plain node with nothing loaded.
 */

/**
 * The one parameter name the runner acts on rather than merely stating.
 *
 * A run already has a working directory - `WorkflowRun.projectDir`, which
 * `artifactHeader` states to every step as `Work in:` and `Working checkout:`.
 * A workflow that declared its own `repo_path` would therefore be naming the
 * same thing twice, in two places that can disagree, and an agent handed a
 * contradiction picks one arbitrarily. So exactly one name binds: a declared
 * `projectDir` SUPPLIES run.projectDir, and there is still only one answer to
 * "where does this run work".
 */
export const RESERVED_PARAM_PROJECT_DIR = 'projectDir'

/** A name a workflow may declare: an identifier, so it reads as one token in a prompt. */
const VALID_NAME = /^[a-z][A-Za-z0-9_]*$/

export interface WorkflowParameter {
  /** Identifier, `[a-z][A-Za-z0-9_]*`. See RESERVED_PARAM_PROJECT_DIR for the one name that binds. */
  name: string
  description?: string
  required?: boolean
  default?: string
}

export interface ResolvedParameters {
  /** Declared names only, trimmed, empties dropped. Safe to state to an agent as fact. */
  values: Record<string, string>
  /** Declared, required, and left with nothing - named so the caller can say which. */
  missing: string[]
}

export function isValidParameterName(name: string): boolean {
  return VALID_NAME.test(name)
}

/**
 * Applies each declaration's default, trims, and keeps ONLY what the workflow
 * declared.
 *
 * Dropping undeclared keys is the property the whole feature rests on. It is
 * what lets a parent run hand its entire parameter map to a child workflow
 * (see runDispatchStep) and have the child keep only its own inputs: without
 * it, a child's step header would state a scan's severity floor as a fact
 * nothing in that workflow asked for, and an agent given facts it cannot use
 * acts on them anyway.
 *
 * Whitespace is not a value. A required parameter supplied as "   " is
 * missing, because a header line reading `severity: ` teaches an agent
 * nothing and is worse than a 400 telling the operator to fill it in.
 */
export function resolveParameters(
  declared: WorkflowParameter[] | undefined,
  supplied: Record<string, string> | undefined,
): ResolvedParameters {
  const values: Record<string, string> = {}
  const missing: string[] = []

  for (const param of declared ?? []) {
    const name = param.name?.trim()
    if (!name) continue
    // A blank supplied value falls back to the default rather than overriding
    // it with nothing. The modal prefills each field WITH the default, so
    // clearing one would otherwise mean "this parameter has no value" for a
    // parameter whose declaration says what its value should be - and a
    // default that a cleared field silently defeats is not a default.
    const supplied_ = supplied?.[name]
    const value = (typeof supplied_ === 'string' && supplied_.trim() ? supplied_ : param.default ?? '').trim()
    if (value) values[name] = value
    else if (param.required) missing.push(name)
  }

  return { values, missing }
}
