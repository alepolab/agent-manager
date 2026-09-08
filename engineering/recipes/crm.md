# crm

DRAFT, derived on 2026-09-08 from `alepo-dev-team-infra/docker-compose.crm.yml` and from a pipeline run (CRM-76) that stood the stack up on a developer machine and halted on it. Everything below marked CONFIRM needs the CRM champion — in particular the one thing that stopped that run: where a Liferay default company is supposed to come from. Nothing here is inferred from a working environment, because this machine has never had one.

## Compose

- Deployment repo: `alepo-dev-team-infra`, file `docker-compose.crm.yml`, compose project name `crm`.
- `--profile crm-stack` starts the three services in order: `crm-init` (renders configs, seeds the menu/conf buckets, extracts the Liquibase changelog from the image), `crm-liquibase` (runs the migrations), then `crm` (Liferay/Tomcat, container `crm-app`).
- `crm` runs with `network_mode: host` and reaches MariaDB at `CRM_DB_HOST`.
- Standalone profiles: `crm-init`, `crm-liquibase`, and `crm-postmigrate`.

```
docker compose -f docker-compose.crm.yml --profile crm-stack --env-file .env up -d
```

**`crm-postmigrate` is a verifier, not a seeder.** Its entrypoint is `postmigrate-verify.sh`; the compose header's "Post-migration (SaskTel — run ONCE after crm-stack is healthy)" describes checking a migration, not bootstrapping an empty database. A run read that header as a bootstrap procedure and found nothing that bootstraps.

## Variables

`CRM_*` prefix in `alepo-dev-team-infra/.env`. Note that the repo's own `.env` on a developer machine may carry **no `CRM_*` keys at all** — the CRM stack is not part of the default local setup — so an agent standing this up has nothing to copy and will invent values unless this recipe names them.

- `CRM_DB_HOST`, `CRM_DB_NAME`, `CRM_DB_ROOT_USER`, `CRM_DB_ROOT_PASSWORD` — the MariaDB from the `database` stack.
- `CRM_IMAGE`/`CRM_TAG` and `CRM_LIQUIBASE_IMAGE`/`CRM_LIQUIBASE_TAG` (defaults to `ghcr.io/alepolab/alepo-dev-team-infra/alepo-jre-mysql:v4`). Pulling these needs a token with `read:packages`.
- `CRM_KC_ISSUER_URL` — `crm-init` seeds the Liferay OIDC config from it, so the Keycloak FQDN must resolve inside the container or seeding writes an unreachable issuer.

**CONFIRM — which database is canonical.** On the machine that produced this recipe, `infra-mariadb` held two candidates: `crmdb_singletenant` with 690 tables and no data, and `lportal` with zero tables. A run rendered `CRM_DB_NAME=lportal` and pointed Liferay at the empty one. Name the right database here, and say whether Liferay is expected to create its own schema in an empty one or to run only against the Liquibase-migrated schema.

## Health

- Container health is **not** sufficient evidence: `crm-app` reports healthy while every real request fails. Prove the application, not the container.
- Application check: the documented REST entry point `/o/rest-services/subscriber/addSubscriber`, or the web UI. `IllegalStateException: Unable to get default company ID` means the database has no Liferay company — see the trap below.
- CONFIRM: the exact URL, port and an authenticated call that proves a healthy stack.

## Traps

- **No company, no CRM.** Liferay serves nothing until its database holds a default company (`company` and `virtualhost` rows). The Liquibase changelog does not create one — `MySql.sql` carries the schema and zero `INSERT INTO company` statements — and no seed script, admin console or documented procedure for creating one exists in either this deployment repo or the `ase_lbss` checkout. A stack brought up from scratch is therefore **unusable until a database with a company is restored from somewhere else**. CONFIRM with the champion: which dump, from which environment, restored how.
- The repos under `ase_lbss/modules/*` are each their own git repo. A clone of `alepolab/ase_lbss` does not necessarily carry every module, so confirm the module a ticket names is actually present before concluding a file is missing — a run wrongly reported `modules/provisioning/provisioning-api/tomcat/conf/ase/templates/provisioning_script/pcrf_service_provisioning.bsh` absent when it was in its own workspace.
- The provisioning `*.bsh` files are BeanShell templates interpreted by the running server; nothing in `provisioning-api/src/main` references them, and the module ships a single JUnit test. A change to one of them cannot be verified without a working stack.
- `crm/data/` under the deployment repo holds rendered config, the extracted changelog and Liferay's document library. `rm -rf ./crm/data` is the documented full cleanup and discards all of it.

## Tests

CONFIRM. The registry entry carries `unit: 'CONFIRM'`; `ase_lbss` builds with Gradle and `modules/provisioning/provisioning-api` has a `src/test` tree, but the command the pipeline should run is unverified. Do not guess one — a fabricated test command reads as a passing gate.
