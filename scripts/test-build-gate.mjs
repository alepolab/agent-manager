/**
 * The defect this pins, from the 2026-09-21 review of runs 9a6ea7d0 and
 * a3cb9d37: "The automated bug-fix runs for CSUP-7524 and CSUP-7526 opened pull
 * requests without building the code or executing the SQL they produced."
 *
 * Both runs had a RECORDED build failure and opened pull requests regardless.
 * CSUP-7526's only shipped artifact was a remediation script that dies on its
 * second query. Infra CI runs Ansible, bats, compose config and ShellCheck —
 * none executes SQL — and claude-review reads diffs, where an unexported OSGi
 * package and a mis-qualified column both read fine.
 *
 * So the gate is evidence, not assertion, and these are its edges:
 *  - docs-only changes still ship; a gate that stops them teaches people to
 *    disable it.
 *  - a .sql file that was written but never run does not ship.
 *  - the escape hatch works, is explicit, and is not the default.
 *
 *   node scripts/test-build-gate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'build-gate-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'build-gate-runs-'))

const { prEvidenceRefusal, runPrStep } = await import('../server/utils/prStep.ts')

const nothingRan = { builtOk: false, buildFailed: false, buildCommands: [], sqlFilesExecuted: [] }
const built = { builtOk: true, buildFailed: false, buildCommands: ['gradle build'], sqlFilesExecuted: [] }
const failedBuild = { builtOk: false, buildFailed: true, buildCommands: ['gradle build'], sqlFilesExecuted: [] }

// ── 1. code with no build is refused, and the refusal says what it looked at ─
const refusal = prEvidenceRefusal(['modules/subscriber-activity/src/Foo.java'], nothingRan)
assert.ok(refusal, 'source changes with no build must not become a pull request')
assert.match(refusal, /No project build ran in this run for this repository/)

const afterFailure = prEvidenceRefusal(['src/Foo.java'], failedBuild)
assert.match(afterFailure ?? '', /gradle build/, 'the refusal shows the command it judged')
assert.match(afterFailure ?? '', /failed/)

// ── 2. a build that succeeded ships; documentation always ships ─────────────
assert.equal(prEvidenceRefusal(['src/Foo.java'], built), null)
assert.equal(prEvidenceRefusal(['docs/runbook.md', 'README.md'], nothingRan), null,
  'a docs-only change must not need a build — a gate that stops those gets switched off')

// ── 3. SQL that was written but never executed (CSUP-7526) ──────────────────
const sqlRefusal = prEvidenceRefusal(['database/remediation/detect.sql'], nothingRan)
assert.ok(sqlRefusal, 'an unexecuted remediation script must not ship')
assert.match(sqlRefusal, /never executed/)
assert.equal(
  prEvidenceRefusal(['database/remediation/detect.sql'], { ...nothingRan, sqlFilesExecuted: ['detect.sql'] }),
  null,
  'the same file, actually run against a database, ships',
)

// ── 4. end to end through the PR step: refused, nothing pushed ──────────────
const calls = []
const exec = async (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'git' && args[0] === 'rev-parse') return 'fix/CSUP-7524-run-1'
  if (cmd === 'git' && args[0] === 'remote') return 'git@github.com:alepolab/subscriber-activity_lbss.git'
  if (cmd === 'git' && args[0] === 'rev-list') return '3'
  if (cmd === 'git' && args[0] === 'diff') return 'src/main/java/Fee.java\nsrc/main/java/Close.java'
  throw new Error(`unexpected ${cmd}`)
}
const run = {
  id: 'run-gate-1', branch: 'fix/CSUP-7524-run-1', baseBranch: 'develop', projectDir: '/w/run-1',
  ticketKey: 'CSUP-7524', initialPrompt: 'fees never close',
  product: { name: 'crm', repos: ['alepolab/subscriber-activity_lbss'] },
}
const result = await runPrStep(run, { exec, repoDirs: ['/w/run-1'], facts: nothingRan })
assert.equal(result.prs.length, 0, 'nothing is opened')
assert.equal(result.refused?.length, 1)
assert.match(result.refused[0].reason, /2 source file\(s\) changed/)
assert.ok(!calls.some(c => c.startsWith('git push')), 'and nothing is even pushed')
assert.ok(!calls.some(c => c.startsWith('gh pr create')))

// ── 5. the escape hatch is explicit, and only then does it ship ─────────────
process.env.AGENT_ALLOW_UNBUILT_PR = '1'
const forced = await runPrStep(run, {
  exec: async (cmd, args) => {
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://github.com/alepolab/subscriber-activity_lbss/pull/99'
    if (cmd === 'git' && args[0] === 'push') return ''
    return exec(cmd, args)
  },
  repoDirs: ['/w/run-1'],
  facts: nothingRan,
})
delete process.env.AGENT_ALLOW_UNBUILT_PR
assert.equal(forced.prs.length, 1, 'the operator can override, deliberately')
assert.equal(forced.refused, undefined)
assert.ok(forced.lines.some(l => l.includes('WARNING') && l.includes('AGENT_ALLOW_UNBUILT_PR')),
  'and the override is written into the run, not hidden')

console.log('build gate: no build, no pull request; an unexecuted .sql does not ship; docs always do')
