/**
 * A verdict has to be about one case, and disagreement is not a pass.
 *
 * The trusted root could only read `<testsuite>` totals, so the strongest
 * thing anything could say was "the suite is green" — which makes "40 other
 * failures in the same suite" and "the one case that matters failed" the same
 * fact, and leaves a per-row acceptance contract with nothing to stand on.
 *
 * The aggregation rules carry BR-03 down to the case: three runs that
 * disagree have proven nothing, and a case that disappeared from a report is
 * not a case that passed — which matters most for runners that abort at the
 * first failure, where every later case looks exactly like one that was never
 * written.
 *
 *   node scripts/test-test-report.mjs
 */
import assert from 'node:assert/strict'
import { parseJUnit, parseReport, caseId, aggregate } from '../shared/utils/testReport.ts'

// ---- Reading cases, not totals ------------------------------------------
{
  const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="billing" tests="4" failures="1" errors="1" skipped="1">
    <testcase classname="billing.RateTest" name="rates excess minutes" time="0.12"/>
    <testcase classname="billing.RateTest" name="rounds at the tier boundary" time="0.03">
      <failure message="expected 120 but was 119">at RateTest.java:88</failure>
    </testcase>
    <testcase classname="billing.RateTest" name="handles a null plan">
      <error type="NullPointerException">boom</error>
    </testcase>
    <testcase classname="billing.RateTest" name="pro-rates a mid-cycle change">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`
  const r = parseJUnit(xml)
  assert.equal(r.ok, true)
  assert.equal(r.cases.length, 4, 'every case is read, not summed')
  const by = Object.fromEntries(r.cases.map(c => [c.name, c]))
  assert.equal(by['rates excess minutes'].status, 'passed', 'a self-closing case is a pass')
  assert.equal(by['rounds at the tier boundary'].status, 'failed')
  assert.equal(by['rounds at the tier boundary'].message, 'expected 120 but was 119',
    'the failure message must survive — it is what a reviewer actually reads')
  assert.equal(by['handles a null plan'].status, 'error', 'an error is not a failure and is reported as itself')
  assert.equal(by['pro-rates a mid-cycle change'].status, 'skipped')
  assert.equal(by['rates excess minutes'].time, 0.12)
  assert.equal(caseId(by['rates excess minutes']), 'billing.RateTest::rates excess minutes')
}

// CDATA and escaped entities, which real runners emit constantly.
{
  const r = parseJUnit(`<testsuite name="s">
    <testcase classname="c" name="a &amp; b">
      <failure><![CDATA[expected <tag> but got "other"]]></failure>
    </testcase>
  </testsuite>`)
  assert.equal(r.ok, true)
  assert.equal(r.cases[0].name, 'a & b', 'escaped entities in a name are decoded')
  assert.match(r.cases[0].message, /expected <tag>/, 'and CDATA is unwrapped')
}

// A case carrying both a failure and a skip is a failure.
{
  const r = parseJUnit(`<testsuite><testcase classname="c" name="n"><failure message="no"/><skipped/></testcase></testsuite>`)
  assert.equal(r.cases[0].status, 'failed', 'a failure outranks a skip on the same case')
}

// ---- Unreadable is not empty --------------------------------------------
{
  assert.equal(parseJUnit('').ok, false, 'an empty report is unreadable, not a clean suite')
  assert.equal(parseJUnit('   ').ok, false)
  const notJunit = parseJUnit('ok 1 - something\nok 2 - else\n')
  assert.equal(notJunit.ok, false, 'TAP is not JUnit and must say so rather than report zero cases')
  assert.match(notJunit.why, /not a JUnit/)

  // A genuinely empty suite IS readable, and that is a different answer.
  const emptySuite = parseJUnit('<testsuite name="s" tests="0"></testsuite>')
  assert.equal(emptySuite.ok, true, 'a well-formed suite with no cases parsed fine')
  assert.deepEqual(emptySuite.cases, [], 'it just had nothing in it')
}

// ---- An undeclared format blocks rather than passing --------------------
{
  for (const f of ['surefire', 'junit', 'pytest', 'jest']) {
    assert.equal(parseReport('<testsuite><testcase classname="c" name="n"/></testsuite>', f).ok, true,
      `${f} is a JUnit dialect and shares the parser`)
  }
  for (const f of ['go-json', 'tap']) {
    const r = parseReport('anything', f)
    assert.equal(r.ok, false, `${f} has no parser yet and must say so`)
    assert.match(r.why, new RegExp(f), 'naming itself, so the fix is obvious')
  }
}

// ---- Aggregation: disagreement is not a pass ----------------------------
function c(name, status) { return { classname: 'T', name, status } }

{
  const three = [
    [c('a', 'passed'), c('b', 'passed'), c('flaky', 'passed')],
    [c('a', 'passed'), c('b', 'failed'), c('flaky', 'failed')],
    [c('a', 'passed'), c('b', 'failed'), c('flaky', 'passed')],
  ]
  const out = aggregate(three)
  assert.equal(out.get('T::a').verdict, 'pass', 'agreement on pass across every run')
  assert.equal(out.get('T::b').verdict, 'flaky',
    'two failures and a pass is not a fail — it is unproven in both directions')
  assert.equal(out.get('T::flaky').verdict, 'flaky')
  assert.deepEqual(out.get('T::a').statuses, ['passed'])
  assert.equal(out.get('T::a').runs, 3)
}

// Unanimous failure is a fail, not flaky.
{
  const out = aggregate([[c('x', 'failed')], [c('x', 'failed')], [c('x', 'failed')]])
  assert.equal(out.get('T::x').verdict, 'fail')
}

// A single run cannot produce a pass worth anything — it produces a pass over
// one run, and the EvidenceBar in facts.ts is what refuses it. Aggregation
// still reports honestly how many runs it saw.
{
  const out = aggregate([[c('x', 'passed')]])
  assert.equal(out.get('T::x').verdict, 'pass')
  assert.equal(out.get('T::x').runs, 1, 'the run count travels with the verdict so the bar can judge it')
}

// ---- A case that vanished is not a case that passed ---------------------
// The runner aborts at the first failure, so cases after it never appear.
// Reading that as "nothing to report" would turn an aborted suite into a
// clean one.
{
  const out = aggregate([
    [c('first', 'passed'), c('second', 'passed')],
    [c('first', 'passed')],
    [c('first', 'passed'), c('second', 'passed')],
  ])
  assert.equal(out.get('T::first').verdict, 'pass')
  assert.equal(out.get('T::second').verdict, 'missing', 'a case absent from any run is missing, never a pass')
  assert.equal(out.get('T::second').seen, 2)
}

// A skipped case is missing too: a row whose case was skipped has the same
// evidentiary value as a row whose case does not exist.
{
  const out = aggregate([[c('s', 'skipped')], [c('s', 'skipped')], [c('s', 'skipped')]])
  assert.equal(out.get('T::s').verdict, 'missing', 'unanimously skipped is still no evidence')
}

console.log('test reports: cases not totals, unreadable is not empty, disagreement is flaky, and a vanished or skipped case is never a pass')
