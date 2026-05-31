#!/usr/bin/env bash
set -euo pipefail

# Aplica o prelúdio Supabase + todas as migrations num Postgres LOCAL nativo.
#
# Variáveis (com defaults pro cluster isolado deste spike):
#   PGPORT  porta do cluster        (default 54329)
#   PGHOST  host/socket dir         (default /tmp/exped-pg)
#   PGUSER  superuser do cluster    (default postgres)
#   PGDB    banco do app            (default exped)
#
# Idempotente: dropa e recria o banco do app do zero a cada execução.

PORT="${PGPORT:-54329}"
HOST="${PGHOST:-/tmp/exped-pg}"
SUSER="${PGUSER:-postgres}"
DB="${PGDB:-exped}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PSQL=(psql -p "$PORT" -h "$HOST" -U "$SUSER" -v ON_ERROR_STOP=1)

echo ">> recriando banco $DB"
psql -p "$PORT" -h "$HOST" -U "$SUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists $DB" \
  -c "create database $DB"

echo ">> prelúdio (00-prelude.sql)"
"${PSQL[@]}" -d "$DB" -f "$ROOT/scripts/local-stack/00-prelude.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo ">> $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

echo "schema aplicado."
