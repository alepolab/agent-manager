#!/usr/bin/env node
/**
 * Verify + Regression ran the whole suite to prove a three-line string change:
 * 2,204 tests, 627 seconds, on the run's clock. The instruction permitted it —
 * "the module's own tests at minimum, the full suite if it runs in reasonable
 * time" — and "reasonable" was unbounded, so with `tests.unit: 'CONFIRM'` in
 * the registry for 18 of 22 products, "run everything" was the only concrete
 * option the agent had.
 *
 * The full suite now belongs to CI, which runs it on the PR in parallel while
 * sdlc-pr-follow-up watches those checks and fixes what goes red before merge.
 * The guarantee did not move off the pipeline; it moved to where it is cheap.
 *
 * Two things this test defends hardest:
 *
 *  - The C++ recipe. `ctest` on a stale or partial build reports passes for
 *    tests it never rebuilt — a green result proving nothing, which is exactly
 *    the silent pass this pipeline exists to catch.
 *  - The disclosure. `regression.suite` is read as the regression proof, so a
 *    scoped run recorded as a full one is a placeholder wearing the shape of
 *    evidence.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const templates = readFileSync(join(root, 'app/utils/templates.ts'), 'utf8')
const verifier = templates.slice(
  templates.indexOf("id: 'sdlc-verifier'"),
  templates.indexOf("id: 'sdlc-trace-capture'"))
const flat = verifier.replace(/\s+/g, ' ')
let failures = 0
const check = (name, ok, why) => {
  if (ok) return console.log(`  ok   ${name}`)
  failures++
  console.error(`  FAIL ${name}\n       ${why}`)
}

check('the unbounded "reasonable time" licence is gone',
  !/full suite if it runs in reasonable time/.test(flat),
  'that clause is what let 627 seconds of tests count as reasonable')

check('scope derives from what the run actually changed',
  /fix\.files_changed/.test(flat) && /re-asserts it from git/.test(flat),
  'deriving from a self-reported file list would scope against a claim rather than a fact')

check('an unmappable path widens rather than silently narrows',
  /widen/i.test(flat) && /running nothing and not noticing is not/.test(flat),
  'the safe failure is running too much and saying so; the unsafe one is running nothing')

check('the full suite is declined WITH the reason',
  /full suite is CI's job/.test(flat) && /pr follow-up|PR follow-up/i.test(flat),
  'an agent told only "do not run the full suite" reads it as being asked to verify less')

check('the registry overrides when it holds a real command',
  /tests\.unit/.test(flat) && /CONFIRM/.test(flat),
  'the 18 placeholder entries can be filled in later and must then take effect without a code change')

// ── per-family recipes ────────────────────────────────────────────────────
for (const [family, needle] of [
  ['JS/TS', 'vitest run <dir>'],
  ['Python', 'pytest <path>'],
  ['Go', 'go test ./<pkg>/...'],
  ['Java', '-Dtest=<Class>'],
  ['C++', 'ctest -R <module>'],
]) {
  check(`${family} has a scoping recipe`, flat.includes(needle),
    'the technique differs by family; a single generic instruction cannot cover a build-first language and a path-argument one')
}

check('C++ is build-first, not just a different command',
  /Build the target, then filter/.test(flat) && /Name the targets you built/.test(flat),
  'a test binary that was not rebuilt cannot have run')

check('the stale-build silent pass is named',
  /passes for tests it never rebuilt/.test(flat),
  'this is a green result that proves nothing — the agent must know the shape of it to avoid it')

check('an unbuildable C++ target halts',
  /cannot build the target, that is a halt/.test(flat),
  'a scoped run over a build that failed is worse than no run')

check('it defers depth to the language skills rather than restating them',
  /cpp-testing/.test(flat) && /only enough to choose a scope/.test(flat),
  'the vendored skills carry hundreds of lines on this; duplicating them inline guarantees they drift apart')

// ── disclosure ────────────────────────────────────────────────────────────
check('the scope must be disclosed in regression.suite',
  /Say what you scoped/.test(flat) && /full suite runs in CI on the PR/.test(flat),
  'a reviewer reads that field as the regression proof')

check('the misleading shape is shown, not just forbidden',
  /134 files/.test(flat) && /misleading/.test(flat),
  'naming the exact string that misled is what stops it being written again')

check('the artifacts section repeats the requirement',
  /Name what actually ran AND that the full suite is CI's/.test(templates),
  'the field is written from the artifacts section; a rule stated only elsewhere gets missed at the point of writing')

check('lint and typecheck stay unscoped',
  /stay \*\*unscoped\*\*/.test(flat),
  'they cost seconds and catch the most common local-pass-to-red-pipeline case')

console.log(failures === 0 ? '\nscoped regression: all checks passed' : `\nscoped regression: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
