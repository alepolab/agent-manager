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

**No repo token?** If your `GH_TOKEN` can't read the private repos (it still needs `read:packages` for `pw build`),
skip `pw fetch` and stream each clone in from the laptop instead. `pw import` unpacks it into a temporary folder,
swaps it in only once the whole tar has arrived, and makes `ase-crm/.env`. On the laptop:

```bash
H=alepo@10.79.8.126; export COPYFILE_DISABLE=1   # macOS: no ._ files in the tar
imp() { git clone -q --branch "$3" "https://github.com/$2.git" "$1" && tar -C "$1" -cf - . \
  | ssh $H "docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder import $1"; }
imp ase-crm                alepolab/ase-crm                          develop
imp atddtestsuite_bss      alepolab/atddtestsuite_bss                CRM_14.0
imp ase-crm-testPlaywright jayeshchavan-alepo/ase-crm-testPlaywright workflow/main
```

Later updates go the same way: `imp` the repo again, then `pw redeploy` (`pw update` would try to pull it).

**The database comes from the laptop,** because ase-crm's git has no `crm14_db` dump, and the sessions' seed rows exist only in the laptop's `crm-ui-mariadb`. Run this on the laptop:

```bash
docker exec crm-ui-mariadb mariadb-dump -uroot -proot --single-transaction --routines --triggers crm14_db \
  | ssh alepo@10.79.8.126 "docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder db-import"
```

**Or start with an empty database:** skip the dump. The app's Liquibase builds the schema and its reference
seed on first boot (`pw up` waits for it); `pwmig-billing` restarts until those tables exist, then runs.
Suites that rely on the laptop's session seed rows will need them added.

Back on the host:

```bash
pw up                        # the rest; sets the crm-api secret and Keycloak redirects; waits for the app (Liquibase on first boot)
docker exec -it pwmig-am claude      # log in once (/login), then exit; the login stays in volume pwmig_claude-home
docker restart pwmig-am pwmig-ports   # pwmig-ports lives in pwmig-am's network: restart them together
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

## A second lane (optional)
Two folders at once, each on its own CRM stack (`pwmig2-*`, ports 8084/3309/9004/8110/8281) and its own suite clone (`/work/ase-crm-testPlaywright-lane2`). One queue feeds both.
- **Stack:** `pw lane2-seed` copies lane 1's database and Keycloak into it. It stops `pwmig-keycloak` for about a minute, so run it between folders. Then `pw lane2-up`; `pw lane2-down` stops it again.
- **Clock:** stackctl turns on one stack's clock at a time (`/clock/on?stack=ui2`). A second clock-on waits for the first to end.
- **Clone:** made on `pwmig-am`'s next boot once the suite has `docker/stacks/ui2.env`. It shares lane 1's `node_modules`.
- **Queue:** add `"lanes": [{"name": "lane1"}, {"name": "lane2", "parameters": {"projectDir": "/work/ase-crm-testPlaywright-lane2", "localCheckout": "/work/ase-crm-testPlaywright-lane2", "crmStack": "ui2", "appUrl": "http://localhost:8084", "keycloakUrl": "http://localhost:8281", "dbHost": "localhost:3309"}}]` and `"laneKey": "robotFolder"` under `defaults`. The lanes then never work in the same top-level area at once.
- **Delivery:** both lanes deliver to GitHub's `workflow/main`, one at a time, through `/opt/pwmig/main-sync.sh`. The queue's precheck fast-forwards each clone before its run starts.
- **Failures:** a failed run in either lane still pauses the whole queue.

## UI → API optimization (a second workflow on the same stacks)
Workflow `ui-to-api-optimization` goes through the suite one test folder at a time, on branch `optimization`. Each test that drives the browser becomes API/DB setup and data checks plus a minimal UI test that keeps every UI assertion. A test that can't be split stays as it is. The rules are in the suite's `docs/optimization/README.md`.
- **Steps:**
  1. `ui-api-analyst` plans from the code only (no stack, no clock).
  2. `ui-api-converter` rewrites the tests, runs them on the lane's stack under `flock $CRM_LOCK`, and must pass `scripts/assertion-ledger.mjs`. It never moves the clock.
  3. `opt-branch-pusher` merges into `optimization` and pushes it (`/opt/pwmig/opt-sync.sh`), then Teams is told.
- **Stacks:** it shares `ui` and `ui2` with the migration. The two workflows wait for each other through the stack lock, and both queues may run at once.
- **Clones:** `/work/ase-crm-testPlaywright-opt1` (stack `ui`) and `-opt2` (`ui2`), made by `/opt/pwmig/opt-setup.sh`. It runs every boot once the workflow file is installed, or by hand without a restart. The script needs the deploy key and `optimization` on GitHub.
- **Queue items:** add them with `node /opt/pwmig/opt-seed-queue.mjs /work/ase-crm-testPlaywright-opt1 /data/am/claude/workflow-queues/robot-to-playwright-migration.json /data/am/claude/workflow-queues/ui-to-api-optimization.json --write`.
  - It adds only folders the migration has finished, one item per 15 UI specs, pilots first.
  - Re-run it as the migration finishes more folders.
  - Prefer `PUT /api/workflows/ui-to-api-optimization/queue` while the queue runs.
- **Precheck:** `opt-sync.sh pull` (main-sync.sh with `BRANCH=optimization`) fast-forwards `optimization`, then `opt-upmerge.sh` merges new `workflow/main` work into it. Then `scripts/ui-remaining.mjs` gives the next 15 specs; empty output means the item is done.
- **Second lane:** after the pilots, add `{"name": "opt2", "parameters": {"projectDir": "/work/ase-crm-testPlaywright-opt2", "localCheckout": "/work/ase-crm-testPlaywright-opt2", "crmStack": "ui2", "appUrl": "http://localhost:8084", "keycloakUrl": "http://localhost:8281", "dbHost": "localhost:3309"}}` to its `lanes`. `laneKey` is `laneArea` (the folder), so two lanes never take the same folder.

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
