/**
 * Self-check for buildAgentSystemPrompt. Uses a temp CLAUDE_DIR with real skill
 * files on disk, so it proves resolution actually happens rather than mocking it.
 *
 *   node scripts/test-agent-system-prompt.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'sysprompt-'))
process.env.CLAUDE_DIR = dir

mkdirSync(join(dir, 'skills', 'browser-evidence'), { recursive: true })
writeFileSync(join(dir, 'skills', 'browser-evidence', 'SKILL.md'), `---
name: browser-evidence
description: Capture browser evidence for a UI change.
---

Run the project's existing Playwright setup with tracing on.
Report n/a when the repo has no Playwright config.
`)

mkdirSync(join(dir, 'skills', 'careful-debugging'), { recursive: true })
writeFileSync(join(dir, 'skills', 'careful-debugging', 'SKILL.md'), `---
name: careful-debugging
description: Diagnose before editing.
---

Form competing hypotheses and eliminate them against observed behaviour.
`)

const { buildAgentSystemPrompt } = await import('../server/utils/agentSystemPrompt.ts')

// ── 1. No skills declared → today's prompt, unchanged ─────────────────────
{
  const prompt = await buildAgentSystemPrompt({
    agentSlug: 'plain', agentName: 'Plain', agentBody: 'Do the thing.', cwd: '/tmp/work',
  })
  assert.match(prompt, /Plain/)
  assert.match(prompt, /Do the thing\./)
  assert.match(prompt, /\/tmp\/work/, 'the cwd must be stated')
  assert.doesNotMatch(prompt, /Skills available/, 'no skills section when none are declared')
}

// ── 2. A declared skill's BODY reaches the prompt ─────────────────────────
// The whole point: not just the name, the actual instructions.
{
  const prompt = await buildAgentSystemPrompt({
    agentSlug: 'ui-agent', agentName: 'UI Agent', agentBody: 'Verify UI changes.',
    skills: ['browser-evidence'], cwd: '/tmp/work',
  })
  assert.match(prompt, /browser-evidence/, 'the skill is named')
  assert.match(prompt, /Playwright setup with tracing on/,
    'the skill BODY must reach the model — a name alone changes nothing')
  assert.match(prompt, /Report n\/a when the repo has no Playwright config/)
  assert.match(prompt, /Verify UI changes\./, 'the agent body survives alongside it')
}

// ── 3. Several skills all arrive, in declared order ───────────────────────
{
  const prompt = await buildAgentSystemPrompt({
    agentSlug: 'multi', agentBody: 'Body.',
    skills: ['careful-debugging', 'browser-evidence'], cwd: '/tmp/work',
  })
  assert.match(prompt, /competing hypotheses/)
  assert.match(prompt, /tracing on/)
  assert.ok(prompt.indexOf('competing hypotheses') < prompt.indexOf('tracing on'),
    'declared order is preserved')
}

// ── 4. An unresolvable skill is skipped, never fatal ──────────────────────
// A typo in one skill must not stop the agent from running at all.
{
  const prompt = await buildAgentSystemPrompt({
    agentSlug: 'typo', agentBody: 'Body.',
    skills: ['browser-evidence', 'does-not-exist'], cwd: '/tmp/work',
  })
  assert.match(prompt, /tracing on/, 'the resolvable skill still arrives')
  assert.match(prompt, /Body\./)
  assert.doesNotMatch(prompt, /does-not-exist[\s\S]{0,40}SKILL/,
    'the missing one contributes no body')
}

// ── 5. An empty skills array behaves like none ────────────────────────────
{
  const prompt = await buildAgentSystemPrompt({
    agentSlug: 'empty', agentBody: 'Body.', skills: [], cwd: '/tmp/work',
  })
  assert.doesNotMatch(prompt, /Skills available/)
}

rmSync(dir, { recursive: true, force: true })
console.log('agentSystemPrompt: all assertions passed')
