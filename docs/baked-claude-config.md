# Baked Claude config

The image is self-contained: plugins, skills, agents and settings travel with
it, so deploying on a fresh host does not require that host to have a
`~/.claude` of its own.

## How it works

1. `scripts/stage-claude-config.sh` copies an **allowlist** of config out of
   `~/.claude` into `docker/claude-config/` (git-ignored, rebuilt each run).
2. `Dockerfile` does `COPY docker/claude-config /root/.claude`.
3. `docker-compose.yml` mounts a **named volume** at `/root/.claude`.

Step 3 is the part that is easy to get wrong. A *bind* mount shadows whatever
the image has at that path, so baking anything in would be pointless. A *named*
volume is seeded from the image on first creation, so the baked config becomes
the starting state and anything created afterwards through the UI persists.

## What is and is not baked in

| Included | Excluded, and why |
|---|---|
| `plugins/` — installed plugins and marketplace metadata | `.credentials.json` — live OAuth tokens |
| `skills/` | `projects/` — session transcripts, plaintext, ~28M |
| `agents/` | `history.jsonl`, `paste-cache/`, `session-env/` — command history and pasted content |
| `commands/`, `output-styles/` | `shell-snapshots/`, `backups/`, `file-history/`, caches |
| `settings.json` | Global `CLAUDE.md` — opt-in via `--with-md` |

The global `CLAUDE.md` is excluded by default because it names internal hosts,
IP addresses, the registry and the repo map. That is fine on a laptop and wrong
in an image pushed to a registry. Pass `--with-md` if the image is staying
internal and you want it.

## Fail-closed

The script stages an allowlist and then re-checks the staged tree against a
denylist of names, top-level directories and credential-shaped file contents.
Any hit **aborts** and deletes the staging directory rather than dropping the
file quietly — a hit means the allowlist grew a hole, and the allowlist is what
needs fixing.

Both checks exist deliberately. An allowlist alone still ships a secret the
first time someone adds an entry to it without thinking.

## Usage

`docker compose up -d --build` builds the image **from the repo tree**, not
from an image built elsewhere — it does not know or care whether
`docker/claude-config` is stale, missing, or from a different host's
`~/.claude`. If you skip staging first, it will happily bake in whatever was
staged last (or nothing) and ship it.

The redeploy sequence that actually works, in order, and why each step exists:

```bash
# 1. Stage: refresh docker/claude-config from THIS host's ~/.claude. Skipping
#    this is the #1 way a rebuild ships a stale payload — `--build` rebuilds
#    the image from whatever is already sitting in docker/claude-config, which
#    could be from an earlier run, or absent entirely.
./scripts/stage-claude-config.sh          # or --with-md

# 2. Build: bakes the freshly staged config into a new image layer via the
#    Dockerfile's `COPY docker/claude-config /root/.claude`. The running
#    container is untouched until step 4.
docker compose build

# 3. Remove the volume: a NAMED volume seeds ONLY ON CREATION (see above), so
#    the new image layer from step 2 is inert until the volume that shadows it
#    is gone. `down` alone is not enough — it stops the container but leaves
#    the volume (and its stale seed) in place for the next `up` to reattach.
#    This is the step that has been skipped twice, both times silently keeping
#    the previous deploy's agents and skills after what looked like a
#    successful rebuild.
docker compose down
docker volume rm agent-manager_claude-config

# 4. Up: creates a new container against the new image, and — because the
#    volume from step 3 is gone — a new volume seeded from the fresh layer.
docker compose up -d
```

Removing the volume discards anything created through the UI since the last
seed, which is why it is not automatic. There is no dry-run for "will this
volume reseed" short of running `docker volume rm` — decide before step 3
whether anything in the running instance's UI-created state needs to be saved
elsewhere first (a workflow definition, an edited agent) — the redeploy
does not merge old and new, it replaces.

A build with a stale `docker/claude-config` does not fail or warn — the image
builds successfully and serves fine, just with last time's agents/skills/
plugins instead of this time's. There is no error to notice; the only tell is
the served config not matching what you just changed in `~/.claude`.

## Optional: reading a host directory directly

`docker-compose.yml` also accepts `HOST_CLAUDE_DIR` and `HOST_AGENT_RUNS_DIR`
to bind-mount a host path over `/root/.claude` and
`/root/.agent-manager/workflow-runs` respectively, instead of the named
volumes above:

```bash
HOST_CLAUDE_DIR="$HOME/.claude" \
HOST_AGENT_RUNS_DIR="$HOME/.agent-manager/workflow-runs" \
docker compose up -d
```

This exists for one reason: a workflow run started on the host with
`node scripts/run-ticket.mjs` writes its run record under the host's
`CLAUDE_DIR` (`~/.claude/workflow-runs/`) and its artifacts under
`AGENT_RUNS_DIR` (`~/.agent-manager/workflow-runs/` by default). A container
using the default named volumes is a **completely separate filesystem** from
that host path and will never see that run — `GET /api/workflows/<slug>/runs`
comes back empty in the container while `GET /api/runs/<id>` on a dev server
pointed at the host directly shows the same run with all its steps. Setting
both `HOST_*` vars to the same paths the host CLI is using is what makes the
two agree.

**This is a real trade-off, not a free upgrade**: a bind mount **shadows** the
image's baked config entirely (this is exactly why the project moved off
`~/.claude:/root/.claude` to a named volume in the first place — see the
comment in `docker-compose.yml`). With `HOST_CLAUDE_DIR` set, the curated
agents/skills/plugins this image ships with do **not** appear unless they
already exist at that host path — you get the host's `~/.claude`, full stop,
not a merge of the two. Only set it when you specifically want this container
sharing state with a host directory, and expect the baked config to disappear
from view while you do. Leave both unset for the normal, self-contained
deployment.

`GET /api/health` reports the two directories an instance is actually reading
(`claudeDir`, `agentRunsDir`) — check it first before concluding a run "isn't
there"; it usually means the run is in the other store, not that it never
happened.

## Size

The payload is ~41M, dominated by the plugin cache. `.git` directories inside
plugin clones are stripped during staging.
