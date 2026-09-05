# vms

DRAFT, derived on 2026-09-05 from `alepo-dev-team-infra/docker-compose.vms.yml`, `.env.example` and the README's VMS section. Not yet run by the pipeline. Every CONFIRM needs the VMS repo champion.

## Compose

- Deployment repo: `alepo-dev-team-infra`, file `docker-compose.vms.yml`, on the external `alepo-shared` network.
- Profiles: `vms-stack` for the app; `vms-liquibase` runs only the migration container.
- Services: `vms-liquibase`, `vms-app` (port 1337), `vms-exports`.
- Image: `VMS_IMAGE:VMS_TAG`, no default; set the tag explicitly.
- Prerequisites, brought up first: the `database` stack (the app creates its database with `createDatabaseIfNotExist`), and Keycloak from the `sso` stack with the `vms-web` and `vms-api` clients.
- The log bind mount for `vms-app` must be owned by 9870 before `up`.

```
docker compose -f docker-compose.vms.yml --profile vms-stack --env-file .env up -d
```

## Variables

`VMS_*` prefix in `alepo-dev-team-infra/.env`. Required by the template:

- Point at the database stack: `VMS_DB_HOST`, `VMS_DB_PASSWORD`, `VMS_DB_ROOT_PASSWORD` (the stack's defaults for a dev stack).
- Issued by Keycloak, CONFIRM their source: `VMS_KEYCLOAK_URL`, `VMS_KEYCLOAK_PUBLIC_URL`, `VMS_KEYCLOAK_PUBLIC_KEY`, `VMS_KEYCLOAK_API_CLIENT_SECRET`.
- Image tag: `VMS_TAG`.

## Health

`docker exec <vms-app> curl -sf http://localhost:1337/health`, which is the compose healthcheck; quote its output. Confirm the migration container exited 0 before judging the app.

## Traps

- Vouchers are a money path: the registry names `billing-owners` for `money` blast radius, so adversarial verification is required for such changes.
- The React 19 front end has UI evidence (`ui_trace: playwright`); a change there is not `n/a` for the browser trace step.
