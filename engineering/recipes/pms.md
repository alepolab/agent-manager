# pms

DRAFT, derived on 2026-09-05 from `alepo-dev-team-infra/docker-compose.pms.yml`, `.env.example` and the README's PMS section. Not yet run by the pipeline. Every CONFIRM needs the PMS repo champion.

## Compose

- Deployment repo: `alepo-dev-team-infra`, file `docker-compose.pms.yml`, on the external `alepo-shared` network. `--profile pms-stack` is required; every service sits behind it.
- Services: `minio` (object store, port 9000), `pms-app` (port 4040), `billing` (port 8000), `ratingengine` (port 8010), plus the `pms-minio-data` and `pms-cdr-data` volumes.
- Images default to `ghcr.io/alepolab/pms-partner-management`, `pms-billing`, `pms-ratingengine` at tag `develop`, and `minio/minio` at a pinned release.
- Prerequisites, not in this file: MongoDB and MariaDB from the `database` stack, Keycloak and URMS from the `sso` stack. Keycloak is on port 19080, not 8080.

```
docker compose -f docker-compose.pms.yml --profile pms-stack --env-file .env up -d
```

## Variables

`PMS_*` prefix, plus `MINIO_*`, in `alepo-dev-team-infra/.env`. Hard-required by the compose file itself: `MINIO_ROOT_PASSWORD`, `PMS_ENCRYPTION_KEY`, `PMS_SERVICE_TOKEN`.

- Generate locally: `PMS_ENCRYPTION_KEY`, `PMS_JWTOKEN_SECRET`, `PMS_SERVICE_TOKEN`, `PMS_INTERNAL_SERVICE_TOKEN`, `MINIO_ROOT_PASSWORD` (`openssl rand -hex 32` each).
- Point at shared stacks, CONFIRM the values: `PMS_KEYCLOAK_PUBLIC_URL` (browser-facing, must match the token issuer), `PMS_URM_SERVICE_PASSWORD`, `PMS_AUDITTRAIL_SERVER`, `PMS_BILLING_CACHING_SERVICE`.
- The Keycloak public key is validated against JWKS by kid; a stale value fails every login silently.

## Health

- `minio`: `curl -f http://localhost:9000/minio/health/live` inside the container.
- `pms-app`: `wget -qO- http://127.0.0.1:4040/auth/config` inside the container.
- `billing` and `ratingengine`: TCP connect checks on 8000 and 8010 from inside their containers; the compose healthchecks do the same with python.

## Traps

- PMS uses the shared Keycloak and URMS, not a bundled pair; standing up its own would split identities.
- A wrong `PMS_KEYCLOAK_PUBLIC_URL` produces logins that fail without an error in the app log.
