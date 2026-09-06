---
description: Deploy one Alepo application to one host through the deploy/ansible automation — dry run first, then apply on your say-so.
argument-hint: <app> <env> [host-or-ip]
allowed-tools: Bash, Read, Grep, Glob
---

# /deploy

Deploy one application to one host by driving
`deploy/ansible/deploy.sh` in the `alepo-dev-team-infra` checkout. That
script is the contract — this command never calls `ansible-playbook`
directly, never edits a role, and never invents a flag. If something can't be
expressed as a `deploy.sh` invocation, stop and say so rather than working
around it.

Input: `$ARGUMENTS` — `<app> <env> [host-or-ip]`, e.g. `cm dev dev-app-02`.

## 0. Where the automation lives

```bash
INFRA="${ALEPO_INFRA_DIR:-$HOME/alepo-dev-team-infra}"
cd "$INFRA/deploy/ansible" || exit 1
```

If that directory does not exist, stop and tell the operator to clone the
repo (or set `ALEPO_INFRA_DIR`). Do not clone it yourself — a deploy from a
checkout the operator did not choose is a deploy from an unknown revision.

Report the revision you are about to deploy from before doing anything else:

```bash
git -C "$INFRA" rev-parse --abbrev-ref HEAD && git -C "$INFRA" log --oneline -1
```

`deploy/ansible/` does not exist on every branch. If it is missing, say which
branch is checked out and stop.

## 1. Resolve the arguments

**App.** The valid list is the role directory — `ls -d roles/app_*` with the
`app_` prefix dropped and `_` read as `-`. There is no second list to keep in
step; if the app is not in that directory it is not deployable, so stop and
print what is. (`pcrf` is the one alias: it means `pcrf-server`, and the EMS
web tier is `pcrf-ems`.)

**Env.** One of `dev`, `staging`, `prod` — these are the inventory groups.

**Host.** Optional but strongly preferred: **one host per run.** Two runs
against the same host race each other's containers and both fail. Resolve it
against `inventory/hosts.yml`:

- Matches a host name under that env group → pass `--limit <name>`.
- Is an IP that some host's `ansible_host` already carries → use that host's
  name and say which one you matched.
- Is an IP nowhere in the inventory → **stop and ask.** Adding it means
  editing a version-controlled file that the whole team shares, and the entry
  needs a name as well as an address. Propose the exact YAML and let the
  operator confirm or add it themselves. Never write it silently.
- Omitted → the run targets every host in the group. Say so explicitly and
  get confirmation before proceeding.

## 2. Secrets

Every gate fails closed with an "empty password" error if the group's secrets
file is not passed, and that error does not name the real cause. Check it
first:

```bash
SECRETS="$HOME/.config/alepo-deploy/<env>.yml"
ls -l "$SECRETS"
```

Missing → stop, and tell the operator to run `tools/make-secrets.sh <env>`.
Never generate it for a host that already has data: the passwords in it are
the ones the databases were created with, and a fresh file locks the deploy
out of its own data.

Pass it as `-e @$SECRETS` in the pass-through args.

## 3. Dry run, always first

```bash
./deploy.sh --step deploy --env <env> --app <app> --yes --check \
  -- --limit <host> -e @"$SECRETS"
```

`--check` changes nothing on the host. Read the output and report, in a few
lines: what would change, the env-slice diff, and anything that failed
outright. A dry run that errors is a real finding — do not proceed past it.

For a host that has never run containers, Step 1 has to happen first
(`--step setup`, same flags). The deploy step says so itself when the host
isn't ready; only run setup when it does, and say why you are running it.

## 4. Ask before applying

Show the exact command you are about to run and wait for a yes. Do not
proceed on silence, and do not treat the dry run's success as the approval.

For `prod`, say plainly that the target is production and what the blast
radius is before asking.

## 5. Apply

```bash
./deploy.sh --step deploy --env <env> --app <app> --yes \
  -- --limit <host> -e @"$SECRETS"
```

Stream the output. If it fails, nothing is rolled back — the host is in
whatever state the last successful task left it. Re-running is safe and picks
up where it stopped, so report the failing task and ask before retrying
rather than looping.

Applications gate on their dependencies and refuse to start otherwise. A
failure that names a missing dependency is not this app's bug: report which
stack has to come up first. Cold-site order is `database`, then `sso`, then
anything else.

## 6. Prove it

```bash
./deploy.sh --step status --env <env> --app <app>
```

Note there is no `--limit` here on purpose: `status` and `logs` go through
`deploy.sh`'s ad-hoc path, which does **not** forward anything after `--`, so
a `--limit` would be silently ignored and the report would cover the whole
env group. Read the output per host and say which host you are reporting on.

Report the container state and health. Then read the app's
`roles/app_<app>/defaults/main.yml` and surface any caveat the deploy itself
flagged — several roles come up healthy while a specific integration is
still unconfigured, and that is exactly the state a "deployed OK" summary
hides. Say it in the summary, not only in the log.

Finish with: app, env, host, image tag deployed, container health, and
anything left for the operator to do.

## Pilot scope

Proven on `cm` (Collection Manager) against `dev`. The command is written
against `deploy.sh`'s interface rather than anything CM-specific, so other
apps in `roles/app_*` should work — but treat the first run of a new app as a
dry run and read the output before applying.
