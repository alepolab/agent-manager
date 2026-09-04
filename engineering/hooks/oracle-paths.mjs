/**
 * Shared definition of "this path decides what the oracle asserts."
 *
 * Split out of test-lock.mjs so the PreToolUse deny hook (test-lock.mjs) and
 * the PostToolUse arm hook (test-lock-arm.mjs) use exactly one definition of
 * "oracle path" and "exempt path." Two copies of this regex would drift —
 * the arm hook could end up treating a test edit as a source edit (arming
 * the lock when nothing should be locked yet), or the deny hook could stop
 * recognising a path the arm hook still exempts. Neither hook has a `main()`
 * that runs on import, so both can import this freely.
 */

/** Paths whose contents decide what the oracle asserts. */
export const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|e2e|itest|robot)(\/|$)/i
export const TEST_FILE = /(\.test\.|\.spec\.|_test\.|test_[^/]*\.py$|\.robot$|\.feature$)/i
export const ORACLE_CONFIG = new RegExp(
  '(^|/)(' +
  'conftest\\.py|pytest\\.ini|tox\\.ini|' +
  'jest\\.config\\.[jt]s|jest\\.setup\\.[jt]s|vitest\\.config\\.[jt]s|setup-tests?\\.[jt]s|' +
  'playwright\\.config\\.[jt]s|karma\\.conf\\.js|' +
  '__mocks__|fixtures?|testdata' +
  ')(/|$)', 'i')

export const looksLikeOracle = (p) => !!p && (TEST_PATH.test(p) || TEST_FILE.test(p) || ORACLE_CONFIG.test(p))

/**
 * Paths both the plan gate (plan-gate.mjs) and the test lock exempt from
 * their own control: the control's own state under .agent/, and a workflow
 * run's evidence artifacts (CLAUDE_DIR/workflow-runs/<id>/artifacts, outside
 * any project, so no per-repo state could ever cover them). Kept narrow —
 * both path segments, in order — so a source file whose name merely
 * resembles the artifacts path stays covered.
 */
export const isExemptPath = (p) => {
  if (!p) return false
  if (p.includes('.agent/')) return true
  if (/[\\/]workflow-runs[\\/][^\\/]+[\\/]artifacts[\\/]/.test(p)) return true
  return false
}
