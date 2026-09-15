/**
 * JUnit XML, summarised: suites, counts, and every failed case with its message.
 *
 * Extracted from RunArtifacts.vue so the evidence viewer and the gate's verdict
 * card read a test report the same way. This repo has already paid for the
 * alternative once — run duration was computed three different ways in three
 * components and the same run reported three different numbers — and a test
 * result disagreeing with itself between the gate and the evidence pane is a
 * worse version of that: a reviewer would approve against one and be audited
 * against the other.
 *
 * Browser only. `DOMParser` does not exist on the server, so a caller rendering
 * during SSR must skip it (`import.meta.server`) rather than expect a result.
 */

export interface JunitTotals {
  tests: number
  failures: number
  errors: number
  skipped: number
}

export interface JunitSummary {
  suites: string[]
  total: JunitTotals
  failed: { name: string, message: string }[]
  /**
   * True when the report ran no tests at all. `tests="0"` is NOT a pass, and the
   * pipeline's own step brief says so explicitly — an oracle that executed
   * nothing proves nothing, and it is the one result most easily mistaken for a
   * green one because every failure count is also zero.
   */
  empty: boolean
}

/** Parse a JUnit XML document. Returns null when it is not JUnit or cannot be read. */
export function parseJunit(xml: string): JunitSummary | null {
  if (typeof DOMParser === 'undefined') return null
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const suites = [...doc.querySelectorAll('testsuite')]
    if (!suites.length) return null

    const n = (el: Element, a: string) => Number(el.getAttribute(a) ?? 0)
    const total = suites.reduce<JunitTotals>((acc, s) => ({
      tests: acc.tests + n(s, 'tests'),
      failures: acc.failures + n(s, 'failures'),
      errors: acc.errors + n(s, 'errors'),
      skipped: acc.skipped + n(s, 'skipped'),
    }), { tests: 0, failures: 0, errors: 0, skipped: 0 })

    const failed = [...doc.querySelectorAll('testcase')]
      .filter(tc => tc.querySelector('failure, error'))
      .map(tc => ({
        name: `${tc.getAttribute('classname') ?? ''}${tc.getAttribute('classname') ? '.' : ''}${tc.getAttribute('name') ?? ''}`,
        message: (
          tc.querySelector('failure, error')?.getAttribute('message')
          ?? tc.querySelector('failure, error')?.textContent
          ?? ''
        ).trim().slice(0, 400),
      }))

    return { suites: suites.map(s => s.getAttribute('name') ?? ''), total, failed, empty: total.tests === 0 }
  } catch {
    return null
  }
}

/** Did this report pass? A report that ran nothing did not. */
export function junitPassed(j: JunitSummary): boolean {
  return !j.empty && j.total.failures === 0 && j.total.errors === 0
}

/** One line for a gate: "42 passed" / "2 of 42 failed" / "no tests ran". */
export function junitLabel(j: JunitSummary): string {
  if (j.empty) return 'no tests ran'
  const bad = j.total.failures + j.total.errors
  if (bad > 0) return `${bad} of ${j.total.tests} failed`
  return `${j.total.tests} passed${j.total.skipped ? `, ${j.total.skipped} skipped` : ''}`
}
