import { checkTestLock } from './testLock.ts'
import { worldStateOf } from './worldState.ts'
import { derived, indeterminate, scoreGate, type Criterion, type CriterionResult } from '../../shared/utils/facts.ts'
import type { WorkflowRun } from '../../shared/types/run'

/**
 * The facts a gate can show the person answering it, derived rather than
 * narrated.
 *
 * A gate screen used to show the step's prose and a Continue button. The
 * criteria that were supposed to govern the decision lived in
 * phase-gates.md — around thirty of them, in markdown, evaluated by nobody —
 * and the reviewer was trusted to have applied them. This is the first
 * handful of them turned into facts with provenance, so the person is reading
 * "the diff says X, at commit Y" instead of "the agent says it checked X".
 *
 * Deliberately small. Every criterion here is one this repository can ALREADY
 * derive from code it already runs; nothing is stubbed, and a criterion with
 * no provider is absent rather than present-and-hopeful. The list grows as
 * providers are written, and until one exists the honest state is that the
 * gate does not check that thing — not that it checks it and passes.
 *
 * Never throws: a gate must still be answerable when this cannot run. It
 * returns `blocked` criteria instead, which scoreGate already treats as a
 * refusal rather than a pass.
 */
export async function criteriaForGate(run: WorkflowRun, dir: string | undefined): Promise<CriterionResult[]> {
  const now = await worldStateOf(dir)
  const criteria: Criterion[] = []

  // 1. The oracle is untouched since the run's baseline.
  //
  // The estate states this in the strongest words it uses anywhere: "A
  // modified test file is never a pass — it invalidates the run's entire
  // evidence chain, and no amount of subsequent green recovers it." It has a
  // real implementation, and until now its answer never reached the person
  // being asked to approve the change it protects.
  if (dir && run.baseCommit) {
    try {
      const lock = await checkTestLock({ dir, since: run.baseCommit })
      criteria.push({
        id: 'tests_unmodified',
        question: 'the tests that judge this change are unmodified since the run started',
        // `indeterminate` is carried across as itself. The test lock was
        // written with exactly this distinction — "unknown, never clean" — and
        // flattening it here would undo the control at the point it matters.
        fact: lock.indeterminate
          ? indeterminate<boolean>(`the diff could not be read, so this is unknown rather than clean: ${lock.why}`)
          : derived(lock.ok, {
              source: 'git diff + git status --porcelain',
              capturedAt: Date.now(),
              ...(now.head ? { head: now.head } : {}),
              ...(now.tree ? { tree: now.tree } : {}),
              // A git question answered once is answered: re-running it cannot
              // disagree with itself the way a test suite can.
              runs: 3,
            }),
        bar: { minRuns: 1 },
      })
      if (!lock.indeterminate && !lock.ok && lock.touched.length) {
        criteria.push({
          id: 'tests_touched',
          question: `no test file was changed (changed: ${lock.touched.slice(0, 5).join(', ')})`,
          fact: derived(false, {
            source: 'git diff + git status --porcelain',
            capturedAt: Date.now(),
            ...(now.head ? { head: now.head } : {}),
            ...(now.tree ? { tree: now.tree } : {}),
            runs: 3,
          }),
          bar: { minRuns: 1 },
        })
      }
    } catch (err) {
      criteria.push({
        id: 'tests_unmodified',
        question: 'the tests that judge this change are unmodified since the run started',
        fact: indeterminate<boolean>(`could not be checked: ${err instanceof Error ? err.message : String(err)}`),
      })
    }
  } else {
    criteria.push({
      id: 'tests_unmodified',
      question: 'the tests that judge this change are unmodified since the run started',
      fact: indeterminate<boolean>(run.baseCommit
        ? 'this run has no checkout to read'
        : 'this run recorded no baseline commit, so there is nothing to diff against'),
    })
  }

  // 2. Everything this run did is committed.
  //
  // shipIntegrity catches this at the end, which is the right place to catch
  // it and the wrong place to LEARN it: by then the reviewer has already said
  // yes. Uncommitted work is invisible to a reviewer and unreachable from a
  // pull request, so a gate answered over a dirty tree is a decision about
  // something nobody else can see.
  criteria.push({
    id: 'work_committed',
    question: 'every change this run made is committed, so a reviewer can actually fetch it',
    fact: now.tree === undefined
      ? indeterminate<boolean>('the working tree could not be read')
      : derived(now.tree === CLEAN_TREE, {
          source: 'git status --porcelain',
          capturedAt: Date.now(),
          ...(now.head ? { head: now.head } : {}),
          tree: now.tree,
          runs: 3,
        }),
    bar: { minRuns: 1 },
  })

  return scoreGate(criteria, now).results
}

/**
 * The digest of an empty porcelain listing.
 *
 * Computed once here rather than special-cased inside worldStateOf, which has
 * one job: report what the tree is, not judge whether that is good.
 */
import { createHash } from 'node:crypto'
const CLEAN_TREE = createHash('sha256').update('').digest('hex')
