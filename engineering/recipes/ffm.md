# ffm

DRAFT, derived on 2026-09-05 from `alepo-dev-team-infra/docker-compose.ffm.yml`, `.env.example` and the README's FFM section. Not yet run by the pipeline. Every CONFIRM needs the FFM repo champion.

## Compose

- Deployment repo: `alepo-dev-team-infra`, file `docker-compose.ffm.yml`, profile `ffm-stack`, on the external `alepo-shared` network.
- Services: `api` (Flask, port 5000) and `worker` (Celery). Both run as `alepo`, UID/GID 9870.
- Images: `FFM_API_IMAGE:FFM_API_TAG` and `FFM_WORKER_IMAGE:FFM_WORKER_TAG`; tags have no default and must be set.
- Prerequisites, brought up first from their own files: RabbitMQ (`docker-compose.rabbitmq.yml`), MongoDB from the `database` stack or an external one at `FFM_MONGO_HOST`, Keycloak from the `sso` stack with the `ffm-api` and `ffm-console` clients.
- Bind mounts `./ffm/data/logs/api` and `./ffm/data/logs/worker` must exist and be owned by 9870 before `up`.

```
docker compose -f docker-compose.ffm.yml --profile ffm-stack --env-file .env up -d
```

## Variables

`FFM_*` prefix in `alepo-dev-team-infra/.env`. Required by the template:

- Generate locally: `FFM_ENCRYPTION_KEY` (`openssl rand -hex 32`).
- Point at local stacks: `FFM_MONGO_HOST`, `FFM_MONGO_PASSWORD` (the database stack's defaults for a dev stack).
- Issued by Keycloak or the CRM, CONFIRM their source: `FFM_KEYCLOAK_URL`, `FFM_KEYCLOAK_FRONTEND_URL`, `FFM_KEYCLOAK_API_CLIENT_SECRET`, `FFM_OFFLINE_REFRESH_TOKEN` (minted on the CRM side, no default exists).
- Image tags: `FFM_API_TAG`, `FFM_WORKER_TAG`.

## Health

- `api`: `docker exec <api> curl -sf http://localhost:5000/health`.
- `worker`: the compose healthcheck runs `celery -A ffm_worker.worker.celery inspect ping` and expects `pong`; run the same with `docker exec` and quote it.

## Traps

- A worker that starts before RabbitMQ is reachable restart-loops with an empty `docker logs`; read the file log under the bind mount.
- Confirm both containers run as UID 9870 (`docker exec <c> id`) before trusting anything they write.
