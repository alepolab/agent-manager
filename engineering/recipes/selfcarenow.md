# selfcarenow

Stack recipe read by sdlc-stack-provisioner when the registry resolves a run to this product.

Deploy from `alepo-dev-team-infra/docker-compose.selfcarenow.yml` (profile `selfcarenow-stack`), never from the product's own `docker-compose.yml`. It is a different product from `docker-compose.selfcare.yml`, which is LUM Selfcare.

- **Image tag:** `SELFCARENOW_TAG` is required and has no default. `latest` is stale and crash-loops; use the newest `develop-<date>-<sha>` tag from GHCR (`docker images ghcr.io/alepolab/selfcarenow` shows the ones already pulled). A rebuilt image is `SELFCARENOW_IMAGE=localhost/agent-sdlc/selfcarenow SELFCARENOW_TAG=<run id>`.
- **Database:** Prisma on MongoDB needs a replica set; the shared `database` stack's MongoDB is standalone on main. On a dev host add `--profile selfcarenow-devdb`, which runs a single-node `rs0` as `selfcarenow-mongodb` and is the default `DATABASE_URL`; create its volume once with `docker volume create selfcarenow_devdb_data`. Start it and wait for health before the app.
- **Secrets:** generate an RS256 keypair (`openssl genrsa 2048`, `openssl rsa -pubout`, both `base64 -w0`) into `SELFCARENOW_JWT_PRIVATE_KEY_BASE64` / `SELFCARENOW_JWT_PUBLIC_KEY_BASE64`, `openssl rand -hex 32` into `SELFCARENOW_CONFIG_ENCRYPTION_KEY`, and random values into `SELFCARENOW_CSRF_SECRET` and `SELFCARENOW_ADMIN_API_JWT_SECRET`. Pass them as shell environment on the `up` command; never write them to a file or your output.
- **CRM:** `SELFCARENOW_CRM_API_URL` and the `SELFCARENOW_OAUTH_*` client; the app boots without them and the CRM screens fail until they are set. The provisioner has none: leave them unset and say so in the stack report.
- **Ports:** host port `SELFCARENOW_PORT` defaults to 3200 (3000 is taken on this host, 3100 is ANS). Inside the network the app is `selfcarenow-app:3000`.
- **Health:** `/api/health` is auth-gated (401), so the compose healthcheck probes `/login`; `up -d --wait` returns when it is 200 and the logs show "Server ready". First boot seeds the database and takes about a minute.
- **Network:** every compose in the deployment repo needs the external `alepo-shared` network; create it once with `docker network create --driver bridge alepo-shared` if `docker network ls` does not show it.
