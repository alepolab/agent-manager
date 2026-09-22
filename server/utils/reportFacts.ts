import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseReport, aggregate, type TestCase, type ReportFormat, type AggregateResult } from '../../shared/utils/testReport.ts'
import { derived, indeterminate, type Fact, type WorldState } from '../../shared/utils/facts.ts'

/**
 * Per-case facts from a product's declared test reports.
 *
 * The registry says where each test class writes a machine-readable report
 * and in what format; this reads them. Until a product declares one, there is
 * nothing here to read — which is the honest state, and why
 * `engineering/scripts/validate-registry.mjs` now reports that 22 of 23
 * products cannot be scored per case. That is a registry gap to fill, not a
 * check to fake.
 *
 * A read that fails produces `indeterminate`, never an empty pass. The estate
 * has made the opposite mistake twice and it cost human oversight both times.
 */

export interface CaseFacts {
  /** One aggregate per case id, across however many captures were supplied. */
  cases: Map<string, AggregateResult>
  /** Facts keyed by case id, ready to hand to a gate. */
  facts: Map<string, Fact<boolean>>
  /** Files actually read, for the provenance a reviewer checks. */
  files: string[]
}

export type ReadFile = (path: string) => Promise<string>

/**
 * Read one capture of a report set.
 *
 * A glob matches the files of ONE run — surefire writes a file per class — so
 * everything it matches is merged into a single capture. Several captures
 * mean the suite was run several times, which is the caller's job to arrange
 * and the reason `captures` is an array of glob results rather than a single
 * one.
 */
export async function readCapture(
  dir: string,
  pattern: string,
  format: ReportFormat,
  read: ReadFile = p => readFile(p, 'utf8'),
): Promise<{ ok: true, cases: TestCase[], files: string[], sha: string } | { ok: false, why: string }> {
  let matched: string[]
  try {
    matched = []
    for await (const entry of glob(pattern, { cwd: dir })) matched.push(entry)
  } catch (err) {
    return { ok: false, why: `could not search for \`${pattern}\`: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!matched.length) {
    // Nothing matched is NOT an empty suite. It usually means the run never
    // produced a report at all, and reading that as "no failures" is exactly
    // how a suite that never executed comes to look green.
    return { ok: false, why: `no file matched \`${pattern}\`, so this suite produced no report to read` }
  }

  const cases: TestCase[] = []
  const files: string[] = []
  const hash = createHash('sha256')
  for (const rel of matched.sort()) {
    let text: string
    try {
      text = await read(join(dir, rel))
    } catch (err) {
      return { ok: false, why: `could not read ${rel}: ${err instanceof Error ? err.message : String(err)}` }
    }
    hash.update(rel).update(text)
    const parsed = parseReport(text, format)
    // One unreadable file spoils the capture rather than being skipped: a
    // partial read reports fewer cases than actually ran, and a case that is
    // simply absent is indistinguishable from one that never existed.
    if (!parsed.ok) return { ok: false, why: `${rel}: ${parsed.why}` }
    cases.push(...parsed.cases)
    files.push(rel)
  }
  return { ok: true, cases, files, sha: hash.digest('hex') }
}

/**
 * Turn one or more captures into facts a gate can weigh.
 *
 * Every fact carries the run count, so `meetsBar` can enforce the schema's
 * three-run floor rather than this function pretending to. A single capture
 * yields `runs: 1` and will be refused by a default bar — correctly, and
 * visibly, which is the point.
 */
export function caseFactsFrom(
  captures: { cases: TestCase[], files: string[], sha: string }[],
  now: WorldState,
  source: string,
): CaseFacts {
  const cases = aggregate(captures.map(c => c.cases))
  const facts = new Map<string, Fact<boolean>>()
  const sha = createHash('sha256').update(captures.map(c => c.sha).join('|')).digest('hex')

  for (const [id, agg] of cases) {
    if (agg.verdict === 'flaky' || agg.verdict === 'missing') {
      // Neither is a pass and neither is a fail. A flaky case has proven
      // nothing in either direction; a missing one was never observed. Both
      // are `indeterminate`, which blocks — the alternative is calling an
      // unobserved case green.
      facts.set(id, indeterminate<boolean>(
        agg.verdict === 'flaky'
          ? `disagreed across runs (${agg.statuses.join(', ')}), so it has proven nothing either way`
          : `seen in ${agg.seen} of ${agg.runs} run${agg.runs === 1 ? '' : 's'}${agg.statuses.includes('skipped') ? ' and was skipped' : ''}, so there is no verdict for it`,
      ))
      continue
    }
    facts.set(id, derived(agg.verdict === 'pass', {
      source,
      sourceSha: sha,
      capturedAt: Date.now(),
      ...(now.head ? { head: now.head } : {}),
      ...(now.tree ? { tree: now.tree } : {}),
      runs: agg.runs,
    }))
  }

  return { cases, facts, files: captures.flatMap(c => c.files) }
}
