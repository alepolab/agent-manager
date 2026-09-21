/**
 * Whether a gate fires at all — driven through the real runner, not around it.
 *
 * scripts/test-oversight.mjs asserts that `oversightFor('docs') === 'auto'`, and
 * it passed every day while the feature was completely dead: `readClassification`
 * declared `blast_radius` in its return type and returned an object without it,
 * so `run.blastRadius` was `undefined` on every run ever recorded. Every approval
 * step stopped, nothing was ever owner-gated, and `ApprovalNeedsReason` could not
 * be thrown. A unit test of a pure function cannot see that, because the bug is
 * in who feeds it.
 *
 * So this test refuses to call `oversightFor` at all. It drives a real run whose
 * stub intake writes a real meta.json, and asks the only questions that matter:
 * does cheap work get through, does dangerous work stop, and can dangerous work
 * be waved through in silence.
 *
 *   node scripts/test-gate-tiers.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'tiers-'))
// This harness starts many runs on the same ticket key on purpose; the
// duplicate-ticket guard (workflowRunner.startRun) is a product rule about
// operators, not about fixtures.
process.env.AGENT_ALLOW_DUPLICATE_TICKET_RUNS = '1'
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'tiers-artifacts-'))

const runner = await import('../server/utils/workflowRunner.ts')
// This test is about the gate, not about whether this machine has a checkout.
runner.setPreflight(async () => ({ at: Date.now(), checks: [] }))
const store = await import('../server/utils/workflowRunStore.ts')

const TIMEOUT = 8000

const workflow = {
  slug: 'tiers',
  name: 'Tiers',
  steps: [
    { id: 'a', agentSlug: 'agent-a', label: 'Intake', next: ['d'] },
    { id: 'd', agentSlug: 'agent-d', label: 'Ship', next: [], approval: true },
  ],
}

/**
 * Intake's real channel, used the way intake uses it: the artifact header in the
 * step's input names the directory, and the classification is merged into
 * meta.json there. Writing `run.blastRadius` directly would test nothing — the
 * bug lived exactly in the path from this file to that field.
 */
function intakeClassifying(radius) {
  return async (agentSlug, input) => {
    if (agentSlug === 'agent-a') {
      const m = input.match(/Write every artifact you produce into: (\S+)/)
      if (m) {
        const path = join(m[1], 'meta.json')
        const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
        writeFileSync(path, JSON.stringify(
          { ...current, work_type: 'bug', origin: 'production', blast_radius: radius },
          null, 2))
      }
    }
    return `out ${agentSlug}`
  }
}

async function runClassifiedAs(radius) {
  for (const r of await store.listRuns('tiers')) {
    if (r.status === 'paused' || r.status === 'running') await runner.stopRun(r.id)
  }
  runner.setAgentCaller(intakeClassifying(radius))
  const started = await runner.startRun({
    workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true,
  })
  return runner.waitForSettled(started.id, TIMEOUT)
}

// ── 1. cheap work is not stopped ─────────────────────────────────────────────
// The half of the policy that was silently inoperative. A gate that fires on a
// docs change is how reviewers learn to approve without reading.
{
  const r = await runClassifiedAs('docs')
  assert.equal(r.status, 'completed',
    `a docs change must flow through an approval gate, not stop at it; got ${r.status} (${r.error ?? 'no error'})`)
  assert.equal(r.blastRadius, 'docs',
    'and the run must record the radius it was classified with — this is the field that was never populated')
}

// ── 2. a money change stops, and cannot be approved in silence ───────────────
{
  const r = await runClassifiedAs('money')
  assert.equal(r.status, 'paused', 'a money change stops for a person')
  assert.equal(r.blastRadius, 'money')
  assert.equal(r.question?.kind, 'approval')

  await assert.rejects(
    () => runner.continueRun(r.id),
    /owner-gated/i,
    'approving an owner-gated change with no written reason must be refused, not accepted')

  const resumed = await runner.continueRun(r.id, 'Checked the tax arithmetic against the invoice fixture.')
  const done = await runner.waitForSettled(resumed.id, TIMEOUT)
  assert.equal(done.status, 'completed', 'and a justified approval lets it run')
}

// ── 3. unclassified is not low risk ──────────────────────────────────────────
// Absence of evidence is not evidence of safety: a run whose intake never
// classified it must stop, never flow through.
{
  const r = await runClassifiedAs(undefined)
  assert.equal(r.status, 'paused',
    'a run with no blast radius recorded must stop, not sail through every gate')
  assert.equal(r.blastRadius, undefined)
}

console.log('gate tiers: docs flows, money stops and must be justified, unclassified stops')
