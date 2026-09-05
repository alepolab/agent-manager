# selfcarenow

Stack recipe read by sdlc-stack-provisioner when the registry resolves a run to this product.

Checkout `~/alepo-workspace/selfcarenow`. Its `docker-compose.yml` bundles its own MongoDB replica set. The `latest` image tag is stale and crash-loops on a `pnpm install` at start; use the newest `develop-*` tag from GHCR instead. Host port 3000 is usually taken on this host, so publish on 3100 with a compose override using `ports: !override`. Set `CI=true`. The compose does not pass CRM settings through; add `CRM_BASE_URL`, `CRM_OAUTH_CLIENT_ID` and `CRM_OAUTH_CLIENT_SECRET` to the app environment as `\${VAR}` references so compose interpolates them from the checkout's `.env` without you reading the values. The build's `/api/health` is auth-gated and returns 401, so the shipped healthcheck never passes; override it to `GET /login` and treat a 200 there plus "Server ready" in the logs as up. Run it with `--project-directory` set to the checkout so compose finds that `.env`.
