#!/bin/bash
# The robot-migration instance's operator commands. Runs INSIDE the pwmig/builder container (docker CLI +
# the host's socket + the pwmig_src volume at /src), never on the host, so nothing is written outside docker:
#
#   docker run --rm -it -e GH_TOKEN -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder <command>
#
# Commands, in first-time order:
#   preflight   read-only: our names, subnet and disk are free; lists what else runs (left alone)
#   fetch       fresh clones / pulls of ase-crm, agent-manager, atddtestsuite_bss and the suite into /src
#   build       builds every pwmig/* image from those clones (and wraps the external ones)
#   db-up       starts only pwmig-mariadb, ready for the dump
#   db-import   reads a crm14_db dump on stdin into pwmig-mariadb (pipe it in from the laptop)
#   up          starts the rest; sets the crm-api secret and Keycloak redirects; restarts the app on them
#   check       runs the access check inside pwmig-am
#   status | logs <service> | down (keeps every volume) | update (fetch + build + recreate app and am)
# Everything it creates is named pwmig*: containers, images, volumes, the network. It never touches anything else.
set -euo pipefail
KIT=/src/agentmanager/deploy/robot-migration
P=pwmig
log() { echo "[pwmig] $*"; }
die() { echo "[pwmig] ERROR: $*" >&2; exit 1; }
gitc() {  # git with the token from the environment, never written to a config or a URL on disk
  git -c credential.helper= -c credential.helper='!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f' "$@"
}
dc() {
  docker compose -p $P -f /src/ase-crm/docker/docker-compose.yml -f $KIT/compose/pwmig.override.yml \
    --env-file /src/ase-crm/.env --env-file $KIT/compose/pwmig.env "$@"
}
set -a; source $KIT/compose/pwmig.env; set +a

REPOS=(
  "ase-crm|alepolab/ase-crm|${ASE_CRM_BRANCH:-develop}"
  "agentmanager|alepolab/agent-manager|${AM_BRANCH:-feat/skill-attachments}"
  "atddtestsuite_bss|alepolab/atddtestsuite_bss|${ROBOT_BRANCH:-CRM_14.0}"
  "ase-crm-testPlaywright|jayeshchavan-alepo/ase-crm-testPlaywright|${SUITE_BRANCH:-workflow/main}"
)

preflight() {
  local bad=0
  log "containers / volumes / networks already named pwmig* (ours from an earlier setup, or a clash):"
  docker ps -a --format '{{.Names}}' | grep '^pwmig' || true
  docker volume ls --format '{{.Name}}' | grep '^pwmig' || true
  docker network ls --format '{{.Name}}' | grep '^pwmig' || true
  log "subnet $PWMIG_SUBNET must not overlap another network:"
  for n in $(docker network ls -q); do
    name=$(docker network inspect -f '{{.Name}}' "$n")
    [[ $name == pwmig-net ]] && continue
    for sn in $(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n"); do
      if python3 -c "import ipaddress,sys; sys.exit(0 if ipaddress.ip_network('$sn',False).overlaps(ipaddress.ip_network('$PWMIG_SUBNET')) else 1)" 2>/dev/null; then
        echo "  CLASH: $name uses $sn"; bad=1
      fi
    done
  done
  [[ $bad == 0 ]] && echo "  free"
  log "docker disk free: $(df -BG --output=avail /src | tail -1 | tr -d ' ') (need about 25G for images + data + runs)"
  log "other compose projects on this host (left alone):"
  docker compose ls -a --format '{{.Name}}' 2>/dev/null | grep -v "^$P\$" | sed 's/^/  /' || true
  [[ $bad == 0 ]] || die "pick another PWMIG_SUBNET / PWMIG_AM_IP in compose/pwmig.env"
}

fetch() {
  [[ -n ${GH_TOKEN:-} ]] || die "set GH_TOKEN (read access to the four repos, read:packages for ghcr)"
  for r in "${REPOS[@]}"; do
    IFS='|' read -r dir repo branch <<<"$r"
    if [[ -d /src/$dir/.git ]]; then
      log "pull $repo ($branch)"
      gitc -C /src/$dir fetch --quiet origin "$branch"
      git -C /src/$dir checkout --quiet -B "$branch" "origin/$branch"
    else
      log "clone $repo ($branch)"
      gitc clone --quiet --branch "$branch" "https://github.com/$repo.git" /src/$dir
    fi
    log "  $(git -C /src/$dir log --oneline -1)"
  done
  # ase-crm's .env is not in git: made from .env.example. The crm-api secret is filled in by `up`.
  if [[ ! -f /src/ase-crm/.env ]]; then
    cp /src/ase-crm/.env.example /src/ase-crm/.env
    sed -i "s#^CUBE_API_SECRET=.*#CUBE_API_SECRET=$(openssl rand -hex 24)#" /src/ase-crm/.env
    log "wrote /src/ase-crm/.env from .env.example"
  fi
  chmod -R a+rX /src
}

build() {
  [[ -d /src/ase-crm/.git ]] || die "run fetch first"
  local login; login=$(mktemp -d); export DOCKER_CONFIG=$login   # ghcr login lives only in this container
  trap 'rm -rf "$login"' RETURN
  [[ -n ${GH_TOKEN:-} ]] && echo "$GH_TOKEN" | docker login ghcr.io -u x-access-token --password-stdin >/dev/null
  b() { local tag=$1; shift; log "build $tag"; docker build --quiet --label pwmig=1 -t "$tag" "$@" >/dev/null; }
  b pwmig/docker-app:latest --build-arg GIT_COMMIT="$(git -C /src/ase-crm rev-parse --short HEAD)" -f /src/ase-crm/docker/Dockerfile /src/ase-crm
  b pwmig/mariadb-faketime:latest -f /src/ase-crm/docker/Dockerfile.mariadb /src/ase-crm/docker
  b pwmig/keycloak:26.0 -f $KIT/images/keycloak.Dockerfile $KIT
  b pwmig/stackctl:latest -f $KIT/images/stackctl.Dockerfile $KIT
  b pwmig/agent-runner:latest -f $KIT/images/agent-runner.Dockerfile /src/agentmanager
  local cube; cube=$(grep -m1 'image: cubejs/cube' /src/ase-crm/docker/docker-compose.yml | awk '{print $2}')
  b pwmig/cube:v1.7.40 --build-arg BASE="$cube" -f $KIT/images/wrap.Dockerfile $KIT
  b pwmig/s3mock:3.12.0 --build-arg BASE=adobe/s3mock:3.12.0 -f $KIT/images/wrap.Dockerfile $KIT
  b pwmig/socat:latest --build-arg BASE=alpine/socat:latest -f $KIT/images/wrap.Dockerfile $KIT
  b pwmig/alepobilling-14:v14.0.9 --build-arg BASE=ghcr.io/alepolab/alepobilling-14:v14.0.9 -f $KIT/images/wrap.Dockerfile $KIT
  docker builder prune -f --filter label=pwmig=1 >/dev/null 2>&1 || true
  docker image ls 'pwmig/*' --format '  {{.Repository}}:{{.Tag}} {{.Size}}'
}

kc() { docker exec pwmig-keycloak /opt/keycloak/bin/kcadm.sh "$@"; }

up() {
  dc up -d --no-build
  # The faketime volume is written by the tests (uid of pwuser in pwmig-am) and read by app, DB and Keycloak.
  docker run --rm --entrypoint sh -v ${P}_faketime:/f pwmig/socat:latest -c 'chmod 0777 /f' >/dev/null
  log "waiting for Keycloak"
  until kc config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null 2>&1; do sleep 3; done
  local id secret
  id=$(kc get clients -r alepo -q clientId=crm-api --fields id --format csv --noquotes)
  secret=$(kc get "clients/$id/client-secret" -r alepo --fields value --format csv --noquotes 2>/dev/null || true)
  [[ -n $secret ]] || secret=$(kc create "clients/$id/client-secret" -r alepo -i 2>/dev/null; kc get "clients/$id/client-secret" -r alepo --fields value --format csv --noquotes)
  [[ -n $secret ]] || die "could not read the crm-api client secret"
  local cid; cid=$(kc get clients -r alepo -q clientId=crm-client --fields id --format csv --noquotes)
  kc update "clients/$cid" -r alepo \
    -s "redirectUris=[\"http://localhost:$APP_PORT/*\",\"http://127.0.0.1:$APP_PORT/*\"]" \
    -s "webOrigins=[\"http://localhost:$APP_PORT\",\"http://127.0.0.1:$APP_PORT\"]"
  if ! grep -q "^KEYCLOAK_ADMIN_CLIENT_SECRET=$secret\$" /src/ase-crm/.env; then
    sed -i "s#^KEYCLOAK_ADMIN_CLIENT_SECRET=.*#KEYCLOAK_ADMIN_CLIENT_SECRET=$secret#" /src/ase-crm/.env
    log "crm-api secret set; recreating the app on it"
    dc up -d --no-build --no-deps --force-recreate app keycloak-forward
  fi
  log "waiting for the app (first boot runs Liquibase: can take several minutes)"
  until [[ $(docker exec pwmig-am curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:$APP_PORT/actuator/health 2>/dev/null) == 200 ]]; do sleep 10; done
  status
  log "UI: ssh -L 3031:$PWMIG_AM_IP:3030 <you>@<this host>, then open http://localhost:3031"
}

status() { docker ps -a --filter label=com.docker.compose.project=$P --format '  {{.Names}}\t{{.Status}}'; }

case ${1:-} in
  preflight) preflight ;;
  fetch) fetch ;;
  build) build ;;
  db-up) dc up -d --no-build mariadb; log "pwmig-mariadb starting; now pipe the dump into: ... db-import" ;;
  db-import)
    until [[ $(docker inspect -f '{{.State.Health.Status}}' pwmig-mariadb 2>/dev/null) == healthy ]]; do sleep 3; done
    log "importing the dump from stdin into crm14_db"
    docker exec -i pwmig-mariadb mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-root}" crm14_db
    log "imported: $(docker exec pwmig-mariadb mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-root}" -N -e 'select count(*) from information_schema.tables where table_schema="crm14_db"') tables" ;;
  up) up ;;
  check) docker exec pwmig-am /opt/pwmig/access-check.sh ;;
  status) status ;;
  logs) docker logs --tail 200 "pwmig-${2:?service}" ;;
  down) dc down ;;
  update) fetch; build; dc up -d --no-build --no-deps --force-recreate app am; status ;;
  *) sed -n '2,22p' "$0"; exit 1 ;;
esac
