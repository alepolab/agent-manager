/**
 * The defect this pins, from run a3cb9d37 (CSUP-7526):
 *
 *   "Run launched with product: infra while 8 of its 9 tasks belong to
 *    lum-selfcare-v1. The run raised this itself as a T0 blocker and continued.
 *    The frontend fix remains as local commits on a bot worktree under
 *    /home/sandeep/alepo-workspace/, nothing on origin."
 *
 * Every check passed, and each for a good reason: `infra` really does own the
 * devops repository the run was handed, so the product matched its checkout;
 * `repoMismatch` compares committed repositories against the product's but only
 * at the end, and only across the directories the PR step discovers — the run's
 * checkout and its module subdirectories. A checkout elsewhere in the workspace
 * is invisible to it by construction. That is the root cause: nothing compared
 * WHERE the work happened against the checkout the run was given.
 *
 * The work had to run somewhere, so the command ledger sees it. What must hold:
 *  - a write outside the run's checkout is found, with the directory named;
 *  - a run widened to another product is NOT an alarm — widening is a feature;
 *  - reading around the workspace is not "work": only a change counts.
 *
 *   node scripts/test-stray-work.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'stray-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'stray-runs-'))

const { recordCommandLine, readCommandLedger, strayWork } = await import('../server/utils/commandLedger.ts')
const { runArtifactsDir } = await import('../server/utils/runArtifacts.ts')

const RUN_DIR = '/home/sandeep/alepo-workspace/devops'
const OTHER = '/home/sandeep/alepo-workspace/lum-selfcare-v1'

const runId = 'run-a3cb9d37'
await mkdir(runArtifactsDir(runId), { recursive: true })

// The a3cb9d37 sequence: the run reads its own checkout, then does the actual
// work in a repository it was never launched against.
recordCommandLine(runId, 's1', '[Bash] ls -la', 'tool', RUN_DIR)
recordCommandLine(runId, 's1', '→ ansible/ compose/', 'result')
recordCommandLine(runId, 's1', `[Bash] grep -rn customNumField3 ${OTHER}/src`, 'tool', RUN_DIR)
recordCommandLine(runId, 's1', '→ 18 matches', 'result')
recordCommandLine(runId, 's1', `[Write] ${OTHER}/src/app/promo/promo-config.service.ts`, 'tool', RUN_DIR)
recordCommandLine(runId, 's1', '→ written', 'result')
recordCommandLine(runId, 's1', '[Bash] git commit -m "fix promo tier"', 'tool', OTHER)
recordCommandLine(runId, 's1', '→ 1 file changed', 'result')
await new Promise(r => setTimeout(r, 60))

const entries = await readCommandLedger(runId)

// ── 1. the work outside the run's checkout is found, and named ─────────────
const stray = strayWork(entries, RUN_DIR)
const dirs = stray.map(s => s.dir)
assert.ok(dirs.some(d => d.startsWith(OTHER)), `the Selfcare repository must be named, got ${JSON.stringify(dirs)}`)
assert.ok(stray.some(s => s.what.includes('promo-config.service.ts')), 'and the file it wrote')
assert.ok(stray.some(s => s.what.includes('git commit')), 'and the commit it made there')

// ── 2. reading elsewhere is not work ───────────────────────────────────────
// The grep above ran against the other repository from the run's own checkout;
// research is how a run finds out where the fault lives, and a pipeline that
// stops for it would be unusable.
const readOnly = 'run-readonly'
await mkdir(runArtifactsDir(readOnly), { recursive: true })
recordCommandLine(readOnly, 's1', `[Bash] grep -rn thing ${OTHER}`, 'tool', RUN_DIR)
recordCommandLine(readOnly, 's1', '→ 3 matches', 'result')
recordCommandLine(readOnly, 's1', `[Read] ${OTHER}/src/app/x.ts`, 'tool', RUN_DIR)
recordCommandLine(readOnly, 's1', '→ 40 lines', 'result')
recordCommandLine(readOnly, 's1', '[Bash] git status', 'tool', OTHER)
recordCommandLine(readOnly, 's1', '→ clean', 'result')
await new Promise(r => setTimeout(r, 60))
assert.deepEqual(strayWork(await readCommandLedger(readOnly), RUN_DIR), [],
  'looking at another repository is research, not stray work')

// ── 3. a widened run is not an alarm ───────────────────────────────────────
// A step may widen a run to another product when the fault turns out to live
// there; that path exists and must not read as a mistake.
assert.deepEqual(strayWork(entries, RUN_DIR, [OTHER]), [],
  'once the run has been widened to that product, its work there is expected')

// ── 4. a lane worktree is the run's own ────────────────────────────────────
const lane = `${RUN_DIR}--lane-frontend`
const laned = 'run-laned'
await mkdir(runArtifactsDir(laned), { recursive: true })
recordCommandLine(laned, 's1', `[Write] ${lane}/src/app/x.ts`, 'tool', lane)
recordCommandLine(laned, 's1', '→ written', 'result')
await new Promise(r => setTimeout(r, 60))
const laneEntries = await readCommandLedger(laned)
assert.equal(strayWork(laneEntries, RUN_DIR, [lane]).length, 0, 'a lane is the run working on itself')
assert.equal(strayWork(laneEntries, RUN_DIR).length, 1,
  'and without being told about the lane it is correctly reported — the allow list is what makes it safe')

// ── 5. end to end: the RUN stops and asks, at the step that did it ─────────
// The detector being right is half of it; the reason a3cb9d37 cost 72 minutes
// is that nothing acted on what it knew.
process.env.AGENT_ALLOW_DUPLICATE_TICKET_RUNS = '1'
const runner = await import('../server/utils/workflowRunner.ts')
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))

// The stub writes into another product's checkout the way a real agent does:
// through its tool stream, which is the only thing the ledger reads.
runner.setAgentCaller(async (slug, _input, _cwd, opts) => {
  if (slug === 'agent-fix') {
    opts?.onProgress?.({ turn: 1, lastActivityAt: Date.now(), line: `[Write] ${OTHER}/src/app/promo.ts`, lineKind: 'tool' })
    opts?.onProgress?.({ turn: 1, lastActivityAt: Date.now(), line: '→ written', lineKind: 'result' })
  }
  return `out ${slug}`
})

const workflow = {
  slug: 'stray-wf',
  name: 'Stray',
  steps: [
    { id: 'fix', agentSlug: 'agent-fix', label: 'Implement Fix', next: ['docs'] },
    { id: 'docs', agentSlug: 'agent-docs', label: 'Docs', next: [] },
  ],
}
const started = await runner.startRun({
  workflow, initialPrompt: 'CSUP-7526: student promo downgraded', watch: 'direct-invocation', autoRun: true,
  projectDir: RUN_DIR,
})
const settled = await runner.waitForSettled(started.id, 8000)

assert.equal(settled.status, 'paused', `the run must stop for a person, got ${settled.status}`)
assert.equal(settled.question?.stepId, 'fix', 'at the step that did it, not three steps later')
assert.match(settled.question?.text ?? '', /changed a repository it was not launched against/)
assert.match(settled.question?.text ?? '', /lum-selfcare-v1/, 'and it names where the work went')
assert.equal(settled.steps.find(s => s.stepId === 'docs')?.status, 'pending',
  'nothing downstream runs while the question is open')

console.log('stray work: a run that changes a repository it was not launched against stops at that step and asks')
