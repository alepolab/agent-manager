# Agent Manager

Alepo's shared control plane for agentic software delivery. It runs the ticket-to-PR pipeline (Runbook A), watches Jira queues, and gives every developer a browser UI over the team's Claude Code setup: agents, skills, commands, workflows, plugins and MCP servers.

One instance serves the team. Developers sign in with GitHub, add a Jira token once, and start runs from a ticket key. Team standards ship in the `alepo-engineering` plugin and are re-applied from the Team page.

## What it does

**Runbook A: ticket to evidence-backed PR.** Eight agent steps, each reviewed by a monitor that votes continue, retry or abort:

| Step | Agent | Output |
|---|---|---|
| Ticket Intake | `sdlc-ticket-intake` | Context packet: product, repo, branch, acceptance criteria |
| Stand Up Stack | `sdlc-stack-provisioner` | The product stack running locally from the recipe |
| Failing Test | `sdlc-test-author` | A parameterised test that reproduces the bug and fails |
| Implement Fix | `sdlc-fix-implementer` | Minimal root-cause fix; tests are locked by the plugin hook |
| Verify + Regression | `sdlc-verifier` | Every new test row passes, nothing that passed before breaks |
| Browser Trace | `sdlc-trace-capture` | Screenshots and console for UI-facing changes |
| Security Review | `sdlc-security-review` | Graded findings and a verdict on the diff |
| Evidence Bundle + PR | `sdlc-evidence-and-pr` | PR carrying the evidence bundle; Jira comment with link and cost |

Verify, Browser Trace and Security Review run in parallel after the fix. Runs are persisted, survive server restarts, can be paused, stopped, restarted from any step with a note, or cloned. Budgets cap minutes and tokens per run.

**Watches.** JQL queries in `engineering/registry/watches.yaml` feed tickets into the pipeline automatically. New watches start in shadow mode.

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

Config, runs, user profiles and product checkouts live on one volume under `/srv/agent-manager`. Nothing from a developer's home directory is mounted. At boot the instance installs the team's agents, skills and workflow from the plugin and the shipped templates.

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
- **Team.** Drift between this instance and the plugin. Apply team standards rewrites only team-owned files.
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
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app. |
| `GITHUB_ORG` | Organisation whose active members may sign in (default `alepolab`). |
| `AGENT_USERS_DIR` | Where profiles live (default `~/.agent-manager/users`). Mode 600, sealed tokens only. |
| `LOCAL_DESKTOP=1` | Enables the folder picker and reveal buttons, which only make sense when browser and server share a desktop. |

### Runs

| Variable | Effect |
|---|---|
| `CLAUDE_DIR` | Config directory the app manages (default `~/.claude`). |
| `AGENT_RUNS_DIR`, `AGENT_WORKSPACE_ROOT` | Where run records live and where the provisioner clones product repos. |
| `AGENT_RUN_MAX_MINUTES`, `AGENT_RUN_MAX_TOKENS` | Per-run caps checked between steps (defaults 180 and 8,000,000). |
| `AGENT_GH_TOKEN` | Fallback `GH_TOKEN` for agent calls when the starting user has no GitHub token. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Instance-level Jira identity for watches. A signed-in developer's own email and token override it for runs they start. |
| `JIRA_POST_ENABLED=1` | Post the outcome comment back to the ticket when a run settles. Off by default; the comment is still written to the run's artifacts. |
| `JIRA_DEFAULT_PROJECT` | Default project for the per-user jira-cli config agents use. |
| `SLACK_WEBHOOK_URL` | One message per run transition to paused, completed, failed, stopped or interrupted. |
| `CI_POLL_SECONDS`, `CI_POLLER_DISABLED` | Polling of `gh pr checks` on completed runs (default 60s). |
| `AGENT_REGISTRY_PATH` | Override the product registry, otherwise read from the installed plugin. |
| `TEAM_SEED_ON_BOOT=0` | Skip applying team standards at boot. |

## The alepo-engineering plugin

`engineering/` is a Claude Code plugin marketplace with one plugin. It carries what the pipeline enforces and what it needs to route work:

- `hooks/`: plan gate (no edits before `.agent/plan.md`), test lock (tests freeze once source changes), secrets guard (denies reading credential files and env dumps).
- `registry/products.yaml`: products grouped by suite, their repos, branches, stack profiles and test commands. Entries marked CONFIRM have unverified routing.
- `registry/watches.yaml`: the Jira queues the triage loop reads.
- `recipes/*.md`: per-product stand-up and verification recipes.
- `skills/`, `commands/`: intent template, regression matrix, triage, reproduce, baseline.
- `schemas/evidence-bundle.v0.1.schema.json`: what every agent-authored PR carries.

To add a product: add an entry under its suite in `registry/products.yaml` (key, labels, repos, default branch, stack profile, test command), write `recipes/<key>.md` describing how to stand the stack up and prove it is healthy, run the validator, and open a PR. Intake routes a ticket to the product by key, label or component name.

After changing anything under `engineering/`, reinstall the plugin so the instance picks it up. Validate with `node engineering/scripts/validate-registry.mjs`.

## Development

```bash
bun run dev          # dev server on 3030
bun run build        # production build
bun run typecheck    # nuxt typecheck
for t in scripts/test-*.mjs engineering/scripts/test-*.mjs; do node "$t" || break; done
node scripts/sync-agents.mjs   # push sdlc-* templates into a checkout's config dir
```

Tests are plain Node scripts with no framework. `node scripts/check-live-concurrency.mjs` checks the stale-save and settings guards against a running instance. `bun run test:e2e` needs a staged docker config and browser libs (`bun run e2e:libs`).

Layout:

| Path | Holds |
|---|---|
| `app/` | Nuxt pages, components, composables; `app/utils/templates.ts` is the source of the sdlc-* agents |
| `server/api/` | REST and WebSocket routes |
| `server/utils/` | Workflow runner, registry, artifacts, notifications, CI poller, users, sessions, team sync |
| `shared/types/` | Run and watch types shared by client and server |
| `engineering/` | The plugin |
| `docs/superpowers/specs`, `docs/superpowers/plans` | Design specs and implementation plans, by date |
| `docs/roadmap/` | Capability roadmap and research notes |
| `CLAUDE.md` | Conventions for Claude Code sessions in this repo, including the model registry rules |

## Credits and license

Started from [claude-code-agents-ui](https://github.com/Ngxba/claude-code-agents-ui) by Ngxba and contributors. MIT, see `LICENSE`.
