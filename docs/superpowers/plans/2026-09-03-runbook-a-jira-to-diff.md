# Runbook A — Jira-to-Diff Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Runbook A — a one-click-installable workflow in Agent Manager that takes a pasted Jira ticket and produces an evidence-carrying pull request, running unattended.

**Architecture:** No new page and no new data model. Runbook A is a workflow template composed of seven preset agents, running on the app's existing DAG execution engine. Three small backward-compatible engine changes unblock it: agents can declare their own tools and turn budget, and a run can auto-advance between waves. Template steps gain optional `next` edges so the pipeline can fan out and fan back in.

**Tech Stack:** Nuxt 3 / Vue 3, TypeScript, `@anthropic-ai/claude-agent-sdk`, Nuxt server API (Nitro). No test framework in this repo — tests are plain `node:assert` scripts under `scripts/`, run with `node scripts/<name>.mjs`, following the existing `scripts/test-workflow-graph.mjs` pattern.

**Spec:** `docs/superpowers/specs/2026-09-03-runbook-a-jira-to-diff-design.md`

## Global Constraints

- **Model constants only.** Never write `'sonnet'` / `'opus'` as string literals. Import `MODEL` from `~/utils/models` and use `MODEL.SONNET` / `MODEL.OPUS`. (Repo rule, `CLAUDE.md` § Model Registry Design.)
- **Backward compatibility is non-negotiable.** Every existing agent, template and workflow must behave byte-for-byte as it does today. New frontmatter fields are optional; absent means today's behavior.
- **Existing default toolset** (when an agent declares no `tools`): `['Read', 'Write', 'Edit', 'Glob', 'Grep']`.
- **Existing default turn budget** (when an agent declares no `maxTurns`): `10`.
- **Type imports in server code** use `import type { X } from '~/types'` — an established pattern (see `server/utils/relationships.ts:1`). Runtime imports from `app/utils/` are NOT available server-side.
- **Test convention:** plain `node:assert/strict` scripts in `scripts/`, no framework. Vue composables and `.vue` files are not unit-tested in this repo; pure functions are.
- **Skill slugs are bare**, not plugin-prefixed: `systematic-debugging`, not `superpowers:systematic-debugging`. Confirmed against `server/api/agents/[slug]/skills.get.ts`'s plugin-scan branch.

---

### Task 1: Agents declare their own tools and turn budget

Today `server/api/chat.post.ts` hardcodes the toolset and turn cap for every agent call, and the already-defined `AgentFrontmatter.tools` field is read nowhere. Without this task no pipeline step can run a shell command, and any step is capped at 10 tool calls.

**Files:**
- Modify: `app/types/index.ts:5-13` (add `maxTurns` to `AgentFrontmatter`)
- Create: `server/utils/agentToolPolicy.ts`
- Modify: `server/api/chat.post.ts:103-118` (capture frontmatter), `server/api/chat.post.ts:151,154` (use resolved values)
- Test: `scripts/test-agent-tool-policy.mjs`

**Interfaces:**
- Consumes: `AgentFrontmatter` from `~/types`
- Produces:
  - `resolveAllowedTools(frontmatter?: Pick<AgentFrontmatter, 'tools'>): string[]`
  - `resolveMaxTurns(frontmatter?: Pick<AgentFrontmatter, 'maxTurns'>): number`
  - `DEFAULT_ALLOWED_TOOLS: readonly string[]`, `DEFAULT_MAX_TURNS: number`

- [ ] **Step 1: Add `maxTurns` to the agent frontmatter type**

In `app/types/index.ts`, extend the existing interface (leave every other field untouched):

```ts
export interface AgentFrontmatter {
  name: string
  description: string
  model?: AgentModel
  color?: string
  memory?: AgentMemory
  skills?: string[]
  tools?: AgentTool[]
  /** Tool-call budget for one turn of this agent. Absent means the server default. */
  maxTurns?: number
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/test-agent-tool-policy.mjs`:

```js
/**
 * Self-check for server/utils/agentToolPolicy.ts - how an agent's frontmatter
 * decides its toolset and turn budget. No test framework in this repo: plain asserts.
 *
 *   node scripts/test-agent-tool-policy.mjs
 */
import assert from 'node:assert/strict'
import {
  resolveAllowedTools,
  resolveMaxTurns,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_MAX_TURNS,
} from '../server/utils/agentToolPolicy.ts'

// ── 1. No frontmatter at all falls back to today's behaviour ──────────────
assert.deepEqual(resolveAllowedTools(undefined), [...DEFAULT_ALLOWED_TOOLS])
assert.equal(resolveMaxTurns(undefined), DEFAULT_MAX_TURNS)

// ── 2. An agent that declares nothing keeps today's behaviour ─────────────
assert.deepEqual(resolveAllowedTools({}), [...DEFAULT_ALLOWED_TOOLS])
assert.equal(resolveMaxTurns({}), DEFAULT_MAX_TURNS)
assert.deepEqual(DEFAULT_ALLOWED_TOOLS, ['Read', 'Write', 'Edit', 'Glob', 'Grep'])
assert.equal(DEFAULT_MAX_TURNS, 10)

// ── 3. A declared toolset is used verbatim, Bash included ─────────────────
assert.deepEqual(
  resolveAllowedTools({ tools: ['Bash', 'Read', 'Glob'] }),
  ['Bash', 'Read', 'Glob'],
)

// ── 4. An empty tools array is a declaration, not an absence ──────────────
// A step that should touch nothing must be able to say so.
assert.deepEqual(resolveAllowedTools({ tools: [] }), [])

// ── 5. A declared turn budget wins; nonsense values fall back ─────────────
assert.equal(resolveMaxTurns({ maxTurns: 40 }), 40)
assert.equal(resolveMaxTurns({ maxTurns: 0 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: -5 }), DEFAULT_MAX_TURNS)
assert.equal(resolveMaxTurns({ maxTurns: 2.5 }), DEFAULT_MAX_TURNS)

console.log('agentToolPolicy: all assertions passed')
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node scripts/test-agent-tool-policy.mjs`
Expected: FAIL — cannot resolve `../server/utils/agentToolPolicy.ts` (module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `server/utils/agentToolPolicy.ts`:

```ts
import type { AgentFrontmatter } from '~/types'

/** What every agent got before frontmatter could say otherwise. */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const

export const DEFAULT_MAX_TURNS = 10

/**
 * An agent's toolset. An explicit `tools` array is honoured exactly - including an
 * empty one, which is a deliberate "touch nothing" declaration, not an omission.
 */
export function resolveAllowedTools(frontmatter?: Pick<AgentFrontmatter, 'tools'>): string[] {
  const declared = frontmatter?.tools
  if (Array.isArray(declared)) return [...declared]
  return [...DEFAULT_ALLOWED_TOOLS]
}

/** An agent's turn budget. Only a positive integer overrides the default. */
export function resolveMaxTurns(frontmatter?: Pick<AgentFrontmatter, 'maxTurns'>): number {
  const declared = frontmatter?.maxTurns
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_TURNS
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-agent-tool-policy.mjs`
Expected: PASS — `agentToolPolicy: all assertions passed`

- [ ] **Step 6: Wire the resolved values into the chat endpoint**

In `server/api/chat.post.ts`, add the import beside the existing ones at the top:

```ts
import { resolveAllowedTools, resolveMaxTurns } from '../utils/agentToolPolicy'
import type { AgentFrontmatter } from '~/types'
```

Then in the agent branch (currently `chat.post.ts:103-118`), keep the frontmatter so the options block can read it. Replace:

```ts
  if (body.agentSlug) {
    const agentPath = resolveClaudePath('agents', `${body.agentSlug}.md`)
    if (existsSync(agentPath)) {
      const { parseFrontmatter } = await import('../utils/frontmatter')
      const raw = await readFile(agentPath, 'utf-8')
      const { frontmatter, body: agentBody } = parseFrontmatter<{ name?: string }>(raw)
      const agentName = frontmatter.name || body.agentSlug
```

with:

```ts
  let agentFrontmatter: AgentFrontmatter | undefined

  if (body.agentSlug) {
    const agentPath = resolveClaudePath('agents', `${body.agentSlug}.md`)
    if (existsSync(agentPath)) {
      const { parseFrontmatter } = await import('../utils/frontmatter')
      const raw = await readFile(agentPath, 'utf-8')
      const { frontmatter, body: agentBody } = parseFrontmatter<AgentFrontmatter>(raw)
      agentFrontmatter = frontmatter
      const agentName = frontmatter.name || body.agentSlug
```

(The rest of that block — `systemAppend = ...`, the `else` branches — is unchanged.)

Then in the `query({ options: { ... } })` block, replace the two hardcoded lines (`chat.post.ts:151` and `:154`):

```ts
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
```
```ts
        maxTurns: 10,
```

with:

```ts
        allowedTools: resolveAllowedTools(agentFrontmatter),
```
```ts
        maxTurns: resolveMaxTurns(agentFrontmatter),
```

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add app/types/index.ts server/utils/agentToolPolicy.ts server/api/chat.post.ts scripts/test-agent-tool-policy.mjs
git commit -m "feat: let agents declare their own tools and turn budget"
```

---

### Task 2: Auto-run — a workflow can advance itself between waves

Today `useWorkflowExecution.ts` always pauses after a wave and waits for a click, so an unattended pipeline is impossible. This adds an opt-in auto-advance. Default is off; every existing workflow is unaffected.

**Files:**
- Modify: `app/composables/useWorkflowExecution.ts` (module state, `runWave` tail, `run` signature)
- Modify: `app/components/WorkflowRunModal.vue` (checkbox + third emit arg)
- Modify: `app/pages/workflows/[slug].vue:268-277` (`startRun` signature)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `run(workflow: Workflow, initialPrompt: string, projectDir?: string, autoRun?: boolean): Promise<void>` — the fourth parameter is new and defaults to `false`. `WorkflowRunModal`'s `start` event becomes `[prompt: string, projectDir: string | undefined, autoRun: boolean]`.

- [ ] **Step 1: Add the auto-run flag to the composable's run state**

In `app/composables/useWorkflowExecution.ts`, beside the existing module-level run state (`let _workflow: Workflow | null = null` and friends), add:

```ts
  /** When true, each finished wave rolls straight into the next instead of pausing. */
  let _autoRun = false
```

- [ ] **Step 2: Make a finished wave advance itself**

In the same file, at the tail of `runWave()`, replace:

```ts
    nextStepIds.value = readyNodes(_graph, _state).slice(0, MAX_CONCURRENCY)
    isPaused.value = true
  }
```

with:

```ts
    nextStepIds.value = readyNodes(_graph, _state).slice(0, MAX_CONCURRENCY)

    // Failures and ABORT verdicts have already returned above, so reaching here means
    // the run is healthy and a human gate is the only thing that would stop it.
    if (_autoRun) {
      await runWave()
      return
    }

    isPaused.value = true
  }
```

- [ ] **Step 3: Accept the flag when a run starts**

In the same file, change the `run` signature and set the flag alongside the other run state:

```ts
  async function run(workflow: Workflow, initialPrompt: string, projectDir?: string, autoRun = false) {
    if (isRunning.value || !workflow.steps.length) return

    const { workingDir } = useWorkingDir()
    _workflow = workflow
    _projectDir = projectDir || workingDir.value || undefined
    _initialPrompt = initialPrompt
    _autoRun = autoRun
```

(The remainder of `run` — graph build, state reset, `await runWave()` — is unchanged.)

- [ ] **Step 4: Offer the toggle in the run modal**

In `app/components/WorkflowRunModal.vue`, change the emit type:

```ts
const emit = defineEmits<{
  'update:open': [value: boolean]
  start: [prompt: string, projectDir: string | undefined, autoRun: boolean]
}>()
```

Add the ref beside the existing ones:

```ts
const autoRun = ref(false)
```

Update `onStart` and `onCancel` to carry and reset it:

```ts
function onStart() {
  if (!prompt.value.trim()) return
  emit('start', prompt.value.trim(), projectDir.value.trim() || undefined, autoRun.value)
  prompt.value = ''
  projectDir.value = ''
}

function onCancel() {
  emit('update:open', false)
  prompt.value = ''
  projectDir.value = workingDir.value
  autoRun.value = false
}
```

Add the control to the template, directly after the "Project folder" `div.field-group` and before the closing `</div>` of `.space-y-4`:

```vue
            <div class="field-group">
              <label class="flex items-center gap-2 cursor-pointer">
                <input v-model="autoRun" type="checkbox" class="shrink-0">
                <span class="field-label mb-0">Run to completion without pausing</span>
              </label>
              <span class="field-hint">
                Each step starts as soon as the one before it finishes. A failed step or an
                aborting monitor still stops the run.
              </span>
            </div>
```

- [ ] **Step 5: Thread it through the page**

In `app/pages/workflows/[slug].vue`, change `startRun` (currently line 268):

```ts
async function startRun(prompt: string, projectDir?: string, autoRun = false) {
  showRunModal.value = false
  if (!workflow.value) return
  const w = { ...workflow.value, steps: workflowSteps.value }
  await run(w, prompt, projectDir, autoRun)
  try {
    await update(slug, { lastRunAt: new Date().toISOString() } as any)
  } catch {
    // Non-critical
  }
}
```

The template's `@start="startRun"` binding forwards arguments positionally and needs no change.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 7: Verify by hand in the running app**

This repo unit-tests pure functions only — Vue composables and `.vue` files have no test harness — so this step is a manual check against the dev server.

Run: `bun run dev`, open `http://localhost:3030/workflows`, open any existing multi-step workflow, click Run.
Expected, with the box **unticked**: the run stops after the first step and shows the "Continue" bar, exactly as before this task.
Expected, with the box **ticked**: every step runs back-to-back with no Continue bar, and the run ends on its own.

- [ ] **Step 8: Commit**

```bash
git add app/composables/useWorkflowExecution.ts app/components/WorkflowRunModal.vue app/pages/workflows/[slug].vue
git commit -m "feat: add auto-run option so a workflow can advance between waves"
```

---

### Task 3: Workflow templates can describe a graph, not just a chain

Template steps are materialized into `WorkflowStep`s with no `next`, so a template can only ever produce a straight line. Runbook A needs a fan-out and a fan-in.

**Files:**
- Modify: `app/utils/workflowTemplates.ts` (step type + new pure function)
- Modify: `app/pages/workflows/index.vue:25-46` (`useWorkflowTemplate`)
- Test: `scripts/test-workflow-templates.mjs`

**Interfaces:**
- Consumes: `WorkflowStep` from `~/types`.
- Produces: `materializeTemplateSteps(template: WorkflowTemplate, agentSlugByTemplateId: Record<string, string>): WorkflowStep[]`. `WorkflowTemplate.steps[]` entries gain an optional `next?: string[]` whose members are **`agentTemplateId` values of other steps in the same template**.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-workflow-templates.mjs`:

```js
/**
 * Self-check for materializeTemplateSteps in app/utils/workflowTemplates.ts - turning a
 * template's local ids into a real workflow's generated step ids, edges included.
 *
 *   node scripts/test-workflow-templates.mjs
 */
import assert from 'node:assert/strict'
import { materializeTemplateSteps } from '../app/utils/workflowTemplates.ts'

const slugs = { alpha: 'agent-alpha', beta: 'agent-beta', gamma: 'agent-gamma' }

// ── 1. A template with no `next` stays a plain chain ──────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(steps.length, 2)
  assert.deepEqual(steps.map(s => s.agentSlug), ['agent-alpha', 'agent-beta'])
  assert.deepEqual(steps.map(s => s.label), ['A', 'B'])
  // No explicit edges - the graph builder reads these in array order, as it does today.
  assert.equal(steps[0].next, undefined)
  assert.equal(steps[1].next, undefined)
}

// ── 2. Every step gets its own unique generated id ────────────────────────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A' },
      { agentTemplateId: 'beta', label: 'B' },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  assert.equal(new Set(steps.map(s => s.id)).size, 2)
  assert.ok(steps.every(s => typeof s.id === 'string' && s.id.length > 0))
}

// ── 3. `next` is translated from template ids to generated step ids ───────
{
  const template = {
    id: 't', name: 'T', description: '', icon: '',
    steps: [
      { agentTemplateId: 'alpha', label: 'A', next: ['beta', 'gamma'] },
      { agentTemplateId: 'beta', label: 'B', next: ['gamma'] },
      { agentTemplateId: 'gamma', label: 'C', next: [] },
    ],
  }
  const steps = materializeTemplateSteps(template, slugs)
  const byLabel = Object.fromEntries(steps.map(s => [s.label, s]))

  assert.deepEqual(byLabel.A.next, [byLabel.B.id, byLabel.C.id], 'A fans out to B and C')
  assert.deepEqual(byLabel.B.next, [byLabel.C.id], 'B joins into C')
  // An explicit empty `next` marks a terminal node and must survive as an empty array,
  // not collapse to "no edges declared".
  assert.deepEqual(byLabel.C.next, [])
  // Nothing may still be pointing at a template-local id.
  const ids = new Set(steps.map(s => s.id))
  for (const step of steps) for (const target of step.next ?? []) assert.ok(ids.has(target))
}

console.log('workflowTemplates: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-workflow-templates.mjs`
Expected: FAIL — `materializeTemplateSteps` is not exported from `workflowTemplates.ts`.

- [ ] **Step 3: Write the implementation**

In `app/utils/workflowTemplates.ts`, replace the top of the file (the interface and its imports) with:

```ts
import type { WorkflowStep } from '~/types'

export interface WorkflowTemplateStep {
  agentTemplateId: string
  label: string
  /**
   * `agentTemplateId` values of steps in this same template that follow this one.
   * Absent means "the next step in array order", which is how every template
   * behaved before graphs were expressible here.
   */
  next?: string[]
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icon: string
  steps: WorkflowTemplateStep[]
}

/**
 * Turn a template into real workflow steps. Template steps refer to each other by
 * `agentTemplateId`; the workflow they become refers to generated step ids, so every
 * `next` has to be translated through the same map.
 *
 * `agentSlugByTemplateId` must have an entry for every step passed in - the caller
 * filters out steps whose agent template could not be resolved before calling.
 */
export function materializeTemplateSteps(
  template: WorkflowTemplate,
  agentSlugByTemplateId: Record<string, string>,
): WorkflowStep[] {
  // The global crypto, not node:crypto - this module is bundled for the browser too.
  const stepIdByTemplateId: Record<string, string> = {}
  for (const step of template.steps) stepIdByTemplateId[step.agentTemplateId] = crypto.randomUUID()

  return template.steps.map((step) => {
    const materialized: WorkflowStep = {
      id: stepIdByTemplateId[step.agentTemplateId]!,
      agentSlug: agentSlugByTemplateId[step.agentTemplateId]!,
      label: step.label,
    }
    if (step.next) {
      materialized.next = step.next.map(target => stepIdByTemplateId[target]!)
    }
    return materialized
  })
}
```

Leave the existing `workflowTemplates` array below it exactly as it is — none of its entries declare `next`, so all three keep behaving as chains.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-workflow-templates.mjs`
Expected: PASS — `workflowTemplates: all assertions passed`

- [ ] **Step 5: Use it when installing a template**

In `app/pages/workflows/index.vue`, update the import line:

```ts
import { workflowTemplates, materializeTemplateSteps } from '~/utils/workflowTemplates'
```

Replace the body of `useWorkflowTemplate` (currently lines 25-46) with:

```ts
async function useWorkflowTemplate(templateId: string) {
  const template = workflowTemplates.find(t => t.id === templateId)
  if (!template) return
  creatingTemplate.value = templateId
  try {
    const agentSlugByTemplateId: Record<string, string> = {}
    const resolvedSteps = []

    for (const step of template.steps) {
      const agentTemplate = agentTemplates.find(t => t.id === step.agentTemplateId)
      if (!agentTemplate) continue
      let agent = agents.value.find(a => a.slug === agentTemplate.frontmatter.name)
      if (!agent) {
        agent = await createAgent({ frontmatter: { ...agentTemplate.frontmatter }, body: agentTemplate.body })
      }
      agentSlugByTemplateId[step.agentTemplateId] = agent.slug
      resolvedSteps.push(step)
    }

    const steps = materializeTemplateSteps({ ...template, steps: resolvedSteps }, agentSlugByTemplateId)
    const workflow = await create({ name: template.name, description: template.description, steps })
    router.push(`/workflows/${workflow.slug}`)
  } catch (e: any) {
    toast.add({ title: 'Failed to create', description: e.data?.message || e.message, color: 'error' })
  } finally {
    creatingTemplate.value = null
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add app/utils/workflowTemplates.ts app/pages/workflows/index.vue scripts/test-workflow-templates.mjs
git commit -m "feat: let workflow templates declare fan-out and fan-in edges"
```

---

### Task 4: The `agent-browser` skill

`sdlc-trace-capture` (Task 5) references a skill slug `agent-browser`, which exists nowhere. This creates it. It lives in the user's live Claude directory, not in this repo — Agent Manager is a GUI over `~/.claude`, it does not ship content into it.

**Files:**
- Create: `~/.claude/skills/agent-browser/SKILL.md` (outside the git repo — nothing to commit)

**Interfaces:**
- Consumes: nothing.
- Produces: a skill resolvable by the bare slug `agent-browser`, referenced by `sdlc-trace-capture.frontmatter.skills` in Task 5.

- [ ] **Step 1: Create the skill file**

```bash
mkdir -p ~/.claude/skills/agent-browser
```

Write `~/.claude/skills/agent-browser/SKILL.md`:

```markdown
---
name: agent-browser
description: Use when a code change touches a UI and needs browser evidence - drives Playwright against a running local stack and captures a trace and screenshots as reviewable proof.
context: when
---

# Browser evidence for a change

Your output is evidence a reviewer can open, not a claim that the UI works.

## Before you drive anything

1. Confirm the stack is actually serving. Curl the app's own URL and check the
   status code before opening a browser — a browser failing against a dead
   service wastes a run and produces a misleading trace.
2. Find the project's existing Playwright setup: `playwright.config.*`, a
   `test:e2e`-shaped script in `package.json`, or an `e2e/` directory. Use what
   is there. Never scaffold a new Playwright project to satisfy this step.

## If the project has no Playwright setup

Report `n/a` and say why in one line — "no Playwright config in this repo" or
"change is backend-only, no UI surface". This is a legitimate, successful
outcome. Do not install Playwright, and do not fail the step.

## Capturing the evidence

- Run the existing suite, or the single spec that covers the changed surface,
  with tracing on: `--trace on` (or the config's own tracing setting).
- Record the exact command you ran and its exit code.
- Report the trace artifact's path on disk (typically `test-results/**/trace.zip`)
  so a reviewer can open it with `npx playwright show-trace <path>`.
- If a screenshot baseline exists for the changed screen, run the comparison and
  report the diff result. If none exists, say so rather than inventing one.

## What to report

Report exactly: the command, the exit code, pass/fail counts, the trace path,
and screenshot-diff results if applicable. If the run failed, quote the failing
assertion verbatim — a summary of a failure is not evidence of one.
```

- [ ] **Step 2: Verify the app resolves the skill**

Run: `bun run dev`, then open `http://localhost:3030/skills`.
Expected: `agent-browser` appears in the skills list, with the description above.

Alternatively, without the UI: `curl -s localhost:3030/api/skills | grep -o 'agent-browser'` — expected: a match.

- [ ] **Step 3: No commit**

`~/.claude/` is the user's live config directory, not part of this repo. `git status` in the repo should show nothing from this task.

---

### Task 5: The seven pipeline agents

Pure data: seven entries appended to the existing `agentTemplates` array. They are mutually dependent (step 4's prompt refers to the file step 3 wrote), so they land together.

**Files:**
- Modify: `app/utils/templates.ts` (append seven entries to `agentTemplates`)

**Interfaces:**
- Consumes: `MODEL` from `~/utils/models`; `AgentFrontmatter.tools` / `.maxTurns` from Task 1; skill slugs `systematic-debugging`, `using-git-worktrees`, `using-superpowers` (installed superpowers plugin) and `agent-browser` (Task 4).
- Produces: agent template ids `sdlc-ticket-intake`, `sdlc-stack-provisioner`, `sdlc-test-author`, `sdlc-fix-implementer`, `sdlc-verifier`, `sdlc-trace-capture`, `sdlc-evidence-and-pr` — referenced by Task 6. Each template's `frontmatter.name` equals its `id`, which is what becomes the agent slug.

- [ ] **Step 1: Append the intake and provisioning agents**

In `app/utils/templates.ts`, append to the `agentTemplates` array (the file already imports `MODEL` from `~/utils/models`):

```ts
  {
    id: 'sdlc-ticket-intake',
    icon: 'i-lucide-inbox',
    frontmatter: {
      name: 'sdlc-ticket-intake',
      description: 'Turns a pasted support ticket into a structured context packet for the rest of the pipeline.',
      model: MODEL.SONNET,
      color: 'blue',
      tools: ['Read', 'Grep', 'Glob'],
    },
    body: `You are the intake step of a bug-fix pipeline. Your input is the raw text of a support or escalation ticket. Your output is the context packet every later step reads.

Produce exactly these sections, in this order:

## Problem
What is broken, in one or two sentences, in the reporter's terms.

## Affected system
The product and, where you can tell, the repository and the area of it. Say "unclear" rather than guessing — a wrong repo sends the whole pipeline to the wrong place.

## Reported example
The specific input, record, or steps that reproduced it, quoted from the ticket verbatim. If the ticket has none, say so explicitly — the next steps need to know they are working without one.

## Generalisation
The *class* of input this example belongs to: what else would fail the same way. This is what the test step turns into a table of cases, so name the dimension that varies (a delimiter, a date boundary, a state transition, a concurrent pair).

## Constraints and truths
Anything in the ticket that limits the fix: versions, customer, deployment shape, data that cannot change.

## Open questions
What a human must answer before the fix is trustworthy. Empty is a valid answer.

Rules:
- Never invent detail the ticket does not contain. "Not stated" is the correct output for a missing field.
- Do not propose a fix. Later steps do that, and an early guess anchors them badly.
- Keep it short enough to read in a minute.`,
  },
  {
    id: 'sdlc-stack-provisioner',
    icon: 'i-lucide-container',
    frontmatter: {
      name: 'sdlc-stack-provisioner',
      description: 'Stands up the affected product stack locally from the shared compose repo, seeded and healthy.',
      model: MODEL.SONNET,
      color: 'orange',
      tools: ['Bash', 'Read', 'Glob'],
      maxTurns: 40,
      skills: ['using-git-worktrees', 'using-superpowers'],
    },
    body: `You stand up the environment the rest of the pipeline tests against. Nothing downstream works if you get this wrong, and a stack you *believe* is up but is not produces a false FAIL that wastes the whole run.

## Conventions in this estate

The deployment repo is \`alepo-dev-team-infra\`: one \`docker-compose.<product>.yml\` per product, each behind a \`--profile\`, all joined on the external \`alepo-shared\` network (subnet pinned \`10.20.23.0/24\`). Images come from GHCR, tagged via the \`TAG\` variable — never \`IMAGE_TAG\`. Env keys are prefixed per service (\`PMS_*\`, \`SELFCARE_*\`, \`WSO2MI_*\`); a missing prefix is a recurring source of silent misconfiguration.

- Bring up **only** the profile(s) the context packet's affected system needs. Databases (MongoDB, MariaDB) and Keycloak come from the \`database\` and \`sso\` stacks, not from a product's own file, and compose cannot express \`depends_on\` across files — start those first if the product needs them.
- Address services by their **container-internal service name and port**, never the host-published port. Routing container-to-container via a host IP hits the host firewall and produces a *timeout*, not a connection refused — that signature means you used the wrong address, not that the service is down.
- Work on the host you are running on. Do not attempt to reach a shared lab host over SSH.

## What "up" means

A container that is running is not a service that is serving. Confirm health through each service's own healthcheck endpoint or an actual request that returns data. If a container restart-loops with an empty \`docker logs\` and exit code 0, the app is writing to a file log, not stdout — copy the log directory out of the container and read it rather than guessing.

## Seeding

If the context packet names a customer or specific records, seed representative data for them — including a second subscriber or account where the bug involves interaction between two. A single-record environment hides exactly the class of bug that matters.

## Report

State: which profiles you brought up, the exact commands, how you confirmed health (the request and its response, not "it looked fine"), what you seeded, and the service addresses later steps should use. If you could not bring the stack up, say precisely what failed and stop — do not let the pipeline proceed against an environment that is not there.`,
  },
```

- [ ] **Step 2: Append the test-authoring and fix agents**

Continue appending to the same array:

```ts
  {
    id: 'sdlc-test-author',
    icon: 'i-lucide-flask-conical',
    frontmatter: {
      name: 'sdlc-test-author',
      description: 'Writes a parameterised failing test that generalises the reported bug, and proves it fails.',
      model: MODEL.OPUS,
      color: 'red',
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      maxTurns: 30,
      skills: ['using-superpowers'],
    },
    body: `You write the oracle. Everything after you is judged against the test you produce, so a test that passes for the wrong reason is worse than no test.

## Generalise before you write

The ticket reports one example. Write a **table-driven / parameterised** test covering the class that example belongs to — five or six rows, not one. Use the context packet's "Generalisation" section as the dimension that varies. For a parsing bug that means several separator and boundary cases; for a date bug, the month and year boundaries plus the invariant that should hold across all of them; for a state machine, each transition that can arrive out of order.

A single-row test lets a fix pass by special-casing the reported input. That is the failure mode you exist to prevent.

## Fit the repo, do not reinvent it

Find the project's existing test framework and follow it exactly — its directory layout, naming, fixtures and runner. Read a neighbouring test first. Never introduce a new framework, and never add a dependency to make your test run.

## Prove it fails

Run the test against the current, unfixed code and capture the output **verbatim**. That FAIL output is evidence in the final bundle, not a formality — quote it, do not summarise it. If the test passes on unfixed code, you have not reproduced the bug: say so plainly and stop, rather than weakening the test until it goes red.

## Report

State: the test file path (later steps must not edit it), the exact run command, the verbatim FAIL output, and one line per row explaining what that row covers.`,
  },
  {
    id: 'sdlc-fix-implementer',
    icon: 'i-lucide-wrench',
    frontmatter: {
      name: 'sdlc-fix-implementer',
      description: 'Diagnoses the root cause and writes the minimal fix, without touching the test that proves it.',
      model: MODEL.OPUS,
      color: 'green',
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
      maxTurns: 30,
      skills: ['systematic-debugging', 'using-git-worktrees', 'using-superpowers'],
    },
    body: `You fix the cause, not the symptom. The failing test from the previous step defines done.

## The test file is locked

**Do not modify the test file named in the previous step's report, or any file under a \`test\`, \`tests\`, \`spec\` or \`__tests__\` directory, under any circumstance.** If you believe the test itself is wrong, stop and say so in your report — do not edit it. A green test you were free to rewrite is worth nothing as evidence, which is the entire point of this pipeline.

## Method

Diagnose before you edit. Read the failing path, form competing hypotheses, and eliminate them against the actual behaviour rather than fixing the first plausible thing. When you rule one out, say so — a recorded elimination is worth more to the reviewer than a confident guess.

Then make the **smallest** change that addresses the root cause:
- Do not refactor surrounding code, rename things, or tidy while you are in there.
- Do not add error handling for cases that cannot occur, or defend against inputs the type system already constrains.
- Do not add a feature flag or a compatibility shim unless the ticket asks for one.

## Estate conventions that apply to a fix

- Structured logging is RFC 5424 with PEN 36713 — match the surrounding code's logging shape rather than introducing a new one.
- Schema changes go through Liquibase with a tag that can be rolled back, never a hand-written migration.
- Deployment truths constrain correctness: services in this estate commonly run more than one node, so per-process in-memory state is not a correctness mechanism. A fix that only works single-node is not a fix.

## Report

State: the root cause in one or two sentences naming the file and line, what you changed and why, which hypotheses you eliminated on the way, and confirmation that you did not touch the test file.`,
  },
```

- [ ] **Step 3: Append the verification, trace and PR agents**

Continue appending to the same array:

```ts
  {
    id: 'sdlc-verifier',
    icon: 'i-lucide-check-check',
    frontmatter: {
      name: 'sdlc-verifier',
      description: 'Proves the fix passes every row of the new test and breaks nothing that passed before.',
      model: MODEL.SONNET,
      color: 'green',
      tools: ['Bash', 'Read', 'Glob'],
      maxTurns: 20,
      skills: ['using-superpowers'],
    },
    body: `You produce the PASS half of the evidence. You verify; you do not fix. If something is broken, report it — do not edit code to make your own step succeed.

## What to run

1. The parameterised test from the test-authoring step. Every row must pass. A partial pass is a failure, and which rows failed is the important part of the report.
2. The repo's existing test suite for the area that changed — the module's own tests at minimum, the full suite if it runs in reasonable time.
3. The repo's own lint, format and type gates. Green unit tests with a red typecheck is the single most common way a local pass turns into a red pipeline.

## Evidence, not adjectives

Capture output **verbatim**: the command, its exit code, and the pass/fail counts. Quote failures in full. Never write "tests pass" without the output that shows it — the reviewer's whole job is reading this rather than re-running it.

If a test was already failing before the fix, say so explicitly and distinguish it from anything the fix broke. A pre-existing failure is context; a new one is a blocker.

## Report

State, for each of the three runs above: the command, the exit code, the counts, and the verbatim output of anything that failed. End with a one-line verdict: does this change pass, and is anything now failing that was not failing before.`,
  },
  {
    id: 'sdlc-trace-capture',
    icon: 'i-lucide-monitor-play',
    frontmatter: {
      name: 'sdlc-trace-capture',
      description: 'Captures browser evidence for UI-facing changes, or reports cleanly that none applies.',
      model: MODEL.SONNET,
      color: 'purple',
      tools: ['Bash', 'Read', 'Glob'],
      maxTurns: 20,
      skills: ['agent-browser'],
    },
    body: `You capture browser evidence for the change, against the stack the provisioning step brought up.

Follow the \`agent-browser\` skill. In short: confirm the app is actually serving before opening a browser, use the repo's existing Playwright setup rather than scaffolding one, run with tracing on, and report the exact command, exit code, pass/fail counts and the trace artifact path so a reviewer can open it.

If the repo has no Playwright setup, or the change has no UI surface, report \`n/a\` with a one-line reason. That is a successful outcome — a backend fix must not be blocked on a browser step with nothing to test. Do not install Playwright to avoid saying \`n/a\`.

## Report

Either the captured evidence (command, exit code, counts, trace path, screenshot-diff result if a baseline exists), or \`n/a\` and why.`,
  },
  {
    id: 'sdlc-evidence-and-pr',
    icon: 'i-lucide-git-pull-request',
    frontmatter: {
      name: 'sdlc-evidence-and-pr',
      description: 'Assembles the evidence bundle and opens the pull request carrying it.',
      model: MODEL.SONNET,
      color: 'blue',
      tools: ['Bash', 'Read', 'Write', 'Glob'],
      maxTurns: 15,
    },
    body: `You produce the deliverable. The deliverable is the **evidence bundle**, not the diff — a reviewer should be able to decide from your PR body whether the change is trustworthy, without re-deriving any of it.

## Assemble the bundle

The PR body is exactly these sections:

## Context
The intake step's context packet: problem, affected system, reported example.

## Failing test
The test file path, what its rows cover, and the **verbatim** FAIL output from before the fix.

## The fix
Root cause in one or two sentences naming file and line, and what changed.

## Verification
Verbatim PASS output for every row, plus the regression suite and lint/typecheck results with their exit codes.

## Browser evidence
The trace path and result, or \`n/a\` and why.

## Provenance
The agents that ran, the model each used, and the working directory. State plainly that this change was produced by an automated pipeline and needs human review before merge.

## Open the PR

- Branch name: \`fix/<TICKET-KEY>\` — take the key from the context packet. If there is no key, use a short descriptive slug prefixed \`fix/\`.
- Commit subject: \`<TICKET-KEY>: <what this lands>\` (no space before the colon). No attribution trailers.
- **Never push to \`main\`, \`develop\` or \`ci-release\`.** Push your branch and open a PR against the repository's normal target branch.
- Write the bundle to a file and pass it with \`gh pr create --body-file\`, so nothing is lost to shell quoting.

If \`gh\` is not authenticated, stop after pushing the branch and report that the PR still needs opening — the work is not lost, it just is not a PR yet.

## Report

State: the branch name, the commit SHA, the PR URL, and confirmation the bundle's sections are all populated (any section reading "not captured" is a gap the reviewer needs flagged, not hidden).`,
  },
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no new errors. In particular `tools`, `maxTurns` and `skills` must all be accepted on `AgentFrontmatter` — if `maxTurns` errors, Task 1 Step 1 was skipped.

- [ ] **Step 5: Commit**

```bash
git add app/utils/templates.ts
git commit -m "feat: add the seven Runbook A pipeline agent templates"
```

---

### Task 6: Register the Runbook A workflow template

**Files:**
- Modify: `app/utils/workflowTemplates.ts` (append one entry to `workflowTemplates`)

**Interfaces:**
- Consumes: `WorkflowTemplateStep.next` (Task 3), the seven agent template ids (Task 5).
- Produces: workflow template id `runbook-a-jira-to-diff`, installable from `/workflows`.

- [ ] **Step 1: Append the template**

In `app/utils/workflowTemplates.ts`, append to the `workflowTemplates` array:

```ts
  {
    id: 'runbook-a-jira-to-diff',
    name: 'Runbook A — Ticket to Evidence-Backed PR',
    description: 'Paste a support ticket: stands up the stack, writes a failing parameterised test, fixes the cause, verifies, and opens a PR carrying the evidence bundle.',
    icon: 'i-lucide-git-pull-request-arrow',
    steps: [
      { agentTemplateId: 'sdlc-ticket-intake', label: 'Ticket Intake', next: ['sdlc-stack-provisioner'] },
      { agentTemplateId: 'sdlc-stack-provisioner', label: 'Stand Up Stack', next: ['sdlc-test-author'] },
      { agentTemplateId: 'sdlc-test-author', label: 'Failing Test', next: ['sdlc-fix-implementer'] },
      // Verification and browser evidence are independent of each other - one wave.
      { agentTemplateId: 'sdlc-fix-implementer', label: 'Implement Fix', next: ['sdlc-verifier', 'sdlc-trace-capture'] },
      { agentTemplateId: 'sdlc-verifier', label: 'Verify + Regression', next: ['sdlc-evidence-and-pr'] },
      { agentTemplateId: 'sdlc-trace-capture', label: 'Browser Trace', next: ['sdlc-evidence-and-pr'] },
      { agentTemplateId: 'sdlc-evidence-and-pr', label: 'Evidence Bundle + PR', next: [] },
    ],
  },
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no new errors.

- [ ] **Step 3: Re-run the template test**

Run: `node scripts/test-workflow-templates.mjs`
Expected: PASS — still `workflowTemplates: all assertions passed` (the new entry must not break id translation).

- [ ] **Step 4: Commit**

```bash
git add app/utils/workflowTemplates.ts
git commit -m "feat: register the Runbook A workflow template"
```

---

### Task 7: End-to-end installation check

Verifies the pieces compose: installing the template creates seven agents with the right tools, and a workflow whose graph fans out and back in.

**Files:**
- No production files. Verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Run every self-check**

```bash
node scripts/test-agent-tool-policy.mjs
node scripts/test-workflow-templates.mjs
node scripts/test-workflow-graph.mjs
bun run typecheck
```
Expected: all four pass — including the pre-existing graph test, which must be unaffected.

- [ ] **Step 2: Install the template through the UI**

Run `bun run dev`, open `http://localhost:3030/workflows`, and install "Runbook A — Ticket to Evidence-Backed PR" from the template list.
Expected: it navigates to the new workflow, and the canvas shows a fan-out after "Implement Fix" into two parallel nodes that rejoin at "Evidence Bundle + PR".

- [ ] **Step 3: Confirm the generated graph and agents**

```bash
curl -s localhost:3030/api/workflows | grep -o 'runbook-a[^"]*'
curl -s localhost:3030/api/agents | grep -o 'sdlc-[a-z-]*' | sort -u
```
Expected: the workflow exists, and all seven `sdlc-*` agents were created.

Then confirm the fan-out survived materialization — the fix step must list two successors, and both must be real step ids present in the workflow:

```bash
curl -s "localhost:3030/api/workflows/$(curl -s localhost:3030/api/workflows | python3 -c 'import json,sys; print([w["slug"] for w in json.load(sys.stdin) if w["slug"].startswith("runbook-a")][0])')" \
  | python3 -c '
import json,sys
w = json.load(sys.stdin)
ids = {s["id"] for s in w["steps"]}
by_label = {s["label"]: s for s in w["steps"]}
fix = by_label["Implement Fix"]
assert len(fix["next"]) == 2, fix
assert all(t in ids for t in fix["next"]), fix
joins = [s for s in w["steps"] if s["label"] == "Evidence Bundle + PR"]
assert len(joins) == 1
print("graph OK: fix fans out to 2, both resolve, join present")
'
```
Expected: `graph OK: fix fans out to 2, both resolve, join present`

- [ ] **Step 4: Confirm an agent's tools reached the file**

```bash
grep -A2 "tools:" ~/.claude/agents/sdlc-stack-provisioner.md
```
Expected: shows `Bash` among the tools, and `maxTurns: 40` present in the file.

- [ ] **Step 5: Confirm the run modal offers unattended mode**

In the workflow you just installed, click Run.
Expected: the modal shows the "Run to completion without pausing" checkbox from Task 2.

- [ ] **Step 6: Commit nothing, report instead**

This task produces no files. Report the results of steps 1-5.

**Not part of this plan:** the first real run against an actual portal-class ticket, with a stack, a live `gh` and a real PR. That is the spec's own first experiment and it needs a chosen ticket and an authenticated host — run it as usage, not as implementation verification.
