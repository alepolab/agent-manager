# pcrf

DRAFT, derived on 2026-09-05 from `alepo-dev-team-infra/docker-compose.pcrf.yml`, `.env.example` and the README's PCRF section. Nothing here has been run by the pipeline yet. Every CONFIRM needs the PCRF repo champion.

## Compose

- Deployment repo: `alepo-dev-team-infra`, file `docker-compose.pcrf.yml`, on the external `alepo-shared` network.
- Profiles: `pcrf-stack` brings up everything; `pcrf-server` (config + server + agent), `pcrf-ems` (EMS portal), `pcrf-liquibase` and `pcrf-init` (schema seed) are the partial profiles.
- Services: `pcrf-config`, `pcrf-server`, `pcrf-agent`, `pcrf-db-init`, `pcrf-liquibase`, `pcrf-ems`.
- Images: `PCRF_SERVER_IMAGE:PCRF_SERVER_TAG` has no default and must be set; agent, EMS and the liquibase runner default to `ghcr.io/alepolab/pcrf-ems-agent`, `ghcr.io/alepolab/pcrf-ems` and `ghcr.io/alepolab/alepo-dev-team-infra/alepo-jre-mysql:v4`.
- Bring up the `database` stack (MariaDB/MySQL) and the `sso` stack (Keycloak on 19080) first; compose cannot express `depends_on` across files.

## Variables

Set in `alepo-dev-team-infra/.env` under the `PCRF_*` prefix. The template marks these as required:

- Local, generate or point at the database stack: `PCRF_DB_HOST` (the database stack's service name), `PCRF_DB_PASSWORD` (the database stack's root password unless a dedicated user was created).
- External or issued by the SSO stack, CONFIRM where they come from: `PCRF_KEYCLOAK_URL`, `PCRF_KEYCLOAK_INTERNAL_URL`, `PCRF_BACKEND_CLIENT_SECRET`, `PCRF_AGENT_API_KEY`.
- Image tags: `PCRF_AGENT_TAG`, `PCRF_EMS_TAG`, and `PCRF_SERVER_TAG`; prefer an immutable `sha-*` or `ci-release-*` tag over `latest`.

Never copy a developer's `.env`. Pass generated values as shell environment for the `up` command.

## Health

The compose file declares no HTTP healthchecks for the server; prove it from inside the network with `docker exec` against the service ports and quote the output, and read `docker logs` for the server's own ready line. The EMS portal answers on its web port. CONFIRM the exact readiness signals with the champion.

## Clocks

`node engineering/scripts/check-clock-alignment.mjs --stack pcrf` — mandatory before this stack is called healthy, and its output goes on the release issue as G4 evidence (ALE-125). It reads three clocks: the engine host (`pcrf-server`, writes `EXPIRYDATE` from its own localtime), the EMS JVM (`pcrf-ems`, `isExpired()` → `LocalDateTime.now()`), and the database (`pcrf-db`, `findActiveLimitsByType` → `CURRENT_TIMESTAMP`), plus `PCRF_SESSION_TIME_ZONE` — the zone EMS *claims* the engine writes in, which is the pair that was wrong in the field (SBN-3787).

Two clocks against one naive `DATETIME` is two different instants, and the direction decides the damage: a westward EMS expires late and permits a debit against a lapsed credit source, which is PCRFV-1884 itself. The fix is one variable, `TZ` in `alepo-dev-team-infra/.env`; there is no image rebuild and no data migration, so rollback is `git checkout -- .env && docker compose --profile pcrf-stack up -d`.

Three traps this catches that reading the compose file does not:

- **`TZ` unset is not a default, it is two defaults.** The four PCRF services fall back to `Asia/Kolkata`; every database service in `docker-compose.database.yml` falls back to `UTC`. 5h30m apart, in the fail-open direction, with no operator error required.
- **A container can be given a `TZ` and ignore it.** With no tzdata in the image, glibc and musl silently run UTC — observed on a real container started with `TZ=Asia/Kolkata` that reported `+0000`. The script calls this `MISCONFIGURED` rather than letting the accidental agreement read as a pass.
- **One `.env` only protects a single host.** `pcrf-server` uses host networking because its Padlock licence is node-locked to the host NIC MAC (SBN-3141), and the agent runs on each engine node rather than alongside the EMS. In production the engine nodes and the EMS host have separate `.env` files and nothing cross-checks their `TZ` — which is why this is measured per install rather than ruled on once.

## Schema

`pcrf-liquibase` seeds and migrates the schema; the registry's `stack.liquibase` flag says whether tag and rollbackToTag are supported between attempts. Bind-mounted directories must be owned by UID/GID 9870, which `setup.sh` handles; for a manual compose path create and chown them first.

## Traps

- `pcrf-liquibase` running as root means the shared liquibase image is stale; the `:v4` tag is the non-root build.
- Two-node topology is the registry default for AAA-suite products: per-process state is not a correctness mechanism.
