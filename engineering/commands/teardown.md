---
description: Tear down one Alepo application on one host — containers by default, volumes and staged files only when asked, and never the database volumes.
argument-hint: <app> <target> [--volumes] [--purge]
allowed-tools: Bash, Read, Grep, Glob
---

# /teardown

The inverse of `/deploy`, driving the same script:
`deploy/ansible/deploy.sh --step down`. Same contract — never
`ansible-playbook` directly, never a role edit, never an invented flag.

Input: `$ARGUMENTS` — `<app> <target> [--volumes] [--purge]`, e.g.
`cm dev-app-02 --purge`.

## 0. Where the automation lives, and what you are about to remove from

```bash
INFRA="${ALEPO_INFRA_DIR:-$HOME/alepo-dev-team-infra}"
cd "$INFRA/deploy/ansible" || exit 1
git -C "$INFRA" rev-parse --abbrev-ref HEAD && git -C "$INFRA" log --oneline -1
```

Missing directory → stop and say which branch is checked out. Do not clone.

## 1. Resolve app and target

Identical to `/deploy`, and worth being stricter about here because the
consequence is destructive:

- **App** — from `ls -d roles/app_*`, `app_` dropped, `_` read as `-`.
- **Target** — a host name or known IP resolves its env from its group in
  `inventory/hosts.yml`; pass `--env <group> -- --limit <host>`. An env name
  means every host in the group — for a teardown, refuse that unless the
  operator confirms it a second time, naming the hosts. No target at all
  means this machine: `--env dev --inventory inventory/local.yml`.
- A placeholder address (`192.0.2.0/24`, or an entry marked `TODO`) is not a
  target. Stop.

Call the result the **target flags** and reuse them verbatim below.

## 2. Decide the level — default is the least destructive

Three levels, each explicit and off by default:

| Level | Flag | What goes |
|---|---|---|
| Containers | *(default)* | This app's containers and networks. Reversible: redeploy brings it back |
| Volumes | `--volumes` | Also its Docker volumes, **including the external ones**. Irreversible |
| Files | `--purge` | Also staged compose files, the rendered env slice, bind-mount sources and data directories. Leaves no credential on the host |

Never add `--volumes` or `--purge` because they seem tidy. Pass only what the
operator asked for, and say which level you are running.

### The database volumes are off limits

`--volumes` removes whatever `app_external_volumes` declares for that role.
Only five roles declare any:

| App | External volumes |
|---|---|
| `database` | one per `database_profiles` on that host — `database_mariadb_data`, `database_mongodb_data`, `database_mysql_data` |
| `rabbitmq` | `rabbitmq_rabbitmq-data` |
| `vms` | `vms_vms-exports` |
| `pms` | `pms_pms-minio-data`, `pms_pms-cdr-data` |
| `oms` | `oms_wflow` |

**Refuse `--volumes` on `database`.** That is every schema on the host — the
one thing here with no way back, and the reason those volumes are `external`
in the first place (`compose down -v` cannot reach them by design). Tear its
containers down if asked; leave the data. If the operator insists, make them
say so in a separate message that names the volumes, and tell them the
schemas of every other app on the host go with it.

For the other four, name the exact volume and what is inside it, and get a
yes before running.

Every other app declares no external volumes at all, so `--volumes` there is
genuinely cheap: their state is bind-mounted directories plus a schema
**inside** MariaDB, which no teardown level touches.

### What teardown does not do

Say this in the summary whenever it applies: tearing an application down
never drops its schema. `cm` torn down with `--volumes --purge` leaves
`collection_manager` intact inside MariaDB, so a later redeploy finds the old
data and Liquibase migrates it rather than creating it fresh. If the operator
wanted an empty database, this command is not what does it.

## 3. Order matters for a whole host

The teardown order is the reverse of the deploy order: **applications first,
then `rabbitmq`, then `sso`, then `database`.**

`database` and `sso` are gated on by everything else. Tearing either down
while other stacks are still running on that host does not fail loudly — the
running apps simply start failing at their next database call or token mint.
If the target app is `database` or `sso`, check what else is deployed there
(the host's `host_apps` in `host_vars`) and say what will break.

## 4. Dry run, then confirm, then run

```bash
./deploy.sh --step down --app <app> --yes --check <target flags> [--volumes] [--purge] -e @"$SECRETS"
```

The playbook prints a teardown plan naming the compose files, whether volumes
are wiped or kept, and whether staged files go. Read it back to the operator
in plain terms, then show the exact command without `--check` and wait for a
yes. Do not treat a clean dry run as the approval.

```bash
./deploy.sh --step down --app <app> --yes <target flags> [--volumes] [--purge] -e @"$SECRETS"
```

`--inventory` is a `deploy.sh` flag and goes before any `--`; `--limit` is an
ansible-playbook flag and goes after it. The secrets file
(`~/.config/alepo-deploy/<env>.yml`) is still needed: compose must parse the
same env files the stack was started with, or it cannot read the file at all.

## 5. Report

The playbook asserts no container of the app survived and fails naming any
that did — do not force anything past that, inspect it.

It also counts volumes left dangling that belong to no compose project.
Report the count; `docker volume prune` is the operator's call, never yours,
because it reaches beyond this application.

Finish with: app, host, level run, what was removed, what was deliberately
kept (shared paths other stacks still reference are kept automatically, and
the playbook says which), and the schema note from §2 where it applies.
