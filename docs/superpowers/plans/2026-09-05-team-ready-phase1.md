# Team-Ready Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sub-second first paint on every route, one cached read layer behind the tree-walking endpoints, the dead terminal stack removed, unfinished pages behind a labs flag, and a server that many users can hit without repointing each other's config or overwriting each other's files.

**Architecture:** The app shell renders after config load and lets pages own their loading states. Heavy list endpoints share a small memoised scan with TTL and write-invalidation, and the skills list stops carrying bodies. Runtime mutation of the config directory is removed and host-only endpoints are gated by `LOCAL_DESKTOP`. Every editor sends the file's `lastModified` and every put route answers 409 on drift, extending the pattern agents already use.

**Tech Stack:** Nuxt 3 / Nitro, Vue 3, Nuxt UI 3, plain-node test scripts.

**Spec:** `docs/superpowers/specs/2026-09-05-team-ready-agent-manager-design.md`, Phase 1.

## Global Constraints

- Server utils import siblings with `.ts` extensions; node strip-only TypeScript.
- Conventional Commits, no attribution trailers.
- Each task ends with its test script green and `bun run typecheck` showing only the known `test-workflow-graph.mjs` error.
- Rebuild the container (`docker compose up -d --build`) once at the end, then verify live with agent-browser.

---

### Task 1: Shell renders before the lists

**Files:** `app/app.vue:105-109`, `app/app.vue:462-472`.

- [ ] Replace the `onMounted` body with: `await loadConfig(); initialized.value = true; void Promise.all([...six fetches])`. Keep the fetches so sidebar counts and shared lists still fill.
- [ ] Verify each list page renders its own skeleton or empty state while `loading` is true (agents, commands, skills, workflows, plugins, mcp already use `loading` from `useCrud`).
- [ ] Live check: `/agents` shows content within one second even while skills load.
- [ ] Commit: `perf(shell): render pages before the shared lists arrive`.

### Task 2: Skills list without bodies, MCP servers read once

**Files:** `server/utils/skillRelationships.ts`, `server/api/skills/index.get.ts`, `app/types/index.ts` (`Skill.body` optional), `scripts/test-skills-list.mjs` (new).

- [ ] Test: build a temp CLAUDE_DIR with three skills and a `~/.claude.json` with one MCP server; call the handler's core function; assert no `body` in list items, `mcpServer` still resolved, and that the config file was read once (stub `readFile` count via a seam).
- [ ] Split `getMcpServerForSkill` into `loadMcpServers(workingDir)` and `matchMcpServer(servers, slug, frontmatter, body)`; keep the old signature as a wrapper.
- [ ] In the list handler, load servers once, match per skill, and delete `body` from each item before returning.
- [ ] Make `Skill.body` optional in the type; fix any consumer the typecheck flags.
- [ ] Commit: `perf(skills): list without bodies, MCP servers read once per request`.

### Task 3: One memoised scan behind the tree-walking endpoints

**Files:** new `server/utils/memo.ts`, `server/api/agents/index.get.ts`, `server/api/agents/skill-counts.get.ts`, `server/api/skills/index.get.ts`, `server/api/relationships.get.ts`, write routes under `server/api/{agents,commands,skills}/`.

- [ ] `memo(key, ttlMs, fn)` returning cached promise results; `invalidate(prefix)`.
- [ ] Wrap the four handlers' scan results with a 30 s TTL keyed by `claudeDir` and `workingDir`.
- [ ] Call `invalidate('agents')`, `invalidate('skills')` from the corresponding create, update, delete and import routes.
- [ ] Test in `scripts/test-memo.mjs`: hit twice within TTL → fn called once; invalidate → called again.
- [ ] Commit: `perf(api): memoise directory scans with write invalidation`.

### Task 4: Remove the terminal stack and gate unfinished pages

**Files:** delete `app/components/cli/{Terminal,MetricsCard,ToolTimeline,FileTree,SessionHistory,ContextPanel}.vue`, `app/composables/useTerminal.ts`, `app/composables/useCliExecution.ts`, `server/api/cli/**`, `server/utils/cliSession.ts`, `server/utils/contextMonitor.ts`, `app/components/OnboardingFlow.vue`; edit `app/pages/cli.vue`, `package.json`, `CLAUDE.md`, `app/app.vue` (nav), `app/pages/settings.vue`, `app/types/index.ts`.

- [ ] `cli.vue`: replace `useCliExecution()` with a local `executionOptions` computed from `useWorkingDir` and the agent selector the page already has.
- [ ] Remove dependencies `node-pty`, `@xterm/*`, `chokidar` after confirming no other importer; `bun install`; Dockerfile drops the node-pty build steps and the `COPY` of its build dir.
- [ ] Labs flag: `settings.json` key `agentManager.labs` (boolean). `navBottom` shows Graph and Explore, and `navTop` shows Output styles, only when it is true. Settings page gets a "Labs pages" toggle.
- [ ] CLAUDE.md: remove the CLI terminal system sections; describe `/cli` as the chat interface.
- [ ] Commit: `chore: remove the dead terminal stack, put unfinished pages behind a labs flag`.

### Task 5: Config fixed at boot, host-only endpoints gated

**Files:** delete `server/api/config.post.ts`; edit `app/composables/useClaudeDir.ts`, `app/pages/index.vue` (Advanced block), `server/api/utils/pick-folder.post.ts`, `server/api/reveal.post.ts`, `app/composables/useReveal.ts`, `app/pages/project-artifacts/index.vue`, `server/api/config.get.ts` (add `localDesktop`).

- [ ] `config.get` returns `{ claudeDir, exists, localDesktop: process.env.LOCAL_DESKTOP === '1' }`.
- [ ] `pick-folder` and `reveal` throw 404 unless `LOCAL_DESKTOP=1`; the Browse button and reveal buttons render only when `localDesktop` is true.
- [ ] Remove `set()` from `useClaudeDir`, the dashboard's Advanced folder block, and the `config.post` route.
- [ ] Commit: `fix(server): config directory fixed at boot, host-only actions gated`.

### Task 6: Optimistic concurrency on commands, skills and workflows; settings validation

**Files:** `server/api/commands/[slug].{get,put}.ts`, `server/api/skills/[slug].{get,put}.ts`, `server/api/workflows/[slug].{get,put}.ts`, `app/pages/commands/[slug].vue`, `app/pages/skills/[slug].vue`, `app/pages/workflows/[slug].vue`, `server/api/settings.put.ts`, `scripts/test-concurrency.mjs` (new).

- [ ] Each get route returns `lastModified: stat.mtimeMs`; each put route accepts `lastModified` and answers 409 `{ message, lastModified }` when the file's mtime differs by more than 1 s, as `agents/[slug].put.ts:21` does.
- [ ] Each editor keeps `lastModified` from load, sends it on save, and on 409 shows "changed by someone else; reload to see it" with a Reload button.
- [ ] `settings.put`: reject when the body is not an object, or when `hooks`, `permissions`, `env` are present and not objects; answer 400 with the reason.
- [ ] Test: write a file, save with a stale `lastModified` through the handler's core → 409; fresh → 200. Settings: array body → 400.
- [ ] Commit: `fix(api): stale-write protection on team files, validated settings`.

### Task 7: Rebuild and verify live

- [ ] `docker compose up -d --build`; health 200.
- [ ] agent-browser sweep of all routes: first paint under one second, no shell spinner, `/skills` shows 495 cards, console clean.
- [ ] Two sessions edit the same command: second save gets the 409 message.
- [ ] Labs pages hidden by default; toggle shows them.
