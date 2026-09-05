# Environment profiles (V3)

## Why

A pipeline step (stand up a stack, restart a service, read a log) that
assumes the wrong environment produces confident nonsense, not an error: a
`dnf` command on a box that only has `apt`, a healthcheck aimed at a host
port that times out instead of refusing because it silently routed through
the host IP instead of the container's own service name. This registry
names the environments actually in play and the facts that differ between
them, so a step can ask instead of guess.

## What's in it

`registry/environments.yaml` (schema: `registry/schemas/environments.schema.json`,
validator: `scripts/validate-environments.mjs`) names three environments,
sourced from the user's own `~/.claude/CLAUDE.md` — nothing here is
invented:

- **`wsl-ubuntu`**, **`wsl-oraclelinux`** — the two WSL2 boxes on
  `XO-LAP-031` used for dev/devops work. Auto-detectable from
  `/etc/os-release` + WSL indicators.
- **`lab-ffmhost1`** — the shared lab host at `172.16.115.61` running the
  main docker stack. Deliberately **not** auto-detectable — a remote host
  can never be inferred from this machine's own `/etc/os-release`, so it is
  only ever reachable by naming it explicitly (`--env lab-ffmhost1`).

Each environment's `facts` map holds only what the source material actually
states — package manager, firewall, SELinux presence, auth log path, SSH
unit name for the two workstations; network/subnet, container-addressing
convention, the host-IP-routing timeout signature, timezone and registries
for the lab host. A fact not stated for an environment is simply absent
from its `facts` map — there is no default value anywhere in this system.

**Deliberately not built:** a fourth "customer-shaped topology" environment.
The task brief that asked for this file used that phrase as an illustrative
category, but no customer topology is named anywhere in
`~/.claude/CLAUDE.md` — inventing facts for one would violate the exact
rule this registry exists to enforce (absent and loud, never guessed).

## How a step consumes it

```bash
# Auto-detect this machine
node engineering/scripts/resolve-environment.mjs --json

# Name a remote/lab environment explicitly — required for anything with no
# `detect` block
node engineering/scripts/resolve-environment.mjs --env lab-ffmhost1 --json

# Ask for exactly one fact — a real pipeline step's actual use case
node engineering/scripts/resolve-environment.mjs --env lab-ffmhost1 --fact container_addressing
```

Asking for a fact the resolved environment does not declare is a loud
failure (`unknown: "<fact>" is not stated for <env>`, exit 1) — it never
falls back to another environment's value for the same fact name. This is
the same posture the evidence bundle takes on a missing artifact
(`docs/evidence-bundle.md`: "a missing artifact means the field is left
out, not defaulted").

This does not touch `registry/products.yaml` — that registry answers "which
repo, branch, and test command," and was deliberately left at five products
with no image/version fields. `environments.yaml` answers a different
question ("where is this running, and what's true there") and the two are
never merged.
