# Agent Manager

Alepo's shared control plane for agentic software delivery. It runs step-graph workflows over a team of Claude Code agents, keeps every developer's instance in step with the team's agent estate, and gives everyone a browser UI over the setup: agents, skills, commands, workflows, plugins and MCP servers.

One instance serves the team. Developers sign in with GitHub, add a Jira token once, and start runs from a ticket key or a prompt. The agents, skills and workflows come from the oh-my-agent estate under `.agents/`, which ships with the application source and is re-applied at boot and from the Team page. Team enforcement (hooks, product registry, recipes) ships in the `alepo-engineering` plugin.

## What it does

**Agents.** The instance carries the twelve oh-my-agent agents, seeded straight from `.agents/agents/`:

| Agent | Use for |
|---|---|
| `pm-planner` | Requirements analysis, task decomposition, API contract definition |
| `architecture-reviewer` | System design, module boundaries, ADRs, tradeoff analysis |
| `backend-engineer` | API, authentication and DB migration implementation |
| `frontend-engineer` | React, Next.js, Angular and TypeScript UI work |
| `mobile-engineer` | Flutter, React Native and Swift implementation |
| `db-engineer` | Schema, ERD, migrations, query tuning, vector DB work |
| `tf-infra-engineer` | Terraform provisioning, IAM/OIDC, networking, plan review |
| `debug-investigator` | Error analysis, root cause identification, regression tests |
| `refactor-engineer` | Behaviour-preserving refactors with characterisation tests |
| `qa-reviewer` | OWASP security, performance, accessibility and code quality review |
| `docs-curator` | Documentation drift detection and sync after code changes |
| `research-explorer` | Cross-source research with cited, trust-labelled findings |

Each agent declares the skills it needs; those come from `.agents/skills/` and are seeded beside the agents.

**Plan, Build, Review.** The one step-graph workflow the instance ships. Each step runs an agent; the reviewer is never the implementer and sees the whole chain, not only the step before it:

| Step | Agent | Output |
|---|---|---|
| Plan | `pm-planner` | The request decomposed into tasks and contracts |
| Implement | `backend-engineer` | The change, built against the plan |
| Review | `qa-reviewer` | Review of the plan and the change together. This is the one human gate, owned by QA, so a developer can't accept their own verification |

Runs are persisted, survive server restarts, can be paused, stopped, restarted from any step with a note, or cloned. Budgets cap minutes and tokens per run.

**The environment is the runner's job, and so is proving it.** A step that declares a stack gets one: the lifecycle is read from the infra repo's published contract (`agent/stack-contract.json`) rather than guessed, the compose stages run in the order that repo documents, and the runner then asks docker what is actually running. That answer — every service's state and healthcheck verdict, the ports it published, the entry points the registry names — is written to `stack-facts.json` in the run's artifacts and handed to the step, so a UI check has an address instead of an assumption. The same step drives `deploy/ansible/deploy.sh --step deploy --env dev` and follows it with the script's own `status` read; dev is the only environment that runs unattended, staging and prod are refused before an argument is assembled unless a person answered the gate and a secrets file is configured. Teardown happens when the run settles and never removes a volume. Every shipped workflow gets its environment this way, preflight checks the compose file and the ansible role before the first token is spent, and the stack guard hook denies an agent that tries to start, stop or deploy one itself.

**Builds run in the product's container, not on the host.** The pull-request step refuses a change whose only passing build ran on this host: a toolchain installed here is not the one the product ships with, and a run once read 6,820 errors from the wrong JDK as a repository defect. `docker compose run --rm <service> <build command>`, a compose build target or `docker build` all satisfy it, and every step is told so in its own instructions rather than finding out at the gate. `AGENT_ALLOW_HOST_BUILD=1` is the explicit, logged way out for a product with no container build.

**Visual verification is evidence, not prose.** The visual step drives `agent-browser` (shipped in the image, pointed at the image's chromium): accessibility snapshots to navigate cheaply, then a screenshot on disk that the agent opens with its own `Read` tool and describes — a modal covering a button and a spinner that never stopped are invisible to a DOM query. `meta.json` carries a `visual` block counted off the artifacts directory, and a visual step that completed without leaving an image or a trace is recorded as a gap in the evidence contract.

**Runbook A: ticket to evidence-backed PR.** A markdown workflow at `.agents/workflows/runbook-a.md`, projected into the instance as a skill (the way `oma link` projects every oh-my-agent workflow into a Claude runtime). Its deliverable is the evidence bundle, not the diff. The steps, with the gates defined in `.agents/workflows/runbook-a/resources/phase-gates.md`:

| Step | Produces |
|---|---|
| 0. Has this already been fixed? | `prior-art.md`: commits, branches and PRs searched for the ticket key |
| 1. Ticket intake and classification | `context-packet.json` and `meta.json`, including the blast radius that decides how much oversight the change gets (INTAKE_GATE) |
| 2. Stand up the stack | The affected product's profile running and healthy, or `skip.md` saying what was checked |
| 3. Write the failing oracle | A parameterised test of five or six rows, failing against the unfixed code, captured as `oracle-before.xml` (ORACLE_GATE) |
| 4. Fix the root cause | Minimal fix committed locally; tests are locked once source changes (IMPL_GATE) |
| 5. Verify | `oracle-after.xml` and `regression.xml` from the runner's own reports; adversarial search for `protocol` and `money` changes |
| 6. Capture a trace | A browser trace for UI-class changes, or "n/a" |
| 7. Assemble the bundle and open the PR | The bundle validated and posted as the PR body on `fix/<ticket-key>` (SHIP_GATE) |

Steps 5 and 6 run in parallel and are scored together at VERIFY_GATE. Facts a tool can compute (commits, files changed, oracle verdicts, tool versions) are never accepted from the agent's own report.

**Watches.** JQL queries created on the Watches page feed tickets into a workflow automatically. New watches start in shadow mode. The registry's `watches.yaml` still ships with the plugin but isn't seeded on this instance.

**Claude Code setup.** Create and edit agents, skills, commands, workflows and settings in the browser. Changes land in the instance's config directory as ordinary markdown and JSON.

**Chat.** Talk to Claude from the browser against a chosen project directory, with or without an agent.

## Quick start

### Team instance

```bash
AGENT_MANAGER_SECRET=$(openssl rand -hex 32) \
GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
AGENT_MANAGER_URL=http://<host>:3030 \
docker compose -f docker-compose.team.yml up -d --build
```

Config, runs, user profiles and product checkouts live on one volume under `/srv/agent-manager`. Nothing from a developer's home directory is mounted. At boot the instance seeds the agents, skills and workflows from `.agents/` and the commands from the plugin.

Before the first sign-in:

1. Register a GitHub OAuth app under the `alepolab` organisation with callback `<AGENT_MANAGER_URL>/api/auth/callback`.
2. Install the plugin into the instance's config directory once: `claude plugin marketplace add <path to engineering/>` then `claude plugin install alepo-engineering@alepo-engineering --scope user`, with `CLAUDE_DIR` pointing at the volume.

### Your own machine

`docker-compose.yml` bakes an allowlisted copy of `~/.claude` into the image (see `docs/baked-claude-config.md`). For a live setup, add a git-ignored `docker-compose.override.yml` that bind-mounts your home directory at the same path, runs as your uid, mounts the docker CLI and socket, and sets `AUTH_DISABLED=1`. Then:

```bash
docker compose up -d --build
```

Rebuilds take about five minutes and interrupt runs in memory. Interrupted runs show on the home page and can be resumed.

### Dev server

```bash
bun install
bun run dev        # http://localhost:3030
```

Requires Bun 1.3 and a working `claude` login on the host.

## Daily use

- **Home.** Type a ticket key such as `SCN-402` and press Start. A bare key is expanded from Jira when your profile holds a token. Below the form: runs that need you (paused, failed, interrupted, CI failing), your recent runs with cost, and team drift.
- **Runs.** Every run with status, product, cost, CI result and who started it. Open one to see step output and artifacts, restart from a step with a note, clone, or stop.
- **Profile.** Atlassian email and Jira API token, stored encrypted. Test connection checks them with the `jira` CLI.
- **Team.** Drift between this instance and the estate in `.agents/` plus the plugin's commands. Apply team standards rewrites only team-owned files and lists anything it overwrote.
- **Settings.** Labs toggle exposes the retired Graph, Explore and Output styles pages.

From a terminal:

```
am runs [--status s]
am status <runId>
am start <workflowSlug> "<ticket or prompt>" [--dir p] [--auto]
am restart <runId> [stepId|label] [--note "..."]
am clone <runId>
am stop <runId>
am open <runId>
```

`am` is `bin/am.mjs`; it reads `AGENT_MANAGER_URL`.

## Configuration

All values are environment variables. Never write them into files in this repo.

### Identity

| Variable | Effect |
|---|---|
| `AUTH_DISABLED=1` | No sign-in; every request is `DEV_USER` (default `local`). For a single developer's machine only. |
| `AGENT_MANAGER_SECRET` | 32+ characters. Seals the session cookie and encrypts stored tokens. Required when auth is on. |
| `AGENT_MANAGER_API_TOKEN`, `AGENT_MANAGER_API_LOGIN` | Optional. A 32+ character bearer token for scripts and operators, acting as the named developer: `curl -H "Authorization: Bearer $TOKEN" .../api/runs`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app. |
| `GITHUB_ORG` | Organisation whose active members may sign in (default `alepolab`). |
| `AGENT_USERS_DIR` | Where profiles live (default `~/.agent-manager/users`). Mode 600, sealed tokens only. |
| `LOCAL_DESKTOP=1` | Enables the folder picker and reveal buttons, which only make sense when browser and server share a desktop. |

### Runs

| Variable | Effect |
|---|---|
| `CLAUDE_DIR` | Config directory the app manages (default `~/.claude`). |
| `AGENT_RUNS_DIR`, `AGENT_WORKSPACE_ROOT` | Where run records live and where product repos are cloned. |
| `AGENT_RUN_MAX_MINUTES`, `AGENT_RUN_MAX_TOKENS` | Per-run caps checked between steps (defaults 180 and 8,000,000). |
| `AGENT_GH_TOKEN` | Fallback `GH_TOKEN` for agent calls when the starting user has no GitHub token. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | Handed to the agents' `claude` process untouched. Point them at a proxy such as teamclaude when the mounted claude.ai login alone hits its limit; the key then takes precedence over that login. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Instance-level Jira identity for watches. A signed-in developer's own email and token override it for runs they start. |
| `JIRA_POST_ENABLED=1` | Post the outcome comment back to the ticket when a run settles. Off by default; the comment is still written to the run's artifacts. |
| `JIRA_DEFAULT_PROJECT` | Default project for the per-user jira-cli config agents use. |
| `SLACK_WEBHOOK_URL` | One message per run transition to paused, completed, failed, stopped or interrupted. |
| `CI_POLL_SECONDS`, `CI_POLLER_DISABLED` | Polling of `gh pr checks` on completed runs (default 60s). |
| `AGENT_REGISTRY_PATH` | Override the product registry, otherwise read from the installed plugin. |
| `ALEPO_INFRA_DIR` | The `alepo-dev-team-infra` checkout a run's stack and deploy come from (default `~/alepo-workspace/alepo-dev-team-infra`). Its `agent/stack-contract.json` supplies the compose file, the profile order and the environments `deploy.sh` accepts. |
| `ALEPO_DEPLOY_SECRETS_<ENV>` | Path to the secrets file for a non-dev deploy, e.g. `ALEPO_DEPLOY_SECRETS_PROD`. Without it a staging or prod deploy is refused before ansible starts; no path is ever guessed. |
| `AGENT_BROWSER_EXECUTABLE_PATH` | The browser `agent-browser` drives (set to the image's chromium by the Dockerfile). |
| `TEAM_SEED_ON_BOOT=0` | Skip applying team standards at boot. |

## The alepo-engineering plugin

`engineering/` is a Claude Code plugin marketplace with one plugin. It carries what the pipeline enforces and what it needs to route work:

- `hooks/`: plan gate (no edits before `.agent/plan.md`), test lock (tests freeze once source changes), secrets guard (denies reading credential files and env dumps), stack guard (denies agent-issued `compose up/down` and `deploy.sh` — the runner owns both; reads and in-container builds stay open).
- `registry/products.yaml`: products grouped by suite, their repos, branches, stack profiles and test commands. Entries marked CONFIRM have unverified routing.
- `registry/environments.yaml` and `registry/watches.yaml`: environment profiles, and the Jira queues a triage loop would read.
- `recipes/*.md`: per-product stand-up and verification recipes.
- `commands/`: baseline, deploy, reproduce, tasks-picker-infra, teardown, triage.
- `schemas/evidence-bundle.v0.1.schema.json`: what every agent-authored PR carries.

To add a product: add an entry under its suite in `registry/products.yaml` (key, labels, repos, default branch, stack profile, test command), write `recipes/<key>.md` describing how to stand the stack up and prove it is healthy, run the validator, and open a PR. Intake routes a ticket to the product by key, label or component name.

After changing anything under `engineering/`, reinstall the plugin so the instance picks it up. Validate with `node engineering/scripts/validate-registry.mjs`.

## Development

```bash
bun run dev          # dev server on 3030
bun run build        # production build
bun run typecheck    # nuxt typecheck
for t in scripts/test-*.mjs engineering/scripts/test-*.mjs; do node "$t" || break; done
node scripts/sync-agents.mjs   # push the .agents/ agents and skills into a checkout's config dir
```

Tests are plain Node scripts with no framework. `node scripts/check-live-concurrency.mjs` checks the stale-save and settings guards against a running instance. `bun run test:e2e` needs a staged docker config and browser libs (`bun run e2e:libs`).

Layout:

| Path | Holds |
|---|---|
| `.agents/` | The oh-my-agent estate: agents, skills, workflows. Single source of truth; owned by oh-my-agent, never edited by hand here |
| `app/` | Nuxt pages, components, composables; `app/utils/workflowTemplates.ts` defines the shipped step-graph workflow |
| `server/api/` | REST and WebSocket routes |
| `server/utils/` | Workflow runner, registry, artifacts, notifications, CI poller, users, sessions, team sync |
| `shared/types/` | Run and watch types shared by client and server |
| `engineering/` | The plugin |
| `docs/superpowers/specs`, `docs/superpowers/plans` | Design specs and implementation plans, by date |
| `docs/roadmap/` | Capability roadmap and research notes |
| `CLAUDE.md` | Conventions for Claude Code sessions in this repo, including the model registry rules |

## Credits and license

Started from [claude-code-agents-ui](https://github.com/Ngxba/claude-code-agents-ui) by Ngxba and contributors. MIT, see `LICENSE`.
