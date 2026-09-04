# Skills Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent's declared `skills` actually reach the model, so a skill listed on an agent changes its behaviour instead of being decoration.

**Architecture:** One shared helper builds an agent's system prompt — instructions plus the bodies of its resolved skills — and every path that runs an agent uses it. The skill resolver that already exists but has zero importers is what does the resolution.

**Tech Stack:** Nuxt 3 / Nitro server routes, `@anthropic-ai/claude-agent-sdk`, Node 24. No test framework: plain `node:assert/strict` scripts under `scripts/`.

**Spec:** none — this is a defect fix with a understood cause, not new design. The defect: `AgentFrontmatter.skills` is written by the UI, displayed by the UI, and read by nothing in the request path. `server/utils/resolveSkill.ts` exports `resolveSkillInvocation` and has **zero importers**. Consequence: an agent's page shows it "uses" `agent-browser`, while the model never sees a word of it.

## Global Constraints

- **`bun` is NOT installed.** Use `npm`. Typecheck with a pinned vue-tsc — look under `.superpowers/sdd/*/tsc-check/node_modules/vue-tsc/bin/vue-tsc.js`, or create one in a scratch dir with `npm install --no-save typescript@5.9.3 vue-tsc@3.3.11`. Exactly ONE pre-existing error is expected and is NOT yours: `scripts/test-workflow-graph.mjs(54,1): error TS1005: '=>' expected.`
- **Port 3030 is a RUNNING PRODUCTION CONTAINER.** Never use or stop it. Dev server: `npx nuxt dev --port 3031` (NOT `PORT=3031 npm run dev` — package.json hardcodes `--port 3030`). Stop it with a **targeted PID kill, never a broad `pkill`**.
- **Relative imports between `server/` and `shared/` carry explicit `.ts` extensions** — required by the plain-node test scripts. Follow the existing convention in `server/utils/workflowRunStore.ts`.
- Skill slugs are **bare**, never plugin-prefixed: `systematic-debugging`, not `superpowers:systematic-debugging`.
- Backward compatibility: an agent that declares no `skills` must produce a byte-identical system prompt to today's.

---

### Task 1: One helper that builds an agent's system prompt

**Files:**
- Create: `server/utils/agentSystemPrompt.ts`
- Test: `scripts/test-agent-system-prompt.mjs`

**Interfaces:**
- Consumes: `resolveSkillInvocation` from `server/utils/resolveSkill.ts` (currently dead code — this is its first caller).
- Produces: `buildAgentSystemPrompt(opts: BuildPromptOpts): Promise<string>` where
  `BuildPromptOpts = { agentSlug: string, agentName?: string, agentBody: string, skills?: string[], cwd: string }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-agent-system-prompt.mjs`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/test-agent-system-prompt.mjs`
Expected: FAIL — cannot resolve `../server/utils/agentSystemPrompt.ts`.

- [ ] **Step 3: Implement the helper**

Create `server/utils/agentSystemPrompt.ts`:

```ts
import { resolveSkillInvocation } from './resolveSkill.ts'

export interface BuildPromptOpts {
  agentSlug: string
  agentName?: string
  agentBody: string
  /** Bare skill slugs from the agent's frontmatter. */
  skills?: string[]
  cwd: string
}

/**
 * The system prompt for one agent: its instructions, the bodies of the skills it
 * declares, and its working directory.
 *
 * Before this existed, `frontmatter.skills` was written by the UI, displayed by
 * the UI, and read by nothing — an agent's page could show it "using" a skill
 * the model never saw. Every path that runs an agent must build its prompt here,
 * or that divergence comes straight back.
 */
export async function buildAgentSystemPrompt(opts: BuildPromptOpts): Promise<string> {
  const name = opts.agentName || opts.agentSlug
  const parts = [
    `You are "${name}", a specialized agent. Follow these instructions precisely:`,
    '',
    opts.agentBody,
  ]

  const bodies: string[] = []
  for (const slug of opts.skills ?? []) {
    try {
      const skill = await resolveSkillInvocation(slug)
      // An unresolvable slug is skipped, not fatal: one typo in a skills list
      // must not stop the agent from running at all.
      if (skill?.body?.trim()) bodies.push(`### ${skill.name}\n\n${skill.body.trim()}`)
    } catch {
      // Same reasoning — a broken skill file degrades that skill, nothing more.
    }
  }

  if (bodies.length) {
    parts.push(
      '',
      '## Skills available to you',
      '',
      'These are loaded because this agent declares them. Follow them as you would',
      'your own instructions above.',
      '',
      bodies.join('\n\n'),
    )
  }

  parts.push('', `The current working directory is: ${opts.cwd}`)
  return parts.join('\n')
}
```

- [ ] **Step 4: Run the test until it passes**

Run: `node scripts/test-agent-system-prompt.mjs`
Expected: `agentSystemPrompt: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add server/utils/agentSystemPrompt.ts scripts/test-agent-system-prompt.mjs
git commit -m "feat: build agent system prompts from instructions plus declared skills"
```

---

### Task 2: Use the helper everywhere an agent runs

**Files:**
- Modify: `server/api/chat.post.ts` (the agent branch that builds `systemAppend`)
- Modify: `server/utils/agentCaller.ts` (the server-side runner's caller)

**Interfaces:**
- Consumes: `buildAgentSystemPrompt` from Task 1.
- Produces: nothing new — both call sites now produce identical prompts for the same agent.

- [ ] **Step 1: Find every place an agent prompt is built**

```bash
grep -rn "specialized agent" server/ --include=*.ts
```
Expect at least `server/api/chat.post.ts` and `server/utils/agentCaller.ts`. Read each; both construct the same sentence by hand today, which is exactly the divergence this task removes.

- [ ] **Step 2: Replace the hand-built prompt in `chat.post.ts`**

In the agent branch, where `systemAppend` is currently assembled from the agent name, body and `claudeDir`, replace that construction with:

```ts
systemAppend = await buildAgentSystemPrompt({
  agentSlug: body.agentSlug,
  agentName: frontmatter.name,
  agentBody: agentBody,
  skills: frontmatter.skills,
  cwd: resolvedCwd,
})
```

Add the import at the top: `import { buildAgentSystemPrompt } from '../utils/agentSystemPrompt'`.

Leave the non-agent branch (`defaultManagerPrompt`) and the output-style appending exactly as they are — this task changes what an *agent* prompt contains, nothing else.

- [ ] **Step 3: Replace the hand-built prompt in `agentCaller.ts`**

Same substitution, using that file's own resolved `cwd` and the frontmatter it already parses. Add:
`import { buildAgentSystemPrompt } from './agentSystemPrompt.ts'`

- [ ] **Step 4: Prove a skill body actually reaches a live agent**

This is the acceptance test, and it must be observed, not assumed.

```bash
npx nuxt dev --port 3031    # background it; NOT PORT=3031 npm run dev
```

Create a scratch agent that declares a skill, using the app's own API:
```bash
curl -s -X POST localhost:3031/api/agents -H 'content-type: application/json' -d '{
  "frontmatter": {"name":"skill-probe","description":"probe","skills":["agent-browser"]},
  "body":"Say only the word READY."
}' | head -c 200
```

Then confirm resolution end to end. Do NOT rely on the model's reply — instead, add a temporary `console.log` of the built prompt in `agentCaller.ts` (or call `buildAgentSystemPrompt` directly in a `node -e` against the real `CLAUDE_DIR`) and confirm the `agent-browser` skill's text appears in it. State in your report exactly which method you used.

Remove the scratch agent (`DELETE /api/agents/skill-probe`) and any temporary logging. Stop the dev server with a targeted PID kill.

- [ ] **Step 5: Confirm no regression for agents without skills**

```bash
node scripts/test-agent-system-prompt.mjs
node scripts/test-agent-tool-policy.mjs
node scripts/test-workflow-run-store.mjs
node scripts/test-workflow-graph.mjs
node scripts/test-workflow-templates.mjs
```
plus the pinned typecheck. An agent with no `skills` must still get the same prompt shape it got before — assertion 1 of Task 1's test covers this.

- [ ] **Step 6: Commit**

```bash
git add server/api/chat.post.ts server/utils/agentCaller.ts
git commit -m "fix: agents' declared skills now reach the model"
```

---

## Follow-on, deliberately not in this plan

`server/utils/claudeSdk.ts`, `server/utils/providers/claudeProvider.ts` and
`server/api/agents/improve-instructions.post.ts` also build prompts. They serve
the chat-mode and provider paths rather than agent execution, and folding them in
here would widen a defect fix into a refactor. Worth a follow-up pass to confirm
whether any of them runs an agent that declares skills.
