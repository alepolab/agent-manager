# Robot → Playwright migration on a shared host (containers only)

Runs Agent Manager with the `robot-to-playwright-migration` workflow and its run queue, plus its own ase-crm stack,
as one docker compose project `pwmig`. The host is shared (another team's Agent Manager and `sdlc-*` stacks
run there), so the setup **touches nothing outside docker objects named `pwmig*`**:

- **No host folders.** Everything lives in named volumes `pwmig_*`; data is streamed in (`docker exec -i`).
- **No host ports.** The UI is reached by an SSH tunnel to a container IP on our own network.
- **Our own images, network and volumes:** `pwmig/*`, `pwmig-net` (172.31.250.0/24) and `pwmig_*`. External images are wrapped under `pwmig/*`, so no shared image tag ever moves.
- **Limits:** memory and CPU limits on every container (about 9 GB of RAM in total).
- **Docker access:** only `pwmig-stackctl` holds the docker socket. It does exactly one thing, the CRM clock on/off for project `pwmig`. Agents run in `pwmig-am`, which has no docker access.
- **The other Agent Manager can't touch it:** it only reaps `sdlc-<run>` projects and containers mounted from its own run folders.

## What runs

| Container | What |
|---|---|
| `pwmig-am` | Agent Manager (bun, production build) and the agents' toolchain: node, git, flock, robotframework, chromium. State in `/data`, repos in `/work`. |
| `pwmig-ports` | Inside `pwmig-am`, makes `localhost:8083/8280/3308/8109/9003` reach the stack, so the suite runs exactly as on the laptop (`stack.sh test-env ui`). |
| `pwmig-app`, `-mariadb`, `-keycloak`, `-keycloak-forward`, `-billing`, `-minio`, `-cube` | The ase-crm stack, built from a fresh `ase-crm` clone. |
| `pwmig-stackctl` | `POST /clock/on`, `/clock/off`, `GET /status`. `stack.sh clock` calls it when `STACKCTL_URL` is set. |

## First-time setup (on the host, in a terminal; about an hour, mostly builds)

You need:
- **`GH_TOKEN`:** read access to `alepolab/{ase-crm,agent-manager,atddtestsuite_bss}` and `jayeshchavan-alepo/ase-crm-testPlaywright`, plus `read:packages` for the billing image on ghcr. It is passed to each command and never written to disk.
- **SSH from your laptop to the host,** for the database dump.

```bash
# 0. The operator image, built from stdin so no file is written on the host (same as builder/Dockerfile).
docker build -t pwmig/builder - <<'EOF'
FROM alpine:3.20
LABEL pwmig=1
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git bash curl python3 openssl coreutils
ENTRYPOINT ["/bin/bash", "-c", "set -e; if [ ! -d /src/agentmanager/.git ]; then : \"${GH_TOKEN:?set GH_TOKEN}\"; git -c credential.helper='!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' clone -q --branch \"${AM_BRANCH:-feat/skill-attachments}\" https://github.com/alepolab/agent-manager.git /src/agentmanager; fi; exec bash /src/agentmanager/deploy/robot-migration/builder/pwmig.sh \"$@\"", "--"]
EOF
export GH_TOKEN=...          # this shell only
pw() { docker run --rm -i -e GH_TOKEN -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder "$@"; }
docker volume create pwmig_src

pw preflight                 # read-only: names, subnet, disk; lists the other stacks it will leave alone
pw fetch                     # fresh clones: ase-crm@develop, agent-manager, atddtestsuite_bss@CRM_14.0, suite@workflow/main
pw build                     # pwmig/* images (app and DB from the fresh ase-crm)
pw db-up                     # only pwmig-mariadb
```

**The database comes from the laptop,** because ase-crm's git has no `crm14_db` dump, and the sessions' seed rows exist only in the laptop's `crm-ui-mariadb`. Run this on the laptop:

```bash
docker exec crm-ui-mariadb mariadb-dump -uroot -proot --single-transaction --routines --triggers crm14_db \
  | ssh alepo@10.79.8.126 "docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder db-import"
```

Back on the host:

```bash
pw up                        # the rest; sets the crm-api secret and Keycloak redirects; waits for the app (Liquibase on first boot)
docker exec -it pwmig-am claude      # log in once (/login), then exit; the login stays in volume pwmig_claude-home
docker restart pwmig-am
pw check                     # access check inside pwmig-am: every line must be ok
```

**Open the UI** from your laptop with `ssh -N -L 3031:172.31.250.10:3030 alepo@10.79.8.126`, then go to http://localhost:3031.
- **Teams notifications:** on the Channels page, add the `robot-migration` channel with your webhook.
- **The queue:** start it from the workflow page's Run queue panel. Its check skips what is already ported, and pauses the queue if the docker disk falls under 15 GB.

## Day to day

- **Gates:** questions stop at a gate, and you're notified through Teams. Clean hand-overs pass by themselves.
- **Delivered work** is merged into `workflow/main` in volume `pwmig_work`. Pushing it to GitHub is your step, after review:
  ```bash
  docker exec -it -e GH_TOKEN pwmig-am bash -c 'cd /work/ase-crm-testPlaywright-workflow && git -c credential.helper= -c credential.helper="!f() { echo username=x-access-token; echo password=\$GH_TOKEN; }; f" push https://github.com/jayeshchavan-alepo/ase-crm-testPlaywright.git workflow/main'
  ```
- **Fresh ase-crm:** `pw update` pulls, rebuilds, and recreates `app` and `am`. Pause the queue first.
- **Commands:** `pw status`, `pw logs <service>`, and `pw down`, which stops everything but keeps all volumes.
- **Restarts:** they're safe. Runs resume, and the queue moves on, after a container or host restart.

## Removing it completely
`pw down`, then:

```bash
docker volume rm $(docker volume ls -q | grep '^pwmig_')
docker image rm $(docker image ls 'pwmig/*' -q)
docker network rm pwmig-net
```

Nothing else on the host was ever created or changed.

## Refreshing the kit (laptop)
`deploy/robot-migration/state/export-state.sh` copies the migration's agents, workflow, queue and SKILL.md files from `~/.agent-manager-new` with container paths. Commit it, push the branch, then run `pw update` on the host.
