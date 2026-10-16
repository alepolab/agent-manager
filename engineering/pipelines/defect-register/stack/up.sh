#!/usr/bin/env bash
# Brings up the defect-register ase-crm stack on this host, from zero.
# Ports: app 18081, Keycloak 19091, MariaDB 13307, billing 18107, S3 19000.
set -euo pipefail
D=/home/alepo/defect-stack
DEV_USER=${DEV_USER:-am-vivekojha-alepo}
cd "$D"
P="docker compose -p defect-register -f src/docker/docker-compose.yml -f docker-compose.dr.yml --env-file src/.env"

echo "== source $(cat COMMIT)"
if [ ! -f src/.built-$(cat COMMIT) ]; then
  rm -rf src && mkdir src && tar -xzf ase-crm-develop.tar.gz -C src && touch src/.built-$(cat COMMIT)
fi

echo "== clock (shared with $DEV_USER, who runs the tests)"
mkdir -p clock; [ -s clock/ts ] || echo '+0 s x1' > clock/ts
setfacl -m "u:$DEV_USER:x" /home/alepo "$D"
setfacl -m "u:$DEV_USER:rwx" clock; setfacl -m "u:$DEV_USER:rw" clock/ts

echo "== env"
if [ ! -f src/.env ]; then
  cp src/.env.example src/.env
  set_env() { if grep -q "^$1=" src/.env; then sed -i "s#^$1=.*#$1=$2#" src/.env; else echo "$1=$2" >> src/.env; fi; }
  set_env APP_PORT 18081; set_env MARIADB_PORT 13307; set_env BILLING_PORT 18107; set_env MINIO_API_PORT 19000
  set_env CUBE_API_SECRET "$(openssl rand -hex 24)"
  set_env KEYCLOAK_ISSUER_URI http://localhost:19091/realms/alepo
  set_env KEYCLOAK_JWK_SET_URI http://dr-keycloak:8080/realms/alepo/protocol/openid-connect/certs
  set_env NOTIFICATION_RABBITMQ_ENABLED false
fi

echo "== build app (develop $(cat COMMIT))"
GIT_COMMIT=$(cat COMMIT) $P build app

echo "== database, object store, analytics"
$P up -d mariadb minio cube
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' dr-mariadb)" = healthy ] && break; sleep 3; done

echo "== Keycloak on 19091"
if ! docker ps --format '{{.Names}}' | grep -qx dr-keycloak; then
  docker rm -f dr-keycloak >/dev/null 2>&1 || true
  docker run -d --name dr-keycloak --restart unless-stopped --network dr-net -p 19091:8080 \
    -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin -e KC_HOSTNAME_STRICT=false \
    -v "$D/src/keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro" \
    quay.io/keycloak/keycloak:26.0 start-dev --import-realm >/dev/null
fi
until [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' http://localhost:19091/realms/alepo)" = 200 ]; do sleep 3; done
KC=$(curl -s -X POST http://localhost:19091/realms/master/protocol/openid-connect/token \
  -d client_id=admin-cli -d username=admin -d password=admin -d grant_type=password | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
CID=$(curl -s -H "Authorization: Bearer $KC" "http://localhost:19091/admin/realms/alepo/clients?clientId=crm-api" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
SEC=$(curl -s -H "Authorization: Bearer $KC" "http://localhost:19091/admin/realms/alepo/clients/$CID/client-secret" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("value") or "")')
[ -n "$SEC" ] || SEC=$(curl -s -X POST -H "Authorization: Bearer $KC" "http://localhost:19091/admin/realms/alepo/clients/$CID/client-secret" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("value") or "")')
sed -i "s#^KEYCLOAK_ADMIN_CLIENT_SECRET=.*#KEYCLOAK_ADMIN_CLIENT_SECRET=$SEC#" src/.env
echo "  crm-api secret written to src/.env (not printed)"

echo "== app and billing"
$P up -d app billing
for i in $(seq 1 100); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:18081/v3/api-docs)" = 200 ] && break; sleep 5; done

echo "== Keycloak admin, from inside the app"
# KeycloakAdminService derives the admin URL from the issuer, localhost:19091,
# which inside dr-app is the container itself: every login sync failed with
# "Keycloak could not be reached". A forwarder in the app's network namespace
# answers there. Recreated with the app, whose namespace it joins.
docker rm -f dr-keycloak-forward >/dev/null 2>&1 || true
docker run -d --name dr-keycloak-forward --restart unless-stopped --network container:dr-app \
  alpine/socat TCP-LISTEN:19091,fork,reuseaddr TCP:dr-keycloak:8080 >/dev/null
sleep 2
printf '  admin API from dr-app (401 without a token is right): %s\n' \
  "$(docker run --rm --network container:dr-app curlimages/curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:19091/admin/realms/alepo/users)"

echo "== status"
for u in http://localhost:18081/v3/api-docs http://localhost:18081/ http://localhost:19091/realms/alepo http://localhost:18107/; do
  printf '  %-40s %s\n' "$u" "$(curl -s -m5 -o /dev/null -w '%{http_code}' "$u")"
done
$P ps --format '  {{.Name}}\t{{.Status}}'
docker ps --filter name=dr-keycloak --format '  {{.Names}}\t{{.Status}}'
