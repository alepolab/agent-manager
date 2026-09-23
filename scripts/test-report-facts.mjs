/**
 * Reading a product's declared reports, against a real directory.
 *
 * The rule under test is the one this estate keeps relearning: a read that
 * did not happen must not look like a read that found nothing. A glob that
 * matches no file usually means the suite never ran, and treating that as
 * "no failures" is how a suite that never executed comes to look green.
 *
 *   node scripts/test-report-facts.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCapture, caseFactsFrom } from '../server/utils/reportFacts.ts'
import { meetsBar, freshness } from '../shared/utils/facts.ts'

const dir = mkdtempSync(join(tmpdir(), 'report-facts-'))
mkdirSync(join(dir, 'build', 'test-results'), { recursive: true })
const write = (name, xml) => writeFileSync(join(dir, 'build', 'test-results', name), xml)

const suite = (cases) => `<testsuite name="s">${cases}</testsuite>`
const pass = (n) => `<testcase classname="T" name="${n}"/>`
const fail = (n) => `<testcase classname="T" name="${n}"><failure message="no">x</failure></testcase>`

write('TEST-a.xml', suite(pass('one') + fail('two')))
write('TEST-b.xml', suite(pass('three')))

const pattern = 'build/test-results/*.xml'
const now = { head: 'abc', tree: 'tree1' }

// ---- A capture reads every matching file into one run -------------------
{
  const cap = await readCapture(dir, pattern, 'surefire')
  assert.equal(cap.ok, true)
  assert.equal(cap.cases.length, 3, 'cases are merged across the files of one run')
  assert.deepEqual(cap.files.sort(), ['build/test-results/TEST-a.xml', 'build/test-results/TEST-b.xml'])
  assert.ok(cap.sha, 'and the capture is hashed so two captures are distinguishable')
}

// ---- No match is not an empty suite -------------------------------------
{
  const cap = await readCapture(dir, 'nowhere/*.xml', 'surefire')
  assert.equal(cap.ok, false, 'a glob matching nothing means no report was produced')
  assert.match(cap.why, /no file matched/, 'and it says so rather than reporting zero cases')
}

// ---- One unreadable file spoils the capture -----------------------------
// A partial read reports fewer cases than actually ran, and a case that is
// simply absent is indistinguishable from one that never existed.
{
  write('TEST-c.xml', 'this is not xml at all')
  const cap = await readCapture(dir, pattern, 'surefire')
  assert.equal(cap.ok, false, 'a junk file must not be silently skipped')
  assert.match(cap.why, /TEST-c\.xml/, 'and the offending file is named')
  rmSync(join(dir, 'build', 'test-results', 'TEST-c.xml'))
}

// ---- A format with no parser blocks -------------------------------------
{
  const cap = await readCapture(dir, pattern, 'go-json')
  assert.equal(cap.ok, false, 'a declared format nothing can parse must block')
  assert.match(cap.why, /go-json/)
}

// ---- Facts carry the run count, and a single capture is refused ---------
{
  const cap = await readCapture(dir, pattern, 'surefire')
  const { facts } = caseFactsFrom([cap], now, pattern)

  const one = facts.get('T::one')
  assert.equal(one.value, true, 'a passing case is a true fact')
  assert.equal(one.provenance.runs, 1, 'over exactly one run, honestly recorded')
  assert.equal(freshness(one, now), 'fresh', 'and pinned to the tree it was captured against')

  // The whole point of recording runs: the default bar refuses it.
  const bar = meetsBar(one, now)
  assert.equal(bar.ok, false, 'one run is not evidence, and the bar is what says so')
  assert.match(bar.reasons.join(' '), /ran 1 time/)
  assert.equal(meetsBar(one, now, { minRuns: 1 }).ok, true, 'unless the caller deliberately lowers it')

  assert.equal(facts.get('T::two').value, false, 'a failing case is a false fact, not an absent one')
}

// ---- Three agreeing captures clear the bar ------------------------------
{
  const caps = []
  for (let i = 0; i < 3; i++) caps.push(await readCapture(dir, pattern, 'surefire'))
  const { facts, cases } = caseFactsFrom(caps, now, pattern)
  assert.equal(cases.get('T::one').verdict, 'pass')
  assert.equal(meetsBar(facts.get('T::one'), now).ok, true, 'three agreeing runs is evidence')
  assert.equal(facts.get('T::one').provenance.runs, 3)
}

// ---- Disagreement and disappearance are indeterminate, never pass -------
{
  const green = await readCapture(dir, pattern, 'surefire')
  // Same suite, but 'two' now passes and 'three' never ran.
  write('TEST-a.xml', suite(pass('one') + pass('two')))
  rmSync(join(dir, 'build', 'test-results', 'TEST-b.xml'))
  const changed = await readCapture(dir, pattern, 'surefire')

  const { facts } = caseFactsFrom([green, changed, green], now, pattern)

  const flaky = facts.get('T::two')
  assert.equal(flaky.confidence, 'indeterminate', 'a case that disagreed proves nothing in either direction')
  assert.match(flaky.why, /disagreed across runs/)
  assert.equal(meetsBar(flaky, now).ok, false, 'so it cannot be used as evidence')

  const vanished = facts.get('T::three')
  assert.equal(vanished.confidence, 'indeterminate', 'a case missing from a run has no verdict')
  assert.match(vanished.why, /2 of 3 runs/, 'and the reviewer is told exactly how often it was seen')
}

rmSync(dir, { recursive: true, force: true })
console.log('report facts: a missing report is not a clean suite, a junk file spoils the capture, one run is refused, and flaky or vanished cases block')
