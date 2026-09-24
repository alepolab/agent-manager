# ase-crm

Derived on 2026-09-23 from a full local bring-up on a Windows developer machine (Docker Desktop, `alepo-dev-team-infra` on branch `feat/ase-crm-stack` at `a501b57`). Every step below was run and its result checked: app readiness `UP`, an API call 401 without a token and 200 with one, the token `iss` equal to the issuer the app trusts, the SPA bundle carrying the same Keycloak URL, and the app reaching Billing container-to-container. Things that were not exercised are marked NOT VERIFIED.

This is the React + Spring Boot CRM (`alepolab/ase-crm`, Jira ASECRM). It is **not** `crm`, the Liferay product; `docker-compose.crm.yml` stands up the wrong application for it.

## Compose

Four stacks from `alepo-dev-team-infra`, all on the external `alepo-shared` network, brought up in this order. Order matters: Billing shares the CRM schema and needs the app's Liquibase run to have created it.

1. `docker-compose.database.yml --profile mariadb` - the estate MariaDB (`infra-mariadb`, alias `mariadb`).
2. `docker-compose.sso.yml --profile sso-stack` - Keycloak (`sso-keycloak`, :19080) and URMS (`sso-urms`, :3002).
3. `docker-compose.ase-crm.yml --profile ase-crm-stack` - `ase-crm-app`, `ase-crm-minio`, `ase-crm-minio-init`.
4. `docker-compose.billing.yml` - `--profile billing-init` on its own first, then `--profile billing-stack`. See the trap below.

Run each with `--project-directory <infra checkout> --env-file <env file>`. Keep the env file outside the repo; it holds every generated secret.

## Database

In `infra-mariadb`, before anything else starts:

- Schemas `keycloak` and `crm14_db` (the `database` stack's init script pre-creates `keycloak`; `crm14_db` is yours to create).
- One account per consumer, `%` host, full privileges on its schema only: `keycloak` on `keycloak.*`; `ase_crm` and `billing` both on `crm14_db.*`.
- Verify each account over TCP (`--protocol=TCP --host=127.0.0.1`), not the socket: a `%` grant does not match a socket login and the socket check passes when TCP would fail.
- Root access without handling the password on the host: `docker exec -i infra-mariadb sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -uroot'` with the SQL on stdin.

`crm14_db` stays empty until the app boots. There is no standalone migration path: Liquibase is embedded in the Spring Boot app and runs at startup.

## Image

No ase-crm image is published to GHCR (the Ansible role carries `app_image_tag: "<CHANGE_ME>"`). Build one from `develop`:

1. Export a clean tree, not the working checkout: `git -c core.autocrlf=false archive -o src.tar origin/develop`, then extract it. A Windows checkout with `core.autocrlf=true` gives `backend/gradlew` a CRLF shebang and the build dies with `backend/gradlew: not found`.
2. Put `frontend/.env.production` in the exported tree:
   ```
   VITE_KEYCLOAK_URL=http://localhost:19080
   VITE_KEYCLOAK_REALM=alepo
   VITE_KEYCLOAK_CLIENT_ID=crm-client
   ```
   The SPA reads these from `import.meta.env` at build time, `keycloak-provider.tsx` has no fallback, the Dockerfile takes no `VITE_*` build args, and no `frontend/.env*` is committed. Without this file the image builds and the browser login is broken.
3. `docker build --build-arg GIT_COMMIT=<sha> -f docker/Dockerfile -t ghcr.io/alepolab/ase-crm:local-develop-<sha> <tree>`, about 10 minutes cold. Pass the tag as `ASE_CRM_TAG`.

`develop` must be at or after `19fc7573a` (PR #787); that commit, built unpatched this way, is the image every check in this recipe passed against. Between `bf6e780cc` (2026-09-17, which added the `analytics` Gradle module) and that merge, the Dockerfile's per-module COPY list omitted `backend/analytics/` and every image build failed with `Configuring project ':analytics' without an existing directory`.

## Variables

The `.env.example` values that must change, and why:

- `KC_DB_ADDR=mariadb`, `KC_DB_USER=keycloak` - the service alias on `alepo-shared`, and the dedicated account rather than the example's `root`.
- `KEYCLOAK_PASSWORD` - generate it. `URMS_KC_PASSWORD` must then be that password AES-encrypted the way URMS decrypts it. The committed default decrypts to `admin`; do not fall back to it. Encrypt with the image's own code, without ever reading its key: `docker run --rm -e PW=<password> --entrypoint node ghcr.io/alepolab/urm/urms:v14.0.2 -e "process.stdout.write(require('/app/src/lib/encryption.js').tripleDesEncrypt(process.env.PW))"`, and round-trip it through `tripleDesDecrypt` before using it.
- `ASE_CRM_KC_ISSUER_URL=http://localhost:19080/realms/alepo` - must equal the `VITE_KEYCLOAK_URL` the image was built with plus `/realms/alepo`. A mismatch 401s every API call and nothing names the cause.
- `ASE_CRM_KC_JWK_SET_URI=http://sso-keycloak:19080/realms/alepo/protocol/openid-connect/certs` - the internal address, fetched container-to-container.
- `ASE_CRM_KC_ADMIN_CLIENT_SECRET` - read after URMS has seeded, from Keycloak's admin API: token from `/realms/master/protocol/openid-connect/token` (`admin-cli`, the `KEYCLOAK_USER`), then `GET /admin/realms/alepo/clients?clientId=crm-api` and `GET .../clients/<id>/client-secret`. It is random per fresh seed unless `URMS_SEED_PINNED_CLIENT_SECRETS` pins it.
- `ASE_CRM_MINIO_IMAGE=quay.io/minio/minio`, `ASE_CRM_MC_IMAGE=quay.io/minio/mc` - the compose defaults (`minio/minio`, `minio/mc` on Docker Hub) no longer pull: "repository does not exist".
- `BILLING_TAG=v14.0.9` with `BILLING_IMAGE` left as `ghcr.io/alepolab/alepobilling-14`. This file composes `${BILLING_IMAGE}:${BILLING_TAG}`; putting a tag in `BILLING_IMAGE` renders an invalid reference. (The product repo's own `docker/docker-compose.yml` is the opposite: there `BILLING_IMAGE` is the full reference and defaults to `:latest`, which is a 2026-07-16 build.) v14.0.9 is `billing_cpp14` commit `408b246`, released 2026-09-16.
- `BILLING_DB_SCHEMA=crm14_db`, `BILLING_DB_USER=billing` - Billing runs on the CRM's schema, not the `crmdb_singletenant` the example names (that is the Liferay CRM's).

GHCR pulls (Keycloak, URMS, Billing) need a `ghcr.io` login; a Docker Desktop credential-store entry is enough, no PAT in a file.

## Health

- **Keycloak's first boot outlives its healthcheck.** It rebuilds its server image and then migrates an empty `keycloak` schema; the 180s `start_period` runs out and compose reports `dependency failed to start: container sso-keycloak is unhealthy` while it is still working. Watch `sso/keycloak/data/logs/keycloak.log` for the realm import, wait for `healthy`, then run the same `up` again to start URMS.
- **URMS healthy does not mean seeded.** Prove the seed through the admin API: `crm-client` (public, direct grant on), `crm-api` (confidential, service account on) and the user `crmadmin` must exist in realm `alepo`. The realm JSON baked into the Keycloak image (`/opt/keycloak/data/import/alepo-realm.json`) contains neither client; `crm-client` appears in it only as an identity-provider setting. URMS's `seeder/services_crm.js` creates them.
- **The app's cold start is about 7 minutes.** Liquibase wrote 7,141 rows and the context started in 412s; readiness passed at 359s from container start. The compose `start_period: 900s` covers it. A warm start against an already-migrated schema took 76s.
- **Do not `up --wait` the `ase-crm-stack` profile.** `ase-crm-minio-init` is one-shot, and compose reports its clean `exited (0)` as a failure and returns 1 within seconds. Use `up -d` and poll `docker inspect -f '{{.State.Health.Status}}' ase-crm-app`.
- Readiness: `GET /actuator/health/readiness` returns `{"status":"UP"}`.
- Auth, the check that proves the stack: `GET /api/v1/dashboard/widgets` (requires only `isAuthenticated()`) must return 401 without a token and 200 with a password-grant token from `crm-client` for `crmadmin`. Decode the token and check `iss` equals `ASE_CRM_KC_ISSUER_URL`.
- Billing: from inside `ase-crm-app`, POST `{"BillingCommand":"getoutstandingamount","requestData":{"userId":"__healthcheck__"}}` to `http://billing:8007/`; `{"returncode":"-1","returnmessage":"User Not Found UserId:"}` is a working answer. Billing's log line `Database configured: mariadb / crm14_db / billing` confirms the schema. Send the body from a file: PowerShell 5.1 mangles inline JSON quotes and the reply is `JSON Exception`.

## Traps

- **`crm-client` only allows ports 8081 and 5173.** Its seeded redirect URIs and web origins are `http://localhost:8081` and `http://localhost:5173`. If 8081 is taken (a developer's own `bootRun` holds it), run the app on another port and add that origin to `crm-client` through the admin API, or the browser login is refused.
- **`billing-stack` cannot bootstrap on a fresh checkout.** Compose creates the `billing` container, and with it its file bind mounts, before `billing-init` runs. Docker creates each missing source as an **empty directory**: `billing/data/conf/rbs.conf`, `billing/data/scripts/{pre,post}_billing_script.sh`, `license/Alepo-License.lic`. `billing-init` then reads the directories as "already populated" and seeds nothing, and `billing` fails with `not a directory: Are you trying to mount a directory onto a file`. Run `--profile billing-init` alone first so the files exist; if the directories have already been created, they must be removed first.
- **The licence is operator-supplied and MAC-locked.** `license/Alepo-License.lic` is gitignored. On a developer machine the image's own copy works for the BillingCommand API: `docker create` the Billing image and `docker cp` `/home/alepo/rbsisp/License/Alepo-License.lic` out of it. This is what the product's dev compose effectively runs. The compose comments record that the daemon on bridge networking fails the licence check for licensed billing anyway (ErrorCode 1006); that path is `billing-batch` on host networking. NOT VERIFIED: licensed billing runs.
- **Port collisions with the product's and URM's own dev stacks.** On the machine that produced this, 8080, 9000 and 3000 were held by `C:\repos\urm`'s compose and 8107/3307/4000 by `C:\repos\ase-crm\docker`'s, both on the `alepo-dev` network with `ase-crm-*` and `alepo-*` container names. Those are not this stack; leave them alone. Free ports used here: app 38080, MinIO 39000/39100, Billing 38007. Keycloak must stay on 19080 because the SPA's URL is absolute.
- **Startup logs one error that does not fail readiness:** `PipelineInitializer - Failed to initialize operation [createDepartment] - ... pipeline processor 'com.alepo.se.extension.processor.CreateDepartme...` is not available. NOT VERIFIED: what depends on it.

## Tests

`make test` from the product repo, as the registry declares. For a backend change, the containerized equivalent is the Dockerfile's `backend-builder` target: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal <builder image> bash -c "cd /workspace && backend/gradlew -p backend <task> --no-daemon"`. No ATDD command is registered: `make atdd` exists but its Playwright reporters do not emit xunit.

## Teardown

Reverse order, `down --remove-orphans` per stack: billing, ase-crm, sso. The `database` stack is shared estate infrastructure; take it down only if nothing else on the host uses it. Named volumes (`ase-crm-*`, `database_mariadb_data`) survive `down`; removing them loses the migrated schema and the Keycloak realm, and the next start pays the cold-start cost again.
