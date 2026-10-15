#!/bin/bash
# The robot-migration instance's operator commands. Runs INSIDE the pwmig/builder container (docker CLI +
# the host's socket + the pwmig_src volume at /src), never on the host, so nothing is written outside docker:
#
#   docker run --rm -it -e GH_TOKEN -v /var/run/docker.sock:/var/run/docker.sock -v pwmig_src:/src pwmig/builder <command>
#
# Commands, in first-time order:
#   preflight   read-only: our names, subnet and disk are free; lists what else runs (left alone)
#   fetch       fresh clones / pulls of ase-crm, agent-manager, atddtestsuite_bss and the suite into /src
#   import <dir> reads a tar of one clone on stdin into /src/<dir>, for a token without access to the
#               private repos: stream it from a laptop clone (see the README, "No repo token")
#   build       builds every pwmig/* image from those clones (and wraps the external ones)
#   db-up       starts only pwmig-mariadb, ready for the dump
#   db-import   reads a crm14_db dump on stdin into pwmig-mariadb (pipe it in from the laptop)
#   up          starts the rest; sets the crm-api secret and Keycloak redirects; restarts the app on them
#   check       runs the access check inside pwmig-am
#   status | logs <service> | down (keeps every volume) | update (fetch + build + recreate app and am)
#   redeploy    build + recreate app and am, without fetch (after an import)
# Lane 2 (a second CRM stack, compose project pwmig2, for a second queue lane):
#   lane2-seed  copies lane 1's data into lane 2 (empty lane 2 only): crm14_db by mariadb-dump, Keycloak's H2
#               files with pwmig-keycloak stopped for about a minute. Run it between two folders.
#   lane2-up    starts lane 2, attaches pwmig-am to pwmig2-net, sets Keycloak's redirects for its app port
#   lane2-down  stops lane 2 (keeps every pwmig2_* volume)
#   deploy-key  makes the suite's push key in pwmig-am (once) and prints its public half: add it to the
#               suite repo as a deploy key with write access, and each delivered folder is pushed
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
# Clones streamed in from a laptop keep its uid; without this git refuses them ("dubious ownership").
# This container's own global config only, gone when it exits.
git config --global --add safe.directory '*'

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
  prepare_src
}

prepare_src() {
  # ase-crm's .env is not in git: made from .env.example. The crm-api secret is filled in by `up`.
  if [[ ! -f /src/ase-crm/.env ]]; then
    cp /src/ase-crm/.env.example /src/ase-crm/.env
    sed -i "s#^CUBE_API_SECRET=.*#CUBE_API_SECRET=$(openssl rand -hex 24)#" /src/ase-crm/.env
    log "wrote /src/ase-crm/.env from .env.example"
  fi
  chmod -R a+rX /src
}

import_src() {  # $1 one of the REPOS dirs; the tar of that clone (with .git) on stdin
  local dir=${1:?usage: import <dir>} want="" r d b
  for r in "${REPOS[@]}"; do IFS='|' read -r d _ b <<<"$r"; [[ $d == "$dir" ]] && want=$b; done
  [[ -n $want ]] || die "import: $dir is not one of: $(printf '%s ' "${REPOS[@]%%|*}")"
  local tmp=/src/.import-$dir
  rm -rf "$tmp"; mkdir -p "$tmp"
  # Into a temporary folder first, swapped in only once the whole tar has arrived:
  # a broken transfer leaves the existing clone as it was.
  tar -C "$tmp" -xf - || { rm -rf "$tmp"; die "import: the tar did not arrive whole; /src/$dir is unchanged"; }
  [[ -d $tmp/.git ]] || { rm -rf "$tmp"; die "import: no .git in the tar (send the clone folder itself)"; }
  chown -R 0:0 "$tmp"
  rm -rf "/src/$dir"; mv "$tmp" "/src/$dir"
  log "imported $dir: $(git -C /src/$dir branch --show-current) $(git -C /src/$dir log --oneline -1)"
  [[ $(git -C /src/$dir branch --show-current) == "$want" ]] || log "WARNING: $dir is not on $want; the stack and agents use the branch it is on"
  if [[ -f /src/ase-crm/.env.example ]]; then prepare_src; fi
}

redeploy() { build; dc up -d --no-build --no-deps --force-recreate app am; status; }

# The suite's push key: an SSH deploy key that can write to that one repo and nothing else. It lives in
# pwmig-am's state volume (/data/am/deploy-key), never on the host; the entrypoint wires it on every boot.
deploy_key() {
  docker exec -i pwmig-am bash -s <<'IN'
set -euo pipefail
d=/data/am/deploy-key; mkdir -p $d; chmod 700 $d
[[ -f $d/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -C 'pwmig robot-migration deploy key' -f $d/id_ed25519
# GitHub's published ed25519 host key, pinned rather than trusted on first use.
gh='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
ssh-keyscan -t ed25519 github.com 2>/dev/null | grep -qxF "$gh" || { echo "[pwmig] ERROR: github.com's host key is not the published one" >&2; exit 1; }
echo "$gh" > $d/known_hosts
/opt/pwmig/wire-push.sh
IN
  log "public key (add it at <suite repo> > Settings > Deploy keys > Add, with \"Allow write access\"):"
  docker exec pwmig-am cat /data/am/deploy-key/id_ed25519.pub
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

# Lane 2: the second CRM stack. Its settings come from pwmig2.env, read only here (the rest stays lane 1).
dc2() {
  # In a subshell with pwmig2.env exported: this script exports pwmig.env, and compose lets the shell's
  # environment win over --env-file, which gave lane 2 lane 1's ports (pwmig2-ports could not bind).
  (set -a; source $KIT/compose/pwmig2.env; set +a
   docker compose -p pwmig2 -f /src/ase-crm/docker/docker-compose.yml -f $KIT/compose/pwmig2.override.yml \
     --env-file /src/ase-crm/.env --env-file $KIT/compose/pwmig2.env "$@")
}
l2() { (set -a; source $KIT/compose/pwmig2.env; set +a; echo "${!1}"); }
kc2() { docker exec pwmig2-keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
wait_healthy() { until [[ $(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null) == healthy ]]; do sleep 3; done; }

lane2_seed() {
  local pw=${MARIADB_ROOT_PASSWORD:-root}
  [[ -z $(docker ps -aq --filter label=com.docker.compose.project=pwmig2 --filter status=running) ]] \
    || die "lane 2 is running; lane2-seed only fills an empty, stopped lane 2"
  docker volume inspect pwmig2_mariadb-data >/dev/null 2>&1 && die "pwmig2_mariadb-data exists: lane 2 is already seeded"
  # One subdirectory per stack in the shared offset volume (pwmig2.override.yml mounts subpath ui2).
  docker run --rm --entrypoint sh -v ${P}_faketime:/f pwmig/socat:latest -c 'mkdir -p /f/ui2 && chmod 0777 /f/ui2' >/dev/null
  log "copying Keycloak's data (pwmig-keycloak stops for about a minute)"
  docker volume create pwmig2_keycloak-data >/dev/null
  docker stop pwmig-keycloak >/dev/null
  docker run --rm --entrypoint sh -v ${P}_keycloak-data:/a:ro -v pwmig2_keycloak-data:/b pwmig/socat:latest -c 'cp -a /a/. /b/' \
    || { docker start pwmig-keycloak >/dev/null; die "copying Keycloak's data failed; pwmig-keycloak restarted"; }
  docker start pwmig-keycloak >/dev/null
  log "starting pwmig2-mariadb and copying crm14_db into it"
  dc2 up -d --no-build mariadb
  wait_healthy pwmig2-mariadb
  # Through a file in pwmig2-mariadb: piped straight into mariadb the 36 MB dump failed mid-way with a
  # syntax error (2026-10-15), while the same dump imported from a file loads cleanly.
  docker exec pwmig-mariadb mariadb-dump -uroot -p"$pw" --single-transaction --routines --triggers --events \
      --databases crm14_db | docker exec -i pwmig2-mariadb sh -c 'cat > /tmp/seed.sql'
  docker exec pwmig2-mariadb sh -c "mariadb -uroot -p'$pw' < /tmp/seed.sql; rc=\$?; rm -f /tmp/seed.sql; exit \$rc"
  log "lane 2 seeded: $(docker exec pwmig2-mariadb mariadb -uroot -p"$pw" -N -e 'select count(*) from information_schema.tables where table_schema="crm14_db"') tables"
}

lane2_up() {
  local port; port=$(l2 APP_PORT)
  docker volume inspect pwmig2_mariadb-data >/dev/null 2>&1 || die "lane 2 has no data yet: run lane2-seed first"
  dc2 up -d --no-build mariadb keycloak minio cube billing
  log "waiting for lane 2's Keycloak"
  until kc2 config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null 2>&1; do sleep 3; done
  local cid; cid=$(kc2 get clients -r alepo -q clientId=crm-client --fields id --format csv --noquotes)
  kc2 update "clients/$cid" -r alepo \
    -s "redirectUris=[\"http://localhost:$port/*\",\"http://127.0.0.1:$port/*\"]" \
    -s "webOrigins=[\"http://localhost:$port\",\"http://127.0.0.1:$port\"]"
  dc2 up -d --no-build app keycloak-forward
  # pwmig2-ports lives in pwmig-am's namespace and resolves pwmig2-* names there (stackctl keeps this up later).
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' pwmig-am | grep -qw pwmig2-net \
    || docker network connect pwmig2-net pwmig-am
  dc2 up -d --no-build --force-recreate ports
  log "waiting for lane 2's app (localhost:$port inside pwmig-am)"
  until [[ $(docker exec pwmig-am curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:$port/actuator/health 2>/dev/null) == 200 ]]; do sleep 10; done
  docker ps -a --filter label=com.docker.compose.project=pwmig2 --format '  {{.Names}}\t{{.Status}}'
}


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
  import) import_src "${2:-}" ;;
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
  update) fetch; redeploy ;;
  redeploy) redeploy ;;
  deploy-key) deploy_key ;;
  lane2-seed) lane2_seed ;;
  lane2-up) lane2_up ;;
  lane2-down) dc2 down ;;
  *) sed -n '2,26p' "$0"; exit 1 ;;
esac
