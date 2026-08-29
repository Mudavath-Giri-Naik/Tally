#!/usr/bin/env bash
#
# Bring up a local stand-in for Supabase: Postgres + PostgREST, with the same
# roles a real Supabase project provisions. The integration tests run against
# this, so they exercise the real Supabase client library and real SQL rather
# than mocks.
#
#   bash scripts/start-local-stack.sh
#
# Then:  npm run test:db
#
set -euo pipefail

PG_PORT="${PG_PORT:-55432}"
PGRST_PORT="${PGRST_PORT:-54331}"
PROXY_PORT="${PROXY_PORT:-54340}"
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"

# Docker paths must not be mangled by Git Bash on Windows.
export MSYS_NO_PATHCONV=1

echo "==> Postgres on :${PG_PORT}"
docker rm -f tally-pg >/dev/null 2>&1 || true
docker run -d --name tally-pg \
  -e POSTGRES_PASSWORD=tally \
  -e POSTGRES_DB=tally \
  -p "${PG_PORT}:5432" \
  postgres:16-alpine >/dev/null

printf "    waiting"
for _ in $(seq 1 60); do
  if docker exec tally-pg pg_isready -U postgres -d tally >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  printf "."
  sleep 1
done

echo "==> Applying schema and Supabase-equivalent roles"
docker cp supabase/schema.sql tally-pg:/tmp/schema.sql
docker cp scripts/local-stack.sql tally-pg:/tmp/roles.sql
docker exec tally-pg psql -U postgres -d tally -q -v ON_ERROR_STOP=1 -f /tmp/schema.sql
docker exec tally-pg psql -U postgres -d tally -q -v ON_ERROR_STOP=1 -f /tmp/roles.sql

PG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' tally-pg)

echo "==> PostgREST on :${PGRST_PORT}"
docker rm -f tally-postgrest >/dev/null 2>&1 || true
docker run -d --name tally-postgrest \
  -p "${PGRST_PORT}:3000" \
  -e PGRST_DB_URI="postgres://authenticator:authpass@${PG_IP}:5432/tally" \
  -e PGRST_DB_SCHEMA=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="${JWT_SECRET}" \
  postgrest/postgrest:v12.2.3 >/dev/null

SERVICE_JWT=$(node -e "
const c=require('crypto');
const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const h=b({alg:'HS256',typ:'JWT'});
const n=Math.floor(Date.now()/1000);
const p=b({role:'service_role',iss:'supabase',iat:n,exp:n+31536000});
process.stdout.write(h+'.'+p+'.'+c.createHmac('sha256','${JWT_SECRET}').update(h+'.'+p).digest('base64url'));
")

cat <<EOF

Local stack is up.

  Postgres    postgres://postgres:tally@localhost:${PG_PORT}/tally
  PostgREST   http://localhost:${PGRST_PORT}

Run the database tests:

  TEST_SERVICE_JWT='${SERVICE_JWT}' npm run test:db

To point the app at this stack, put these in .env.local and run the proxy
(supabase-js expects PostgREST under /rest/v1, a bare PostgREST serves at /):

  node scripts/postgrest-proxy.mjs ${PROXY_PORT} ${PGRST_PORT}

  SUPABASE_URL=http://127.0.0.1:${PROXY_PORT}
  SUPABASE_SERVICE_ROLE_KEY=${SERVICE_JWT}
  SUPABASE_DB_URL=postgres://postgres:tally@localhost:${PG_PORT}/tally

Tear down:

  docker rm -f tally-pg tally-postgrest
EOF
