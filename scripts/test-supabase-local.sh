#!/usr/bin/env bash
set -euo pipefail

export SUPABASE_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1

ROOT="$(git rev-parse --show-toplevel)"
WORKDIR="$(mktemp -d -t exped-supabase-ci-XXXXXX)"

cleanup() {
  supabase stop --workdir "$WORKDIR" --no-backup >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

supabase init --workdir "$WORKDIR" --yes

port_is_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

PORT_BASE=''
for _ in {1..50}; do
  candidate=$((40000 + (RANDOM % 2000) * 10))
  if port_is_free "$((candidate + 1))" && port_is_free "$((candidate + 2))"; then
    PORT_BASE="$candidate"
    break
  fi
done
if [[ -z "$PORT_BASE" ]]; then
  echo "Nao foi possivel reservar portas para o Supabase local." >&2
  exit 1
fi

sed -i \
  -e "s/port = 54320/port = $((PORT_BASE + 0))/" \
  -e "s/port = 54321/port = $((PORT_BASE + 1))/" \
  -e "s/port = 54322/port = $((PORT_BASE + 2))/" \
  -e "s/port = 54323/port = $((PORT_BASE + 3))/" \
  -e "s/port = 54324/port = $((PORT_BASE + 4))/" \
  -e "s/port = 54327/port = $((PORT_BASE + 7))/" \
  -e "s/port = 54329/port = $((PORT_BASE + 9))/" \
  "$WORKDIR/supabase/config.toml"

supabase start --workdir "$WORKDIR" \
  --exclude realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor

DB_URL="$(supabase status --workdir "$WORKDIR" -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')"
if [[ -z "$DB_URL" ]]; then
  echo "Nao foi possivel descobrir a URL do PostgreSQL local." >&2
  exit 1
fi

for migration in "$ROOT"/supabase/migrations/*.sql; do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

supabase test db --workdir "$WORKDIR" "$ROOT"/supabase/tests/*.sql
supabase db lint --workdir "$WORKDIR" --local --fail-on error

cd "$ROOT"
SYNC_TEST_DB_URL="$DB_URL" \
HUB_RELEASE_TEST_DATABASE_URL="$DB_URL" \
HUB_RELEASE_TEST_ALLOW_POSTGRES=1 \
  npx vitest run \
    scripts/__tests__/sync-db-concurrency.test.mjs \
    scripts/__tests__/cliente-ingest-db-concurrency.test.mjs \
    scripts/__tests__/release-hub-postgres-concurrency.test.mjs

SYNC_TEST_DB_URL="$DB_URL" \
  npx vitest run scripts/__tests__/clientes-legacy-migration-db.test.mjs
