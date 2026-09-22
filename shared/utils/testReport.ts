/**
 * Per-CASE results out of a test report, so a verdict can be about one thing.
 *
 * The trusted root could not do this. `assemble-bundle.mjs`'s parseXunit
 * matches `<testsuite>` tags and sums four attributes; it never looks at a
 * `<testcase>`. `app/utils/junit.ts` does read cases but is browser-only
 * (DOMParser, stated in its own header) and cannot be imported by a validator
 * that must run under plain node with no dependencies.
 *
 * The consequence was structural, not cosmetic: with only suite totals, the
 * strongest statement anything could make was "the suite is green". An
 * acceptance row cannot be scored against that, so a per-row contract had
 * nothing to stand on, and "40 other failures in the same suite" and "the one
 * case that matters failed" were the same fact.
 *
 * Zero dependencies and no I/O, so `engineering/scripts/*` can use it under
 * plain node and so the rules are testable without a repository.
 */

export type CaseStatus = 'passed' | 'failed' | 'error' | 'skipped'

export interface TestCase {
  /** The suite or class the case belongs to, as the runner reported it. */
  classname: string
  name: string
  status: CaseStatus
  /** Seconds, when the runner reported them. */
  time?: number
  /** The failure or error message, first line, when there was one. */
  message?: string
}

/**
 * Parsed, or not — and never a silent empty.
 *
 * `ok: false` is a report this code could not read. That is a different fact
 * from a report with no cases in it, and collapsing the two is the mistake
 * this estate has already made twice: a control that cannot run must not be
 * indistinguishable from one that ran and found nothing.
 */
export type ParseResult =
  | { ok: true, cases: TestCase[] }
  | { ok: false, why: string }

/** The formats the registry may declare. */
export type ReportFormat = 'surefire' | 'junit' | 'pytest' | 'jest' | 'go-json' | 'tap'

/**
 * surefire, pytest and jest all emit the JUnit XML family; they differ in
 * which attributes they bother to set, not in shape. They are one parser, and
 * saying so here is cheaper than four that drift apart.
 */
const JUNIT_FAMILY: ReportFormat[] = ['surefire', 'junit', 'pytest', 'jest']

const unescapeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&')

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = unescapeXml(m[2]!)
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*'([^']*)'/g)) if (!(m[1]! in out)) out[m[1]!] = unescapeXml(m[2]!)
  return out
}

/**
 * Every `<testcase>` in a JUnit-family report.
 *
 * Regex rather than a parser because the trusted root carries no
 * dependencies, and because this reads exactly one element type whose shape
 * the format fixes. Both forms are handled: a self-closing case (a pass, in
 * every runner) and one with children (`<failure>`, `<error>`, `<skipped>`).
 */
export function parseJUnit(xml: string): ParseResult {
  if (!xml || !xml.trim()) return { ok: false, why: 'the report is empty' }
  // A report with no <testsuite> at all is not a JUnit report. Saying that is
  // more useful than returning zero cases and letting the caller conclude the
  // suite is empty.
  if (!/<testsuites?\b/.test(xml) && !/<testcase\b/.test(xml)) {
    return { ok: false, why: 'no <testsuite> or <testcase> element; this is not a JUnit-family report' }
  }

  const cases: TestCase[] = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
    const attrs = attrsOf(m[1] ?? '')
    const inner = m[3] ?? ''
    const name = attrs.name ?? ''
    if (!name) continue

    let status: CaseStatus = 'passed'
    let message: string | undefined
    // Order matters: a case carrying both a failure and a skip is a failure.
    const failure = inner.match(/<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1\s*>)/)
    if (failure) {
      status = failure[1] === 'error' ? 'error' : 'failed'
      const fAttrs = attrsOf(failure[2] ?? '')
      const body = (failure[3] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
      message = (fAttrs.message || body.split('\n')[0] || '').trim() || undefined
    } else if (/<skipped\b/.test(inner)) {
      status = 'skipped'
    }

    const time = attrs.time !== undefined ? Number(attrs.time) : undefined
    cases.push({
      classname: attrs.classname ?? attrs.class ?? '',
      name,
      status,
      ...(Number.isFinite(time) ? { time } : {}),
      ...(message ? { message } : {}),
    })
  }

  return { ok: true, cases }
}

/**
 * Parse by declared format.
 *
 * An unimplemented format returns `ok: false` naming itself, rather than
 * quietly yielding no cases. A registry may declare `go-json` or `tap` before
 * anything here can read them, and the honest answer at that point is "this
 * pipeline cannot score that product per row yet" — which blocks — not "the
 * suite had no cases", which would pass.
 */
export function parseReport(text: string, format: ReportFormat): ParseResult {
  if (JUNIT_FAMILY.includes(format)) return parseJUnit(text)
  return { ok: false, why: `no parser for \`${format}\` reports yet, so this product cannot be scored per case` }
}

/** A stable identifier for one case, for an acceptance row to point at. */
export function caseId(c: Pick<TestCase, 'classname' | 'name'>): string {
  return c.classname ? `${c.classname}::${c.name}` : c.name
}

export type CaseVerdict = 'pass' | 'fail' | 'flaky' | 'missing'

export interface AggregateResult {
  verdict: CaseVerdict
  /** How many of the supplied runs contained this case. */
  seen: number
  /** How many runs were supplied. */
  runs: number
  /** The distinct statuses observed, for a reader working out why it is flaky. */
  statuses: CaseStatus[]
}

/**
 * One verdict per case across N runs of the same suite.
 *
 * This is where the bundle schema's "a verdict from a single run is not
 * evidence" becomes a per-case rule rather than a per-suite one:
 *
 *  - `pass`    every supplied run ran this case and every one passed
 *  - `fail`    every run agreed it did not pass
 *  - `flaky`   the runs disagreed. NOT a pass, and not a fail either: an
 *              intermittent case has proven nothing in either direction
 *  - `missing` at least one run never reported it. A case that vanishes from
 *              a report is not a case that passed, and a runner that aborts
 *              at the first failure makes every later case look exactly like
 *              one that was never written
 *
 * A `skipped` case is deliberately not a pass. It is reported as `missing`,
 * because a row whose case was skipped has the same evidentiary value as one
 * whose case does not exist.
 */
export function aggregate(runs: TestCase[][]): Map<string, AggregateResult> {
  const ids = new Set<string>()
  for (const run of runs) for (const c of run) ids.add(caseId(c))

  const out = new Map<string, AggregateResult>()
  for (const id of ids) {
    const statuses: CaseStatus[] = []
    let seen = 0
    for (const run of runs) {
      const found = run.find(c => caseId(c) === id)
      if (!found) continue
      seen++
      statuses.push(found.status)
    }
    const distinct = [...new Set(statuses)]
    let verdict: CaseVerdict
    if (seen < runs.length || statuses.some(s => s === 'skipped')) verdict = 'missing'
    else if (distinct.length > 1) verdict = 'flaky'
    else verdict = distinct[0] === 'passed' ? 'pass' : 'fail'
    out.set(id, { verdict, seen, runs: runs.length, statuses: distinct })
  }
  return out
}
