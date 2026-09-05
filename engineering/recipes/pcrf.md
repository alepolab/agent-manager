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

## Schema

`pcrf-liquibase` seeds and migrates the schema; the registry's `stack.liquibase` flag says whether tag and rollbackToTag are supported between attempts. Bind-mounted directories must be owned by UID/GID 9870, which `setup.sh` handles; for a manual compose path create and chown them first.

## Traps

- `pcrf-liquibase` running as root means the shared liquibase image is stale; the `:v4` tag is the non-root build.
- Two-node topology is the registry default for AAA-suite products: per-process state is not a correctness mechanism.
