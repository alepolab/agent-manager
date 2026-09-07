---
description: Tear down one Alepo application on one host — containers, and staged files when asked. Never removes a volume or drops a schema, so the data survives.
argument-hint: <app> <target> [--purge]
allowed-tools: Bash, Read, Grep, Glob
---

# /teardown

The inverse of `/deploy`, driving the same script:
`deploy/ansible/deploy.sh --step down`. Same contract — never
`ansible-playbook` directly, never a role edit, never an invented flag.

Input: `$ARGUMENTS` — `<app> <target> [--purge]`, e.g. `cm dev-app-02 --purge`.

## 0. Where the automation lives, and what you are about to remove from

```bash
INFRA="${ALEPO_INFRA_DIR:-$HOME/alepo-dev-team-infra}"
cd "$INFRA/deploy/ansible" || exit 1
git -C "$INFRA" rev-parse --abbrev-ref HEAD && git -C "$INFRA" log --oneline -1
```

Missing directory → stop and say which branch is checked out. Do not clone.

## 1. Resolve app and target

Identical to `/deploy`. The data survives a teardown (§2), so the consequence
here is an outage rather than a loss — still worth being exact about, because
the wrong host means the wrong service goes down:

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

Two levels. Data is never one of them:

| Level | Flag | What goes |
|---|---|---|
| Containers | *(default)* | This app's containers and networks. Redeploy brings it back |
| Files | `--purge` | Also staged compose files, the rendered env slice, bind-mount sources and data directories. Leaves no credential on the host |

Pass only what the operator asked for. Do not add `--purge` because it looks
tidy.

### Never pass `--volumes`

`deploy.sh` accepts a `--volumes` flag. **This command does not use it, for
any application, ever** — not even when the operator writes `--volumes` in
the arguments. If they ask for it, say that teardown here is defined as
keeping the data, and that wiping a volume is a deliberate act to be done by
hand with the consequences in front of them:

```bash
./deploy.sh --step down --app <app> --env <env> --volumes    # NOT this command's job
```

Volumes are where the durable state lives. Five roles declare external ones —
`database` (one per `database_profiles`: `database_mariadb_data`,
`database_mongodb_data`, `database_mysql_data`), `rabbitmq`
(`rabbitmq_rabbitmq-data`), `vms` (`vms_vms-exports`), `pms`
(`pms_pms-minio-data`, `pms_pms-cdr-data`) and `oms` (`oms_wflow`). They are
declared `external` precisely so that `compose down -v` cannot reach them;
this command does not undo that.

### What survives a teardown, always

State it in the summary, because it is the whole point:

- **The volumes.** Nothing here removes one.
- **The schemas.** No teardown level drops a schema. `cm --purge` leaves
  `collection_manager` intact inside MariaDB, so a later redeploy finds the
  old data and Liquibase migrates it rather than creating it fresh.

So a teardown followed by a deploy is a restart with the data still there,
not a clean slate. If the operator wanted an empty database, this command is
not what does it — and say so rather than letting them assume otherwise.

`--purge` is safe against all of this: it removes staged files, the env slice
and the app's own bind-mounted directories (for `cm`, `cm/data/changelog` and
`cm/data/logs` — an extracted changelog and logs, both regenerated on the
next deploy). `app_database` declares no bind-mounted data directories at
all, so `--purge` there cannot reach the databases either.

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
./deploy.sh --step down --app <app> --yes --check <target flags> [--purge] -e @"$SECRETS"
```

The playbook prints a teardown plan naming the compose files, whether volumes
are wiped or kept (it will say kept — check that it does, and stop if it does
not), and whether staged files go. Read it back to the operator
in plain terms, then show the exact command without `--check` and wait for a
yes. Do not treat a clean dry run as the approval.

```bash
./deploy.sh --step down --app <app> --yes <target flags> [--purge] -e @"$SECRETS"
```

`--inventory` is a `deploy.sh` flag and goes before any `--`; `--limit` is an
ansible-playbook flag and goes after it. The secrets file
(`~/.config/alepo-deploy/<env>.yml`) is still needed: compose must parse the
same env files the stack was started with, or it cannot read the file at all.

## 5. Report

The playbook asserts no container of the app survived and fails naming any
that did — do not force anything past that, inspect it.

Do not expect a dangling-volume report. The playbook counts those only when
`down_volumes` is set, which this command never sets, so no such line will
appear — and its absence is correct, not a run that stopped early. If the
operator wants to know what is left on the host, `docker volume ls` answers
it without removing anything.

Finish with: app, host, level run, what was removed, and what was kept —
the volumes and the schema always, plus any shared path another stack still
references (those are kept automatically and the playbook names them).
