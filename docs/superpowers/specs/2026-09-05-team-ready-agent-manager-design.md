# Agent Manager for a team: shared instance, per-user identity

Date: 2026-09-05
Status: awaiting review
Inputs: code audit (audit summary in the session), UX research
(`docs/roadmap/research-agent-control-plane-ux.md` once copied), dogfood sweep of
all fifteen routes, and the decisions below.

## Decisions already taken

- One shared instance for the team, hosted on the current WSL machine for the
  pilot and moved to a Linux VM with Docker later.
- Developers sign in with GitHub OAuth; membership of the `alepolab`
  organisation is required. The token from login is the developer's GitHub
  identity for pushes and PRs. No bot account.
- Each developer's Jira API token is stored on the server, encrypted at rest
  with a server key, and used for their runs, ticket reads and comments.
- Team-shared defaults (agents, skills, workflows, hooks, registry, recipes)
  live in the alepo-engineering plugin; the instance seeds from it.
- Primary daily uses, in order: run and watch SDLC pipelines; manage the team's
  Claude Code setup; work with Claude from the browser; share team standards.
- Graph, Explore, Output styles and the in-browser CLI terminal may be cut or
  hidden.

## Problem

The app was built for one developer on one laptop. The audit found the
assumptions that break under a team, and the dogfood sweep found what a
developer hits in the first ten seconds:

- Every route shows a full-page spinner for three to ten seconds because the
  shell waits for all six list fetches, and the skills list re-reads
  `~/.claude.json` once per skill and ships 6.9 MB of skill bodies nobody
  renders.
- The active config directory is a process-wide global that any user can
  repoint for everyone; folder pickers and "reveal in Finder" run on the server
  host; there is no authentication; two developers saving the same agent
  overwrite each other silently.
- A dead in-browser terminal subsystem, with its native `node-pty` dependency,
  still ships and still appears in CLAUDE.md; there is no README for a human.
- Identity is host-level: whoever runs the server is who pushes, comments and
  reads Jira.

## Goals

1. First paint under a second on every route with lists filling in.
2. Safe for many concurrent users: no shared mutable server state a request can
   repoint, no host-only features exposed, no silent last-write-wins on team
   files.
3. Every run, push, PR and Jira comment attributed to the developer who caused
   it.
4. A home screen that answers "what needs me" in one glance.
5. Team standards visibly in sync with the plugin, with drift shown and fixable
   in one click.
6. A new developer signs in and starts a run within five minutes, with a README
   that a human can follow.

## Non-goals

- Per-user `~/.claude` sandboxes. The team config is shared; personal
  overlays are a later feature.
- Fine-grained permissions. Any signed-in org member can do anything a
  developer can do; the audit trail records who.
- HTTPS termination and a public hostname. The pilot runs on the office network
  or VPN over HTTP; the VM move adds TLS.
- Rewriting the chat panel or the agent studio.

## Design

### Phase 1: shell speed, dead weight, multi-user safety

No dependency on identity. Ships first.

**Shell.** `app/app.vue` stops gating `<NuxtPage>` on the six list fetches.
It renders after `loadConfig()`; each page shows its own skeleton while its
list arrives. The sidebar counts appear when their lists do.

**Skills endpoint.** `server/api/skills/index.get.ts` loads the MCP server
list once per request and passes it to a pure matcher; the list response
carries `frontmatter`, `filePath`, `source`, `pluginName`, `agents` and
`mcpServer`, not `body`. The detail route keeps `body`. Components that read
`body` from the list (`ChatInput`, `EditorPanel`, `AgentWizard`,
`OnboardingFlow`) are switched to the detail route or do not need it.

**One read layer.** `server/utils/claudeIndex.ts` walks agents, commands and
skills once, caches the parsed result keyed by directory mtimes, and
invalidates on write endpoints and every 30 seconds. `agents`, `skill-counts`,
`skills` and `relationships` read from it instead of walking the tree
themselves.

**Dead weight removed.** The terminal stack (`app/components/cli/Terminal.vue`,
`MetricsCard.vue`, `ToolTimeline.vue`, `FileTree.vue`, `SessionHistory.vue`,
`ContextPanel.vue`, `useTerminal.ts`, `useContextMonitor.ts`,
`server/api/cli/ws.ts`, `server/utils/cliSession.ts`,
`server/utils/contextMonitor.ts`) and the dependencies only they used
(`node-pty`, `@xterm/*`, `chokidar` if unused elsewhere) go. `OnboardingFlow.vue`
goes. Graph, Explore and Output styles leave the sidebar behind a `labs`
flag in settings; their routes stay. CLAUDE.md loses the terminal section and
gains the real architecture.

**Multi-user safety.** The config directory comes from `CLAUDE_DIR` at boot
and cannot be changed at runtime: `POST /api/config` and the dashboard's
folder switcher go; the setup wizard only creates missing subfolders.
`pick-folder` and `reveal` return 404 unless `LOCAL_DESKTOP=1`; their buttons
hide otherwise. Every write endpoint for agents, commands, skills, workflows,
MCP and settings takes an `If-Match` header carrying the file's mtime or hash
as returned by the read, and answers 409 with the current version when it
differs; the editors show "changed by someone else, reload". `settings.put`
validates against a minimal schema before writing.

### Phase 2: identity

**Login.** `server/api/auth/login.get.ts` redirects to GitHub OAuth with scopes
`read:org repo`; `callback.get.ts` exchanges the code, checks
`GET /user/memberships/orgs/alepolab` is `active`, and stores `{ login, name,
avatar, githubToken }` in an h3 sealed session cookie (`useSession`, password
from `AGENT_MANAGER_SECRET`). `logout.post.ts` clears it. A server middleware
rejects every `/api/*` and page request without a session, except `/api/health`,
the auth routes, and everything when `AUTH_DISABLED=1` (local development). The
client gets `useUser()` and a user menu in the sidebar with name, avatar and
sign-out.

**Profile.** `app/pages/profile.vue` and `server/api/me.*`: Jira email and
API token, stored in `~/.agent-manager/users/<login>.json` with the token
encrypted AES-256-GCM under a key derived from `AGENT_MANAGER_SECRET`; a
"test connection" button runs `jira me` with those credentials. The GitHub
token from login is stored the same way so runs can use it after the browser
closes.

**Attribution.** `WorkflowRun` gains `startedBy: string` set from the session
by every start, restart, clone and continue. `agentCaller` accepts a per-call
`env` and the runner supplies the starter's `GH_TOKEN`, `GITHUB_TOKEN`,
`JIRA_API_TOKEN` and a per-user `JIRA_CONFIG_FILE` generated with their email.
Watches record `createdBy` and dispatch under that user's identity. The Runs
page gets a "mine" filter and shows the starter. The evidence bundle's
provenance names the starter.

### Phase 3: daily-use surface, team standards, deployment

**Home.** `app/pages/index.vue` becomes: needs attention (paused, failed,
interrupted runs, CI failing, watches escalated), my recent runs with cost,
team cost today and this week, team standards status, and one primary action:
start a run from a ticket key. The dashboard's current directory switcher and
suggestions block go.

**Team standards.** `server/api/team/status.get.ts` runs the sync's dry-run
logic and reports installed plugin version, drifted or missing agents, skills
and workflow, and registry validation. `POST /api/team/sync` applies it. The
page `app/pages/team.vue` shows this with a Sync button, and the seed runs
automatically at boot. "Promote to team" on an agent or skill opens a prepared
PR against `alepolab/agent-manager` moving the file into `engineering/` (this
one is last and may slip).

**Deployment.** `docker-compose.team.yml`: the app with `CLAUDE_DIR` on a
named volume seeded from the plugin at boot, `AGENT_WORKSPACE_ROOT` on a
volume for checkouts the provisioner clones on demand, the docker socket for
pipeline stacks, and env for `AGENT_MANAGER_SECRET`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `AGENT_MANAGER_URL`. The product header's checkout
convention reads `AGENT_WORKSPACE_ROOT/<repo>` instead of a hard-coded path.
A README for humans: prerequisites, one command to start, first sign-in, how
to add a product.

## Data flow for a run under identity

Developer signs in → session holds their GitHub token → starts a run from a
ticket key → `startedBy` recorded → intake expands the key with the starter's
Jira credentials → every agent call runs with the starter's tokens in its
environment → PR opens under the starter → Jira comment posts as the starter →
Runs page shows the starter, cost, CI.

## Error handling

- Login: org membership missing → a page saying which org is required and who
  to ask. OAuth failure → error page with the GitHub message, no stack trace.
- A run started by a user whose Jira token is absent → intake gets the bare
  key and says so in the packet; the profile page is linked from the run.
- 409 on a stale save shows the other author's name and time.
- Sealed session cookie invalid → treated as signed out, never a 500.

## Testing

- Unit: index cache invalidation; skills list has no `body`; If-Match 409 path;
  settings schema rejects malformed JSON; encryption round trip; session
  middleware allows and rejects correctly with `AUTH_DISABLED` off and on;
  starter's env reaches the agent caller.
- Live, with agent-browser: first paint under one second on every route;
  Skills page renders 495 cards without a shell spinner; two sessions editing
  one agent produce a 409 in the second; login round trip with a real OAuth app
  once its credentials exist; a run started by a signed-in user records
  `startedBy` and its PR is authored by that user.

## Prerequisites from you

1. A GitHub OAuth app under the alepolab org with callback
   `http://<host>:3030/api/auth/callback`; its client id and secret as
   environment variables.
2. A hostname or IP the team can reach for the pilot.
3. `AGENT_MANAGER_SECRET`, a random 32-byte string, kept out of the repo.

## Files

Phase 1: `app/app.vue`, `server/api/skills/index.get.ts`,
`server/utils/skillRelationships.ts`, new `server/utils/claudeIndex.ts`,
`server/api/agents/index.get.ts`, `server/api/agents/skill-counts.get.ts`,
`server/api/relationships.get.ts`, deletions listed above, `package.json`,
`server/api/config.post.ts` (removed), `app/pages/index.vue`,
`server/api/utils/pick-folder.post.ts`, `server/api/reveal.post.ts`, the
`[slug].put.ts` routes, `server/api/settings.put.ts`, editors that save,
`CLAUDE.md`, new `README.md` sections.

Phase 2: new `server/api/auth/*`, `server/middleware/auth.ts`, new
`server/utils/users.ts` (profiles, crypto), `app/composables/useUser.ts`,
`app/pages/profile.vue`, `app/app.vue` (user menu), `shared/types/run.ts`,
`server/utils/workflowRunner.ts`, `server/utils/agentCaller.ts`, run routes,
`app/pages/runs.vue`, watch types and starter.

Phase 3: `app/pages/index.vue`, new `app/pages/team.vue`, new
`server/api/team/*`, `server/plugins/teamSeed.ts`, `docker-compose.team.yml`,
`server/utils/runArtifacts.ts` (workspace root), `README.md`.
