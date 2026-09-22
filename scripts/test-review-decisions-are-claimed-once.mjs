// Two submissions of the same review must not file the same tickets twice.
//
// applyReviewDecisions files every approved entry BEFORE the route resumes the
// run, and the resume is what clears `awaiting_review`. So the status check
// inside applyReviewDecisions - which reads a run object the route fetched
// earlier - lets two overlapping submissions both through, and both file.
// jiraCreate's `already` guard does not help: it keys on the jira_key written
// back to the artifact at the very end, which neither caller has written yet.
//
// This file proves the hazard is real at the level it actually lives, and
// pins the claim in the route that closes it.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'claim-'))
process.env.AGENT_RUNS_DIR = mkdtempSync(join(tmpdir(), 'claim-artifacts-'))
process.env.JIRA_POST_ENABLED = '1'
process.env.JIRA_BASE_URL = 'https://jira.example.invalid'
process.env.JIRA_EMAIL = 'tester@example.invalid'
process.env.JIRA_API_TOKEN = 'token'

const runner = await import('../server/utils/workflowRunner.ts')
const review = await import('../server/utils/runReview.ts')
const artifacts = await import('../server/utils/runArtifacts.ts')

const TIMEOUT = 5000

const flow = {
  slug: 'claim-demo',
  name: 'Claim Demo',
  steps: [
    { id: 'g', agentSlug: 'agent-g', label: 'Decision Gate', next: ['esc'] },
    { id: 'esc', agentSlug: 'agent-esc', label: 'Create Jira (Escalated)', next: [], approval: true, runWhen: { artifact: 'escalated-drafts.json' } },
  ],
}

const draft = (n) => ({
  draft_id: `DRAFT-00${n}`,
  summary: `Finding ${n}`,
  description: 'why',
  fields: { project: 'SEC', issue_type: 'Bug' },
  gate: { decision_prompt: `File ${n}?` },
})

const readArtifact = (runId, name) => {
  const p = artifacts.resolveRunArtifact(runId, name)
  return p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}

async function gatedRun(entries) {
  runner.setAgentCaller(async (agentSlug, input) => {
    if (agentSlug === 'agent-g') {
      const dir = input.match(/Write every artifact you produce into: (\S+)/)[1]
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(dir, 'escalated-drafts.json'), JSON.stringify(entries, null, 2))
    }
    return `output of ${agentSlug}`
  })
  let run = await runner.startRun({ workflow: flow, initialPrompt: 'scan', watch: 'direct-invocation', autoRun: true })
  run = await runner.waitForSettled(run.id, TIMEOUT)
  assert.equal(run.status, 'awaiting_review')
  return run
}

// ── 1. The hazard: concurrent applies both file, with nothing in between ──
// This is what the route's claim prevents. Asserting it here is what keeps
// the claim from being deleted as "belt and braces" later.
{
  const run = await gatedRun([draft(1)])

  let created = 0
  let release
  const gate = new Promise((r) => { release = r })
  // Blocks the first POST inside the Jira round-trip, which is precisely the
  // window a second submission used to arrive in.
  const slowFetch = async (url, init) => {
    if (init?.method === 'POST') {
      created++
      const key = `SEC-${created}`
      await gate
      return { ok: true, status: 201, json: async () => ({ key }), text: async () => '' }
    }
    // createmeta: enough to get to the POST.
    return { ok: true, status: 200, json: async () => ({ projects: [] }), text: async () => '' }
  }

  const first = review.applyReviewDecisions(run, [{ index: 0, decision: 'approved' }], 'a', slowFetch)
  await new Promise(r => setImmediate(r))
  const second = review.applyReviewDecisions(run, [{ index: 0, decision: 'approved' }], 'b', slowFetch)
  release()
  await Promise.allSettled([first, second])

  assert.ok(created >= 2,
    'the hazard is not reproducible any more - if applyReviewDecisions became safe on its own, say so here rather than leaving both guards claiming to be the one that matters')
  assert.equal((await runner.stopRun(run.id)).status, 'stopped')
}

// ── 2. The route claims the run for the whole apply-and-resume ───────────
{
  const src = readFileSync(new URL('../server/api/runs/[id]/decisions.post.ts', import.meta.url), 'utf8')

  assert.match(src, /const applying = new Set<string>\(\)/,
    'the route has no claim set; two tabs can file the same tickets twice')
  // Claimed BEFORE the first await that matters, and the 409 is how a second
  // submission is answered rather than being let through.
  assert.match(src, /if \(applying\.has\(id\)\)[\s\S]{0,160}statusCode: 409/,
    'the claim does not refuse a second submission with a 409')
  assert.match(src, /applying\.add\(id\)[\s\S]*applyReviewDecisions/,
    'the claim is taken after the Jira work has already started, which is no claim at all')
  assert.match(src, /finally \{\s*applying\.delete\(id\)/,
    'the claim is not released in a finally, so one failed submission wedges the run for ever')

  // The claim must cover the RESUME too, not just the apply: the resume is
  // what moves the run off awaiting_review, and until it lands a second
  // submission would still pass applyReviewDecisions' own status check.
  const claimed = src.slice(src.indexOf('applying.add(id)'), src.indexOf('applying.delete(id)'))
  assert.ok(claimed.includes('applyReviewDecisions'), 'the apply is outside the claim')
  assert.ok(claimed.includes('continueRun'), 'the resume is outside the claim, so the gate reopens before it is closed')
}

console.log('review decisions are claimed once: all checks passed')
