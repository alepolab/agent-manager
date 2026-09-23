/**
 * The defect this pins: 584 distinct evidence filenames across thirteen runs,
 * 556 of them appearing exactly once, with nothing recording what any of them
 * IS or which step wrote it. Renaming them would break every existing link, so
 * the index classifies instead — and the two rules that make it trustworthy are
 * pinned here: a file inside exactly one step's window is attributed to that
 * step, and a file inside two overlapping windows is attributed to NEITHER.
 * A guessed provenance line is worse than an absent one.
 *
 *   node scripts/test-artifact-index.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'artifact-index-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'artifact-index-runs-'))

const { classifyArtifact, buildArtifactIndex, writeArtifactIndex } = await import('../server/utils/artifactIndex.ts')

// ── 1. real names from real runs land in the kind a searcher would look in ──
const expected = [
  ['meta.json', 'summary'],
  ['RUN-SUMMARY.md', 'summary'],
  ['plan-CSUP-7526.json', 'plan'],
  ['adr-007-promo-tier-write-authority.md', 'decision'],
  ['api-contract-fee-transaction-closure.md', 'contract'],
  ['oracle-before.xml', 'oracle'],
  ['red-t2-csup-7526.log', 'test-red'],
  ['green-backend-jest-cov.log', 'test-green'],
  ['qa2-frontend-vitest.log', 'qa'],
  ['regression.xml', 'qa'],
  ['security-review.md', 'review'],
  ['deploy-docker-build.log', 'deploy'],
  ['pr-body-final.md', 'pr'],
  ['docs-01-verify-before.txt', 'docs'],
  ['bug-CSUP-7524-reproduction.md', 'evidence'],
  ['csup-7519-candidate-fix.patch', 'patch'],
  ['csup-7519-browser-trace-postfix.zip', 'media'],
  ['result-qa-reviewer-SBN-4091-644a961b.md', 'result'],
  // A harness a QA step wrote is QA evidence, not a loose script: `--kind qa`
  // has to return it, which is the whole reason the prefix rules win.
  ['qa-structural.sh', 'qa'],
  ['ScriptSyntaxCheck.java', 'script'],
  ['manual-docs-verify.mjs', 'script'],
  ['verify-t4', 'evidence'],
]
for (const [name, kind] of expected) {
  assert.equal(classifyArtifact(name).kind, kind, `${name} should classify as ${kind}`)
}

// ── 2. the ticket comes out of the name, in both shapes runs write it ───────
assert.equal(classifyArtifact('csup-7519-root-cause.md').ticket, 'CSUP-7519')
assert.equal(classifyArtifact('csup7514-address-assessment.sql').ticket, 'CSUP-7514')
assert.equal(classifyArtifact('bug-CSUP-7524-reproduction.md').ticket, 'CSUP-7524')
// Not tickets: a run counter, an ADR number, a credit count.
assert.equal(classifyArtifact('qa-base-check-2credits.log').ticket, undefined)
assert.equal(classifyArtifact('adr-0001-address-validation-boundary.md').ticket, undefined)

// ── 3. provenance: one containing window attributes, two attribute nothing ──
const dir = join(process.env.AGENT_RUNS_DIR, 'run-1', 'artifacts')
await mkdir(dir, { recursive: true })
const t = 1_700_000_000_000

const write = async (name, mtimeMs) => {
  const full = join(dir, name)
  await writeFile(full, 'x')
  utimesSync(full, new Date(mtimeMs), new Date(mtimeMs))
}
await write('green-only-in-impl.log', t + 1_500)
await write('qa-during-both-lanes.log', t + 6_500)

const run = {
  id: 'run-1',
  steps: [
    { stepId: 's1', label: 'Implement', agentSlug: 'backend-engineer', startedAt: t, completedAt: t + 5_000 },
    { stepId: 's2', label: 'Frontend lane', agentSlug: 'frontend-engineer', startedAt: t + 6_000, completedAt: t + 9_000 },
    { stepId: 's3', label: 'QA', agentSlug: 'qa-reviewer', startedAt: t + 6_200, completedAt: t + 9_500 },
  ],
}

const rows = await buildArtifactIndex(dir, run)
const byName = Object.fromEntries(rows.map(r => [r.name, r]))
assert.equal(byName['green-only-in-impl.log'].step, 'Implement')
assert.equal(byName['green-only-in-impl.log'].agent, 'backend-engineer')
// Inside BOTH the frontend lane and QA: absent, never one of the two.
assert.equal(byName['qa-during-both-lanes.log'].step, undefined)
assert.equal(byName['qa-during-both-lanes.log'].agent, undefined)

// ── 4. the written index is what meta.json's counts are taken from ──────────
await write('csup-7519-browser-trace-prefix.zip', t + 1_000)
await write('oracle-before.xml', t + 1_100)
const summary = await writeArtifactIndex(dir, run)
const onDisk = JSON.parse(await readFile(join(dir, 'artifacts.json'), 'utf8'))
assert.equal(onDisk.length, 4)
assert.equal(summary.kinds['test-green'], 1)
assert.equal(summary.kinds.media, 1)
assert.equal(summary.binary_bytes, 1, 'only the zip counts as binary bytes')
assert.equal(summary.attributed, 3)
assert.equal(summary.unattributed, 1, 'the file inside two overlapping windows is attributed to neither')
assert.equal(onDisk.find(r => r.name.endsWith('.zip')).binary, true)

// ── 5. the light agent upgrades a kind, and is never allowed to invent one ──
// The model is stubbed: this pins the CONTRACT (what is accepted, what is
// ignored, what gets marked), never a live call.
const { parseJsonObject } = await import('../server/utils/lightAgent.ts')
assert.deepEqual(parseJsonObject('```json\n{"a.log":"qa"}\n```'), { 'a.log': 'qa' })
assert.equal(parseJsonObject('no json here'), null)
assert.equal(parseJsonObject(null), null)

const { setAsker } = await import('../server/utils/lightAgent.ts')
setAsker(async () => JSON.stringify({
  'green-only-in-impl.log': 'test-green', // unchanged: already right
  'qa-during-both-lanes.log': 'evidence', // upgraded
  'csup-7519-browser-trace-prefix.zip': 'not-a-real-kind', // refused
  // A live haiku really answers this, and it must not be taken: the bundle
  // contract defines what this filename means.
  'oracle-before.xml': 'test-red',
}))
const { enhanceArtifactIndex } = await import('../server/utils/artifactIndex.ts')
const changed = await enhanceArtifactIndex(dir)

assert.equal(changed, 1, 'only the one file the agent actually reclassified counts')
const after = JSON.parse(await readFile(join(dir, 'artifacts.json'), 'utf8'))
const row = name => after.find(r => r.name === name)
assert.equal(row('qa-during-both-lanes.log').kind, 'evidence')
assert.equal(row('qa-during-both-lanes.log').by, 'agent', 'an interpreted kind says so')
assert.equal(row('green-only-in-impl.log').by, undefined, 'a rules kind stays unmarked')
// A kind outside the list is ignored, not argued with and never written.
assert.equal(row('csup-7519-browser-trace-prefix.zip').kind, 'media')
assert.equal(row('csup-7519-browser-trace-prefix.zip').by, undefined)
// A contract filename keeps its defined meaning — `--kind oracle` must still
// find the oracle after a model has read the directory.
assert.equal(row('oracle-before.xml').kind, 'oracle')
assert.equal(row('oracle-before.xml').by, undefined)

console.log('artifact index: 5 checks passed')
