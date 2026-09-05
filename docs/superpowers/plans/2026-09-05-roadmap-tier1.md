# Roadmap Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five blockers that stop Runbook A being used every day: routing knowledge trapped in prompts, runaway or invisible cost, a Stop that does not stop, unwatched steps, and restarts that cannot be steered.

**Architecture:** The registry becomes runtime data: a loader reads `products.yaml` from the installed alepo-engineering plugin, resolves a product from the ticket key or labels at run start, stores it on the run, and the step header prints it, with per-product recipes as files the provisioner reads. The runner gains a budget check and a cost summary, an AbortController per step so Stop cancels the SDK call, and a note channel that reuses the existing retry-feedback path. Two template changes finish it: monitors on every step and stable step ids across syncs.

**Tech Stack:** Nuxt 3 server utils in TypeScript run by plain node for tests (`.ts` imports with extensions), `yaml` 2.x already a dependency, Claude Agent SDK `query()` with `abortController`, Vue 3 and Nuxt UI 3 for the two UI touches.

**Spec:** `docs/roadmap/2026-09-05-agentic-sdlc-capability-roadmap.html`, Tier 1. Item 2 (skills) is verified wired and reduced to a guard test in Task 3.

## Global Constraints

- Server utils import siblings with `.ts` extensions; no constructor parameter properties (node strip-only TypeScript rejects them).
- No raw model string literals outside `server/utils/models.ts`; use `getModelPricing(model)`.
- Conventional Commits under 72 chars, no attribution trailers.
- Every task ends with `node scripts/test-workflow-runner.mjs` and any task-specific test green, then `bun run typecheck` showing only the pre-existing `scripts/test-workflow-graph.mjs` error.
- Prompt changes live in `app/utils/templates.ts` and are deployed with `node scripts/sync-agents.mjs`; server changes need `docker compose up -d --build`.
- Never write secrets or a developer's `.env` contents into recipes, headers or artifacts.

---

### Task 1: Registry loader and product resolution at run start

**Files:**
- Create: `server/utils/registry.ts`
- Modify: `shared/types/run.ts` (add `ProductMatch`, `WorkflowRun.product`, `NewRunInput.product`)
- Modify: `server/utils/workflowRunStore.ts` (`createRun` copies `product`)
- Modify: `server/utils/workflowRunner.ts` (`startRun` resolves and stores; `executeNode` passes product to the header)
- Modify: `server/utils/runArtifacts.ts` (`artifactHeader(dir, product?)`)
- Modify: `engineering/registry/products.yaml` (add `selfcarenow`)
- Test: `scripts/test-registry.mjs` (new), `scripts/test-run-artifacts.mjs` (header block)

**Interfaces:**
- Produces: `export interface ProductMatch { name: string; repos: string[]; branches: Record<string, string>; stack: { compose: string; topology_default: string; liquibase?: boolean }; tests: Record<string, string>; recipe?: string }`
- Produces: `export async function loadRegistry(): Promise<Record<string, any> | null>` and `export async function resolveProduct(text: string): Promise<ProductMatch | undefined>`
- Produces: `artifactHeader(dir: string, product?: ProductMatch): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-registry.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'registry-'))
// The loader reads the registry from the installed plugin. Fake an install.
const cache = join(process.env.CLAUDE_DIR, 'plugins', 'cache', 'alepo-engineering', 'alepo-engineering', '9.9.9')
mkdirSync(join(cache, 'registry'), { recursive: true })
mkdirSync(join(cache, 'recipes'), { recursive: true })
mkdirSync(join(process.env.CLAUDE_DIR, 'plugins'), { recursive: true })
writeFileSync(join(process.env.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'alepo-engineering@alepo-engineering': [{ installPath: cache, version: '9.9.9' }] },
}))
writeFileSync(join(cache, 'registry', 'products.yaml'), `
products:
  selfcarenow:
    match:
      projects: [SCN]
      labels: [NEW_WEB_SELFCARE]
    repos: [alepolab/selfcarenow]
    branches: { bug: main, feature: main }
    stack: { compose: selfcarenow/docker-compose.yml, topology_default: 1node }
    tests: { unit: 'pnpm test' }
    owners: { protocol: selfcare-leads }
  pcrf:
    match:
      components: [PCRF]
      projects: [PCRFV]
    repos: [alepolab/pcrf_cpp14]
    branches: { bug: development, feature: development }
    stack: { compose: alepo-dev-team-infra/pcrf, topology_default: 2node }
    tests: { unit: make test }
    owners: { protocol: pcrf-leads }
`)
writeFileSync(join(cache, 'recipes', 'selfcarenow.md'), '# selfcarenow recipe\n')

const R = await import('../server/utils/registry.ts')
const A = await import('../server/utils/runArtifacts.ts')

const byKey = await R.resolveProduct('SCN-402')
assert.equal(byKey?.name, 'selfcarenow', 'a ticket key resolves by project prefix')
assert.equal(byKey?.recipe, join(cache, 'recipes', 'selfcarenow.md'), 'a recipe file next to the registry is found')
const byLabel = await R.resolveProduct('Some pasted ticket text with label NEW_WEB_SELFCARE in it')
assert.equal(byLabel?.name, 'selfcarenow', 'a label in pasted text resolves')
const byComponent = await R.resolveProduct('PCRF session drops after rekey')
assert.equal(byComponent?.name, 'pcrf', 'a component word resolves')
assert.equal(await R.resolveProduct('nothing here'), undefined, 'no match is undefined, never a guess')

const header = A.artifactHeader('/tmp/x', byKey)
assert.match(header, /## Product \(from the registry\)/, 'header carries a product block')
assert.match(header, /alepolab\/selfcarenow/, 'header names the repo')
assert.match(header, /bug: main/, 'header names the branch policy')
assert.match(header, /Recipe: .*selfcarenow\.md/, 'header points at the recipe')
assert.doesNotMatch(A.artifactHeader('/tmp/x'), /## Product/, 'no product, no block')

rmSync(process.env.CLAUDE_DIR, { recursive: true, force: true })
console.log('registry: all assertions passed')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/test-registry.mjs`
Expected: FAIL, cannot find module `../server/utils/registry.ts`.

- [ ] **Step 3: Implement the loader**

Create `server/utils/registry.ts`:

```ts
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveClaudePath } from './claudeDir.ts'
import type { ProductMatch } from '~~/shared/types/run'

/**
 * The registry travels with the alepo-engineering plugin, so a machine that
 * has the plugin has the registry. AGENT_REGISTRY_PATH overrides for tests
 * and for a checkout that is ahead of the installed plugin.
 */
async function registryPath(): Promise<string | null> {
  if (process.env.AGENT_REGISTRY_PATH) return process.env.AGENT_REGISTRY_PATH
  const installed = resolveClaudePath('plugins', 'installed_plugins.json')
  if (!existsSync(installed)) return null
  try {
    const data = JSON.parse(await readFile(installed, 'utf-8'))
    const entry = data?.plugins?.['alepo-engineering@alepo-engineering']?.[0]
    if (!entry?.installPath) return null
    const path = join(entry.installPath, 'registry', 'products.yaml')
    return existsSync(path) ? path : null
  } catch {
    return null
  }
}

export async function loadRegistry(): Promise<{ path: string, products: Record<string, any> } | null> {
  const path = await registryPath()
  if (!path) return null
  try {
    const doc = parse(await readFile(path, 'utf-8'))
    if (!doc?.products || typeof doc.products !== 'object') return null
    return { path, products: doc.products }
  } catch {
    // A registry that does not parse is a registry that does not exist; the
    // validator is the place that reports why.
    return null
  }
}

const word = (s: string) => new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i')

/**
 * Resolves the product a ticket belongs to. A Jira key's project prefix is the
 * strongest signal, then labels, then component words. The first product in
 * registry order wins a tie, and no match returns undefined: guessing a product
 * is how a run stands up the wrong stack.
 */
export async function resolveProduct(text: string): Promise<ProductMatch | undefined> {
  const reg = await loadRegistry()
  if (!reg) return undefined
  const key = text.match(/\b([A-Z][A-Z0-9]+)-\d+\b/)?.[1]
  const entries = Object.entries(reg.products)
  const pick = (pred: (m: any) => boolean) => entries.find(([, p]) => pred(p?.match ?? {}))
  const hit = (key && pick(m => (m.projects ?? []).includes(key)))
    || pick(m => (m.labels ?? []).some((l: string) => word(l).test(text)))
    || pick(m => (m.components ?? []).some((c: string) => word(c).test(text)))
  if (!hit) return undefined
  const [name, p] = hit
  const recipe = join(reg.path, '..', '..', 'recipes', `${name}.md`)
  return {
    name,
    repos: p.repos ?? [],
    branches: p.branches ?? {},
    stack: p.stack,
    tests: p.tests ?? {},
    ...(existsSync(recipe) ? { recipe } : {}),
  }
}
```

Add to `shared/types/run.ts`:

```ts
/** The registry entry a run resolved to at start, or absent when nothing matched. */
export interface ProductMatch {
  name: string
  repos: string[]
  branches: Record<string, string>
  stack: { compose: string, topology_default: string, liquibase?: boolean }
  tests: Record<string, string>
  recipe?: string
}
```

and `product?: ProductMatch` on both `WorkflowRun` and `NewRunInput`. In `createRun`, add `product: input.product,`.

- [ ] **Step 4: Header block and run start**

In `server/utils/runArtifacts.ts`:

```ts
import type { WorkflowRun, RunStep, ProductMatch } from '~~/shared/types/run'

export function artifactHeader(dir: string, product?: ProductMatch): string {
  const lines = [
    '## Run artifacts directory',
    '',
    `Write every artifact you produce into: ${dir}`,
    '',
    `Claude config directory: ${getClaudeDir()}`,
    '',
    'This directory is the run\'s evidence. A file you do not write is evidence',
    'that does not exist — do not describe an artifact in prose instead of',
    'writing it, and never write a placeholder in place of a real result.',
    'End your output with the verbatim `ls -la` of this directory: the step monitor',
    'sees only your output, and a file it cannot see in it is a file that does not exist.',
  ]
  if (product) {
    lines.push(
      '',
      '## Product (from the registry)',
      '',
      `Product: ${product.name}`,
      `Repos: ${product.repos.join(', ')}`,
      `Branch policy: ${Object.entries(product.branches).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
      `Stack: ${product.stack?.compose ?? 'not registered'} (${product.stack?.topology_default ?? '-'})`,
      `Tests: ${Object.entries(product.tests).map(([k, v]) => `${k}: ${v}`).join('; ') || 'not registered'}`,
      ...(product.recipe ? [`Recipe: ${product.recipe}`] : []),
      'These are registry facts, resolved before any agent ran. Use them instead of guessing.',
    )
  }
  lines.push('', '---', '')
  return lines.join('\n')
}
```

In `workflowRunner.ts`, import `resolveProduct` from `./registry.ts`; in `startRun` before `createRun`:

```ts
  const product = await resolveProduct(opts.initialPrompt).catch(() => undefined)
```

pass `product` into `createRun`, and in `executeNode` change the header call to `artifactHeader(runArtifactsDir(run.id), run.product)`. In `rehydrate`, nothing changes: `run.product` is persisted.

- [ ] **Step 5: Registry entry and recipe file**

Append to `engineering/registry/products.yaml` under `products:`:

```yaml
  selfcarenow:
    match:
      projects: [SCN]
      labels: [NEW_WEB_SELFCARE]
      components: [Selfcare, SelfcareNow]
    repos: [alepolab/selfcarenow]
    branches:
      bug: main                               # CONFIRM: origin HEAD is main; team works on integrate/primary-develop
      feature: main
    stack:
      # Product-owned compose in its checkout; not yet in alepo-dev-team-infra.
      compose: selfcarenow/docker-compose.yml
      topology_default: 1node
    tests:
      unit: 'pnpm --filter @selfcare/web test'   # CONFIRM
      ui_trace: playwright
    owners:
      protocol: selfcare-leads                   # CONFIRM
      ui_parsing: selfcare-leads
```

Create `engineering/recipes/selfcarenow.md` containing the recipe paragraph currently in the provisioner prompt (image tag policy, port 3100 override with `!override`, `CI=true`, CRM variables passed through by `${VAR}` interpolation, healthcheck on `/login`, `--project-directory`, verify from inside the container network). Then in `app/utils/templates.ts` replace that paragraph in `sdlc-stack-provisioner` with:

```
Known recipes live as files: when your input's product block names a `Recipe:` path, read it first and follow it. It carries the product-specific quirks (image tag policy, port overrides, healthcheck, which variables to pass through). If there is no recipe and no compose in the deployment repo, fall back to the product checkout's own compose as described above, and write what you learned into your stack report so a recipe can be made from it.
```

In `sdlc-evidence-and-pr`, replace "against the repository's normal target branch" with "against the branch the product block's branch policy names for this run's `work_type` from `meta.json`; if there is no product block, the repository's default branch".

Run `node engineering/scripts/validate-registry.mjs` (without `--repos`) and fix any schema complaint. Run `node scripts/sync-agents.mjs`.

- [ ] **Step 6: Tests pass**

Run: `node scripts/test-registry.mjs && node scripts/test-run-artifacts.mjs && node scripts/test-workflow-runner.mjs`
Expected: all three print their "passed" line.

- [ ] **Step 7: Commit**

```bash
git add server/utils/registry.ts shared/types/run.ts server/utils/workflowRunStore.ts server/utils/workflowRunner.ts server/utils/runArtifacts.ts engineering/registry/products.yaml engineering/recipes/selfcarenow.md app/utils/templates.ts scripts/test-registry.mjs
git commit -m "feat(registry): resolve the product at run start and hand agents its facts"
```

---

### Task 2: Budget cap and cost summary

**Files:**
- Modify: `shared/types/run.ts` (`WorkflowRun.usage`, `WorkflowRun.budget`)
- Modify: `server/utils/workflowRunner.ts` (`publish` computes usage; `runWave` checks budget)
- Modify: `app/components/WorkflowRunBar.vue`, `app/pages/runs.vue` (show cost)
- Test: `scripts/test-workflow-runner.mjs` (cases 11 and 12)

**Interfaces:**
- Produces: `WorkflowRun.usage?: { input_tokens: number, output_tokens: number, usd: number }`, `WorkflowRun.budget: { maxMinutes: number, maxTokens: number }`
- Env: `AGENT_RUN_MAX_MINUTES` (default 180), `AGENT_RUN_MAX_TOKENS` (default 8000000)

- [ ] **Step 1: Write the failing tests**

Append before the final `rmSync` lines of `scripts/test-workflow-runner.mjs`:

```js
// ── 11. usage totals and cost are runner-owned facts on the run ───────────
runner.setAgentCaller(async (agentSlug) => ({ output: `out ${agentSlug}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100 } }))
let costed = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
costed = await runner.waitForSettled(costed.id, TIMEOUT)
assert.equal(costed.usage.input_tokens, 4000, 'input tokens summed over four steps')
assert.equal(costed.usage.output_tokens, 400)
assert.ok(costed.usage.usd > 0, 'a dollar estimate is computed from the model that ran')

// ── 12. a token budget stops a run before the next wave ───────────────────
process.env.AGENT_RUN_MAX_TOKENS = '1500'
let capped = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
capped = await runner.waitForSettled(capped.id, TIMEOUT)
delete process.env.AGENT_RUN_MAX_TOKENS
assert.equal(capped.status, 'failed', 'exceeding the budget fails the run')
assert.match(capped.error, /budget/i, 'the run says why')
assert.ok(capped.steps.some(s => s.status === 'skipped'), 'later steps are skipped, not run')
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL at case 11, `costed.usage` is undefined.

- [ ] **Step 3: Implement**

Types:

```ts
export interface RunUsage { input_tokens: number, output_tokens: number, usd: number }
export interface RunBudget { maxMinutes: number, maxTokens: number }
// on WorkflowRun:
usage?: RunUsage
budget: RunBudget
```

In `workflowRunStore.createRun`, set `budget: { maxMinutes: Number(process.env.AGENT_RUN_MAX_MINUTES) || 180, maxTokens: Number(process.env.AGENT_RUN_MAX_TOKENS) || 8_000_000 }`. Runs persisted before this field exists get a default in `getRun`: `budget: run.budget ?? { maxMinutes: 180, maxTokens: 8_000_000 }`.

In `workflowRunner.ts`, import `getModelPricing` from `./models.ts` (check the export name of the pricing shape: `ModelPricing` has per-million input and output rates; read `server/utils/models.ts` lines 1-60 and use its field names). Add:

```ts
function computeUsage(run: WorkflowRun): RunUsage {
  let input = 0, output = 0, usd = 0
  for (const s of run.steps) {
    const u = (s as any).usage as AgentUsage | null | undefined
    if (!u) continue
    input += u.input_tokens; output += u.output_tokens
    const p = getModelPricing(s.model ?? undefined)
    usd += (u.input_tokens / 1_000_000) * p.input + (u.output_tokens / 1_000_000) * p.output
  }
  return { input_tokens: input, output_tokens: output, usd: Math.round(usd * 10000) / 10000 }
}
```

(`usage` is recorded on `rec` by `executeNode` via `Object.assign(rec, { usage })`; confirm the field name in that function and add it to `RunStep` as `usage?: AgentUsage | null` if the type lacks it.) In `publish`, before `saveRun`: `run.usage = computeUsage(run)`.

In `runWave`, after the `l.stopped` check and before computing the wave:

```ts
  const over = budgetExceeded(run)
  if (over) {
    skipPending(l.state)
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped'
    run.status = 'failed'
    run.error = over
    run.endedAt = Date.now()
    run.currentStepIds = []
    run.nextStepIds = []
    l.running = false
    await publish(run)
    return run
  }
```

with

```ts
function budgetExceeded(run: WorkflowRun): string | null {
  const b = run.budget
  const minutes = (Date.now() - run.startedAt) / 60000
  if (minutes > b.maxMinutes) return `Budget exceeded: ${Math.round(minutes)} min over the ${b.maxMinutes} min cap`
  const tokens = (run.usage?.input_tokens ?? 0) + (run.usage?.output_tokens ?? 0)
  if (tokens > b.maxTokens) return `Budget exceeded: ${tokens} tokens over the ${b.maxTokens} token cap`
  return null
}
```

The check runs between waves, so a single long step is bounded by its own `maxTurns`; the cap stops the next wave from starting.

UI: in `WorkflowRunBar.vue` after the elapsed span: `<span v-if="run.usage" class="text-[11px] text-label font-mono tabular-nums" :title="`${run.usage.input_tokens} in / ${run.usage.output_tokens} out`">${{ run.usage.usd.toFixed(2) }}</span>`. In `runs.vue` add a Cost column after Duration rendering the same.

- [ ] **Step 4: Tests pass, typecheck**

Run: `node scripts/test-workflow-runner.mjs` → passed. `bun run typecheck 2>&1 | grep "error TS" | grep -v test-workflow-graph` → nothing.

- [ ] **Step 5: Commit**

```bash
git add shared/types/run.ts server/utils/workflowRunStore.ts server/utils/workflowRunner.ts app/components/WorkflowRunBar.vue app/pages/runs.vue scripts/test-workflow-runner.mjs
git commit -m "feat(runner): token and time budget per run, cost shown on runs"
```

---

### Task 3: Stop aborts the agent; a guard test that skills reach the model

**Files:**
- Modify: `server/utils/agentCaller.ts` (`callAgent(agentSlug, input, projectDir?, signal?)`)
- Modify: `server/utils/workflowRunner.ts` (`Live.aborts`, `executeNode`, `stopRun`, `AgentCaller` type)
- Test: `scripts/test-workflow-runner.mjs` (case 13), `scripts/test-agent-system-prompt.mjs` (skill body assertion)

**Interfaces:**
- Changes: `export type AgentCaller = (agentSlug: string, input: string, projectDir?: string, signal?: AbortSignal) => Promise<AgentCallOutput>`

- [ ] **Step 1: Write the failing test**

```js
// ── 13. stopRun aborts the agent call in flight ───────────────────────────
runner.setAgentCaller((agentSlug, input, projectDir, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(`late ${agentSlug}`), 4000)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
}))
let inflight = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
await new Promise(r => setTimeout(r, 200))
const t0 = Date.now()
await runner.stopRun(inflight.id)
inflight = await runner.waitForSettled(inflight.id, TIMEOUT)
assert.ok(Date.now() - t0 < 2000, 'stop returns without waiting for the agent to finish on its own')
assert.equal(inflight.status, 'stopped')
assert.equal(inflight.steps.find(s => s.stepId === 'a').status, 'failed', 'the aborted step records a failure, not a completion')
assert.match(inflight.steps.find(s => s.stepId === 'a').error, /stopped|abort/i)
```

For the skills guard, in `scripts/test-agent-system-prompt.mjs` add (adapting to how that script already builds prompts): write a skill `CLAUDE_DIR/skills/demo-skill/SKILL.md` with body `DEMO SKILL BODY MARKER`, build the prompt for an agent declaring `skills: [demo-skill]`, and `assert.match(prompt, /DEMO SKILL BODY MARKER/)`.

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL at "stop returns without waiting" (the stub resolves after 4s).

- [ ] **Step 3: Implement**

`agentCaller.ts`: add the `signal?: AbortSignal` parameter; create `const abortController = new AbortController()`; if `signal` is given, `signal.addEventListener('abort', () => abortController.abort())`; pass `abortController` in `query`'s options. On abort the SDK rejects; let that propagate.

`workflowRunner.ts`: `Live` gains `aborts: Map<string, AbortController>`; initialise `aborts: new Map()` in `startRun` and `rehydrate`. In `executeNode` around the agent call:

```ts
  const ac = new AbortController()
  l.aborts.set(id, ac)
  try {
    const raw = await agentCaller(step.agentSlug, input, run.projectDir, ac.signal)
    ...
  } finally {
    l.aborts.delete(id)
  }
```

In the existing `catch (err)` branch that marks the step failed, when `l.stopped` is true set the error text to `'Stopped by operator'`. In `stopRun`, after `l.stopped = true`: `for (const ac of l.aborts.values()) ac.abort()`. Update the `AgentCaller` type and `setAgentCaller` signature to carry the fourth parameter; `callAgent` already matches.

- [ ] **Step 4: Tests pass, typecheck, commit**

Run both test scripts and typecheck as in the constraints.

```bash
git add server/utils/agentCaller.ts server/utils/workflowRunner.ts scripts/test-workflow-runner.mjs scripts/test-agent-system-prompt.mjs
git commit -m "fix(runner): stop aborts the in-flight agent call"
```

---

### Task 4: Monitors on every step and stable step ids across syncs

**Files:**
- Modify: `app/utils/workflowTemplates.ts` (`monitorSlug` on all seven; `materializeTemplateSteps(template, slugs, existingIds?)`)
- Modify: `scripts/sync-agents.mjs` (pass existing ids)
- Test: `scripts/test-workflow-templates.mjs`

- [ ] **Step 1: Write the failing tests**

In `scripts/test-workflow-templates.mjs` (follow its existing import and assert style):

```js
const runbook = workflowTemplates.find(t => t.id === 'runbook-a-jira-to-diff')
assert.ok(runbook.steps.every(s => s.monitorSlug === 'sdlc-step-monitor'), 'every Runbook A step is monitored')

const slugs = Object.fromEntries(runbook.steps.flatMap(s => [[s.agentTemplateId, s.agentTemplateId], ...(s.monitorSlug ? [[s.monitorSlug, s.monitorSlug]] : [])]))
const first = materializeTemplateSteps(runbook, slugs)
const again = materializeTemplateSteps(runbook, slugs, first.map(s => s.id))
assert.deepEqual(again.map(s => s.id), first.map(s => s.id), 'existing ids are kept by position')
assert.deepEqual(again.map(s => s.next), first.map(s => s.next), 'edges follow the kept ids')
const fresh = materializeTemplateSteps(runbook, slugs, first.slice(0, 3).map(s => s.id))
assert.notDeepEqual(fresh.map(s => s.id), first.map(s => s.id), 'a length mismatch regenerates rather than half-reusing')
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-workflow-templates.mjs`
Expected: FAIL at "every Runbook A step is monitored".

- [ ] **Step 3: Implement**

In the Runbook A template add `monitorSlug: 'sdlc-step-monitor'` to steps 1, 3, 4, 6, 7. In `materializeTemplateSteps` add the third parameter:

```ts
export function materializeTemplateSteps(template: WorkflowTemplate, agentSlugByTemplateId: Record<string, string>, existingIds?: string[]): WorkflowStep[] {
  const reuse = existingIds && existingIds.length === template.steps.length
  const stepIds = template.steps.map((_, i) => (reuse ? existingIds![i] : crypto.randomUUID()))
```

In `scripts/sync-agents.mjs`, before materializing, read the existing workflow file if present and pass `existing.steps.map(s => s.id)`; keep `createdAt` from the existing file instead of `new Date()` when reusing.

Cost note for the commit message: five more monitor calls per run, each a short Sonnet review; acceptable against a 30-minute run, and the budget from Task 2 bounds it.

- [ ] **Step 4: Tests pass, sync, commit**

Run: `node scripts/test-workflow-templates.mjs && node scripts/sync-agents.mjs --dry-run` then `node scripts/sync-agents.mjs`. Confirm the workflow file's step ids did not change: compare `python3 -c "import json;print([s['id'][:8] for s in json.load(open('$HOME/.claude/workflows/runbook-a-ticket-to-evidence-backed-pr.json'))['steps']])"` before and after.

```bash
git add app/utils/workflowTemplates.ts scripts/sync-agents.mjs scripts/test-workflow-templates.mjs
git commit -m "feat(templates): monitor every Runbook A step and keep step ids across syncs"
```

---

### Task 5: Restart with a note

**Files:**
- Modify: `server/utils/workflowRunner.ts` (`restartRun(runId, stepId, note?)`)
- Modify: `server/api/runs/[id]/restart.post.ts` (accept `note`)
- Modify: `app/composables/useWorkflowRun.ts` (`restart(stepId, note?)`)
- Modify: `app/components/WorkflowRunPanel.vue` (note field above the step rows when the run is settled)
- Modify: `app/pages/workflows/[slug].vue` (pass the note through)
- Test: `scripts/test-workflow-runner.mjs` (case 14)

- [ ] **Step 1: Write the failing test**

```js
// ── 14. a restart note reaches the restarted step's input ─────────────────
const seen = {}
runner.setAgentCaller(async (agentSlug, input) => { seen[agentSlug] = input; if (agentSlug === 'agent-c' && !seen.cAgain) { seen.cAgain = true; throw new Error('c failed once') } return `out ${agentSlug}` })
let noted = await runner.startRun({ workflow, initialPrompt: 'go', watch: 'direct-invocation', autoRun: true })
noted = await runner.waitForSettled(noted.id, TIMEOUT)
assert.equal(noted.status, 'failed')
noted = await runner.restartRun(noted.id, 'c', 'Use the staging CRM, not production')
noted = await runner.waitForSettled(noted.id, TIMEOUT)
assert.equal(noted.status, 'completed')
assert.match(seen['agent-c'], /Operator note:\s*Use the staging CRM/, 'the note is in the restarted step input')
assert.match(seen['agent-c'], /Your previous attempt/, 'the previous attempt travels with it, as a monitor retry would')
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-workflow-runner.mjs`
Expected: FAIL at "the note is in the restarted step input".

- [ ] **Step 3: Implement**

`restartRun(runId, stepId, note?: string)`: after the reset loop, if `note?.trim()`, set `l.outputs[stepId] = rec-before-reset.output` (capture `prev = rec.output` before the reset) and `l.retryFeedback[stepId] = `Operator note: ${note.trim()}``. `computeInput`'s feedback branch then builds "Your previous attempt / Reviewer feedback" from those. The endpoint reads `body.note` and passes it. The composable's `restart(stepId, note?)` posts `{ stepId, note }`. In the panel, when `settledRun`, render a `<textarea v-model="note" placeholder="Optional note for the restarted step" rows="2" class="field-input w-full">` above the rows and emit `restart` with `[step.stepId, note]`; the emit type becomes `restart: [stepId: string, note?: string]`. The run bar's one-click Restart passes no note.

- [ ] **Step 4: Tests pass, typecheck, commit**

```bash
git add server/utils/workflowRunner.ts "server/api/runs/[id]/restart.post.ts" app/composables/useWorkflowRun.ts app/components/WorkflowRunPanel.vue "app/pages/workflows/[slug].vue" scripts/test-workflow-runner.mjs
git commit -m "feat(runs): restart a step with an operator note"
```

---

### Task 6: Rebuild, reinstall the plugin, verify live

- [ ] **Step 1: Reinstall the plugin so the registry and recipe travel with it**

The registry loader reads from the installed plugin. After Task 1 the checkout's `engineering/` is ahead of the installed copy:

```bash
claude plugin uninstall alepo-engineering@alepo-engineering && claude plugin install alepo-engineering@alepo-engineering --scope user
ls ~/.claude/plugins/cache/alepo-engineering/alepo-engineering/*/recipes/
```

Expected: `selfcarenow.md` listed.

- [ ] **Step 2: Rebuild and smoke**

```bash
docker compose up -d --build && sleep 8 && curl -sf http://localhost:3030/api/health
```

- [ ] **Step 3: Live checks with agent-browser**

1. Start a run with `SCN-402` from the Runbook A card. Read `~/.agent-manager/workflow-runs/<id>/artifacts/steps/step-01-ticket-intake.json` and confirm the `input` contains `## Product (from the registry)` with `Product: selfcarenow` and a `Recipe:` line. Screenshot the run bar showing the cost figure once step 1 completes.
2. While step 2 runs, press Stop, confirm, and check the record within a few seconds: status `stopped`, the step `failed` with "Stopped by operator", and no `claude` process left in `docker top agents-ui`.
3. Restart step 2 from the slide-over with the note "verify from inside the container only". Confirm `step-02-…-restart-1.json` exists and the new step input contains the note.
4. Set `AGENT_RUN_MAX_TOKENS=1000` in the compose override, recreate, start a run, and confirm it fails with a budget error after step 1. Remove the override value and recreate.
5. Open `/runs`, confirm the Cost column renders and the monitor verdicts appear on steps 1 and 3 in the slide-over.

- [ ] **Step 4: Report** what ran, with screenshots, and anything checked by reading rather than running.
