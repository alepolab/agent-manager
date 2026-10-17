# Running a run's agents on another machine

Every step of a run is a Claude Code process working in the run's checkout.
By default it runs beside the server, on whatever that container has: its
CPU, its memory, its docker socket, its JDK. A **machine** registered under
Settings → Machines is somewhere else that process can run instead - a build
box with the toolchain a product needs, a host with the memory a stack needs,
a developer's own workstation - reached over ssh.

The rest of the pipeline does not change. Gates, briefs, the diff a reviewer
reads, the artifacts a later step is handed: all of it still reads the
server's own copy of the checkout and the evidence directory, because that
copy is carried to the machine before each step and back after it.

## How a step gets there

1. **The run picks its machine once, at the start.** The start dialog's
   choice, then the workflow's *Runs on* setting, then the instance default on
   the Machines page. The literal *This server* at any level stops the
   cascade. The choice is written on the run (`run.machine`) and every step
   uses it: the SDK session a step resumes lives on the machine it ran on.
2. **Preflight connects.** The `machine` check runs the same probe as *Test
   connection*: ssh reachable, `claude` on the login PATH, `git`, `rsync`
   (unless the filesystem is shared), the workspace root writable. A `fail`
   stops the run in seconds, before any model call.
3. **Before the step** (`sync` transport): the run's commits are pushed to a
   repository on the machine, the working tree is rsync'd over, and so is the
   run's evidence directory. The commits go to a holding ref
   (`refs/agent-manager/incoming`), never to the checked-out branch - git
   refuses to update a checked-out branch through a push, and a previous
   visit's uncommitted leftovers would make even `updateInstead` refuse. The
   machine then moves its branch to the ref and resets hard to it; the rsync
   that follows restores the server's copy of anything uncommitted.
4. **The process starts there.** The SDK's `spawnClaudeCodeProcess` hook
   spawns `ssh host bash -lc 'cd <dir> && exec env … claude <args>'`. The SDK
   speaks to the CLI over stdin and stdout, which ssh carries unchanged, so
   hooks, steering, the result message and the abort all work as they do
   locally.
5. **After the step**, success or failure alike: the commits the agent made
   are fetched and the server's worktree reset to them, then the working tree
   and the evidence directory are rsync'd back. The step log says what moved.

`shared` transport skips steps 3 and 5: the machine sees the server's paths
through one filesystem (NFS, a bind mount into a sibling container), and only
the path mapping below applies.

## What travels with a call

The run's identity, exactly as for a local call: `ANTHROPIC_*`, the GitHub
token (`GH_TOKEN`, `GITHUB_TOKEN`), the git identity and the signing override,
the Jira credentials, Claude Code's own switches, and the paths agents are
handed (`SDLC_SCRIPTS_DIR`, `CE_SKILLS_DIR`, `ALEPO_SKILLS_DIR`,
`SDLC_SKILLS_DIR`), re-rooted onto the machine. The machine keeps no
credentials of its own.

What never travels: this server's own secrets (`AGENT_MANAGER_SECRET`,
`GITHUB_CLIENT_SECRET`), its host environment (`PATH`, `HOME`, the proxy,
the port), and files that only exist here (`DOCKER_CONFIG`,
`JIRA_CONFIG_FILE`). The machine's own *Environment* field is added last and
wins - that is where `JAVA_HOME` or `DOCKER_HOST` for that host goes.

## Paths

Four of the server's roots can be re-rooted onto the machine; each is empty by
default, meaning the same absolute path on both sides, which is right for a
shared mount or two hosts with the same user and layout.

| Machine field | Re-roots |
|---|---|
| Checkouts root | `AGENT_WORKSPACE_ROOT` - where the run's worktree is |
| Evidence root | `AGENT_RUNS_DIR` - the run's artifacts directory |
| Agent Manager checkout | the server's own checkout (`/app` in the image), for `engineering/scripts` and the vendored skills |
| Claude config directory | `CLAUDE_DIR`, for the seeded skills |

The longest matching root wins, so a workspace nested under the home
directory still maps as a workspace.

## What the machine needs

- An ssh login the server can authenticate as: a pasted key (sealed with
  `AGENT_MANAGER_SECRET`, written 0600 only for ssh to read), a key file on
  the server, or the server's ssh agent and default keys. Batch mode is on:
  a password prompt fails rather than hangs.
- `claude` on that user's **login** PATH (`bash -lc` is used, so `~/.local/bin`
  and version managers apply), signed in or given `ANTHROPIC_API_KEY` by the
  server's environment.
- `git`, and `rsync` unless the transport is `shared`.
- Whatever the product needs: the JDK, docker, the browser the trace step
  drives. That is usually the reason the machine exists.
- The server's image carries `openssh-client` and `rsync` (Dockerfile).

## Limits worth knowing

- **Guardrail hooks run on the server.** The plan gate, the test lock and the
  secrets guard are SDK callbacks executed here, against the tool input the
  CLI sends. A hook that inspects files does so in the server's mirror of the
  checkout, which is a step behind the machine while the step runs.
- **Transcripts live on the machine**, under its `~/.claude/projects`. The
  `/cli` page cannot open them from here.
- **Containers a step starts on the machine are not reaped** by
  `runContainers.ts`, which asks the server's docker.
- **A machine switched off or removed** fails the next step of a run already
  on it, with the reason in the step log; clone the run onto another.
- **Clock and disk** are the machine's: a run that fills the machine's disk
  reports that as the step's error.

## Where it lives

- `server/utils/machines.ts` - the registry (`~/.agent-manager/machines.json`,
  `AGENT_MACHINES_FILE` overrides), validation, ssh argument building, the
  connection probe.
- `server/utils/remoteAgent.ts` - path re-rooting, the forwarded environment,
  the spawn hook, and the push and pull around a step.
- `server/api/machines/*` - CRUD, `default`, and `[id]/check`.
- `app/pages/settings/machines.vue`, `app/composables/useMachines.ts` - the
  page; the pickers are in `TriggerDrawer.vue` (per workflow) and
  `WorkflowRunModal.vue` (per run). `RunHeader.vue` shows where a run ran.
- `scripts/test-remote-machines.mjs` - the parts that can be wrong without a
  host to notice.
