/**
 * The fix must not edit the test that judges it.
 *
 * One step of a run owns the tests: the step that reproduces the defect and
 * writes the failing test, marked `testsUnlocked` in the template. Every step
 * after it is supposed to leave that test alone, and the estate states the
 * reason in the strongest words it uses anywhere - "A modified test file is
 * never a pass - it invalidates the run's entire evidence chain, and no amount
 * of subsequent green recovers it"
 * (.agents/workflows/runbook-a/resources/phase-gates.md:119-121).
 *
 * That rule had no implementation. The unlock file is written into the run's
 * worktree and never removed, nothing read the diff, and the CSUP template told
 * the reader the opposite was guaranteed - so nobody looked. A fix agent that
 * softens the failing test turns every green after it into a green about
 * nothing, and it is the one failure that voids every other control in the
 * pipeline at once.
 *
 * So this reads the repository, not an agent's report: what the checkout
 * actually contains after a step ran. Three deliberate positions:
 *
 *  - A DELETED test is a violation, not an absence. Removing the test is the
 *    quietest way to make a suite green.
 *  - UNCOMMITTED edits count. A step that leaves the softened test in the
 *    working tree has still softened it, and a check that reads only commits
 *    would call that clean.
 *  - AN UNREADABLE DIFF IS NOT A PASS. It is `indeterminate`, which a caller
 *    must treat as "unknown" rather than "fine" - the alternative is a broken
 *    git invocation silently licensing every subsequent step.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * A path that holds a test which judges a change.
 *
 * Kept deliberately narrow at the edges: `docs/testing.md` is documentation
 * ABOUT testing and must never fail a step, and `src/testUtils/helper.ts` is a
 * helper rather than a judging assertion. Both were live cases in this estate.
 */
const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)src\/test\//i,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//i,
  /(^|\/)e2e\//i,
  /(^|\/)spec\//i,
  /[.-](test|spec)\.[cm]?[jt]sx?$/i,
  /[.-](test|spec)\.(java|kt|py|rb|go)$/i,
  /Test\.java$/,
  /Tests\.java$/,
  /(^|\/)test-[^/]+\.[cm]?js$/i,
  /\.smoke\.[cm]?js$/i,
  /(^|\/)test_[^/]+\.py$/i,
]

/**
 * The checkout's current HEAD, or null when it cannot be read.
 *
 * Lives here rather than in the runner so the only module shelling out to git
 * for this control is the one that owns it. Null rather than a throw: a step
 * whose checkout has no commits yet must still run, and `checkTestLock` reports
 * an unreadable range as indeterminate anyway.
 */
export async function headOf(dir: string, exec?: TestLockInput['exec']): Promise<string | null> {
  try {
    const out = await (exec ?? realExec)('git', ['rev-parse', 'HEAD'], { cwd: dir })
    return out.trim() || null
  } catch {
    return null
  }
}

/** The subset of `paths` that are tests judging the change. */
export function testPathsIn(paths: string[]): string[] {
  return (paths ?? []).filter((p) => {
    if (!p) return false
    // A helper directory is not a judging test; the name only looks like one.
    if (/(^|\/)test(Utils|Helpers?|Data|Fixtures?|Support)\//i.test(p)) return false
    if (/\.(md|markdown|txt|rst|adoc)$/i.test(p)) return false
    return TEST_PATH_PATTERNS.some(re => re.test(p))
  })
}

export interface TestLockVerdict {
  ok: boolean
  /** Test files the range touched, reported even when the step was allowed to. */
  touched: string[]
  /** True when the diff could not be computed - "unknown", never "clean". */
  indeterminate: boolean
  why: string
}

export interface TestLockInput {
  /** The checkout to inspect - the run worktree or a lane. */
  dir: string
  /** The commit the step started from. */
  since: string
  /** True for the step that owns the tests; it may write them. */
  testsUnlocked?: boolean
  exec?: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>
}

const realExec = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
  const { stdout } = await execFileP(cmd, args, { cwd: opts?.cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * Whether the lock held across `since..working tree` in `dir`.
 *
 * Both halves are read: committed changes in the range AND the current working
 * tree, because a step that never committed its edit has still made it.
 */
export async function checkTestLock(input: TestLockInput): Promise<TestLockVerdict> {
  const exec = input.exec ?? realExec
  const paths = new Set<string>()

  try {
    // Committed in the range. `--diff-filter` is deliberately absent: a deleted
    // test must count, and the default includes D.
    const committed = await exec('git', ['diff', '--name-only', `${input.since}..HEAD`], { cwd: input.dir })
    for (const p of committed.split('\n').map(s => s.trim()).filter(Boolean)) paths.add(p)
    // Everything still uncommitted, tracked or not.
    const dirty = await exec('git', ['status', '--porcelain'], { cwd: input.dir })
    for (const line of dirty.split('\n').map(s => s.trim()).filter(Boolean)) {
      const p = line.slice(2).trim().split(' -> ').pop()
      if (p) paths.add(p)
    }
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim()
    return {
      ok: false,
      touched: [],
      indeterminate: true,
      why: `could not compute the diff from ${input.since} in ${input.dir} - ${why}. Treat this as unknown, not as a pass.`,
    }
  }

  const touched = testPathsIn([...paths]).sort()

  if (input.testsUnlocked) {
    return {
      ok: true,
      touched,
      indeterminate: false,
      why: touched.length
        ? `this step owns the tests (testsUnlocked), so writing ${touched.length} test file(s) is its job: ${touched.join(', ')}`
        : 'this step owns the tests (testsUnlocked) and wrote none',
    }
  }

  if (touched.length === 0) {
    return { ok: true, touched, indeterminate: false, why: 'no test files were touched by this step' }
  }

  return {
    ok: false,
    touched,
    indeterminate: false,
    why: `this step modified ${touched.length} test file(s) it does not own (${touched.join(', ')}). `
      + 'A modified test is never a pass: it invalidates the run\'s evidence chain, and no amount of subsequent green recovers it.',
  }
}
