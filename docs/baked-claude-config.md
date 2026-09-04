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

```bash
./scripts/stage-claude-config.sh          # or --with-md
docker compose up -d --build
```

To pick up newly baked config after a rebuild, the volume has to be recreated —
it is only seeded once:

```bash
docker compose down
docker volume rm agent-manager_claude-config
docker compose up -d
```

That discards anything created through the UI, which is why it is not the
default behaviour.

## Size

The payload is ~41M, dominated by the plugin cache. `.git` directories inside
plugin clones are stripped during staging.
