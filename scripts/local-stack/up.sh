#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# up.sh — sobe a pilha Supabase LOCAL nativa (Jeito A) com UM comando.
#
# IDEMPOTENTE: cada peça só sobe se a porta dela não estiver escutando. Se o
# banco `exped` já existe e tem as tabelas do app, NÃO recria (use --reset).
#
#   Postgres   54329  (data dir /tmp/exped-pg, roda como user `postgres`)
#   PostgREST  54331  (bin/postgrest + postgrest.conf)
#   GoTrue     9999   (bin/auth serve + gotrue.env)
#   Gateway    54320  (gateway.mjs — 1 URL: /auth/v1, /rest/v1, /storage/v1)
#
# Uso:
#   bash scripts/local-stack/up.sh           # sobe o que faltar (no-op se tudo de pé)
#   bash scripts/local-stack/up.sh --reset   # DROPA e recria o banco do app do zero
#
# Envs (defaults do spike):
#   PGPORT=54329  PGHOST=/tmp/exped-pg  PGUSER=postgres  PGDB=exped
#   REST_PORT=54331  AUTH_PORT=9999  GATEWAY_PORT=54320
#   GOTRUE_JWT_SECRET=exped-local-super-secret-jwt-with-at-least-32-chars
#
# Logs: /tmp/exped-postgres.log, /tmp/postgrest.log, /tmp/gotrue.log, /tmp/gateway.log
# ============================================================================

PGPORT="${PGPORT:-54329}"
PGHOST="${PGHOST:-/tmp/exped-pg}"
PGUSER="${PGUSER:-postgres}"
PGDB="${PGDB:-exped}"
REST_PORT="${REST_PORT:-54331}"
AUTH_PORT="${AUTH_PORT:-9999}"
GATEWAY_PORT="${GATEWAY_PORT:-54320}"
JWT_SECRET="${GOTRUE_JWT_SECRET:-exped-local-super-secret-jwt-with-at-least-32-chars}"

RESET=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    *) echo "arg desconhecido: $arg (use --reset)" >&2; exit 2 ;;
  esac
done

LS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$LS/../.." && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"

# Roda como o dono do data dir do Postgres. O cluster foi criado pelo user
# `postgres`; PostgREST/GoTrue/gateway rodam como o usuário atual (root).
PG_OWNER="$(stat -c '%U' "$PGHOST" 2>/dev/null || echo postgres)"
as_pg() {
  if [ "$(id -un)" = "$PG_OWNER" ]; then
    "$@"
  else
    sudo -u "$PG_OWNER" "$@"
  fi
}

# Verdadeiro se ALGUÉM está escutando na porta TCP informada.
port_up() {
  local p="$1"
  ss -ltn 2>/dev/null | grep -q ":${p}\b"
}

log()  { printf '>> %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Postgres
# ---------------------------------------------------------------------------
if port_up "$PGPORT"; then
  log "Postgres já de pé na :$PGPORT (ok)"
else
  if [ ! -s "$PGHOST/PG_VERSION" ]; then
    log "inicializando cluster Postgres em $PGHOST (initdb)"
    as_pg mkdir -p "$PGHOST"
    as_pg "$PG_BIN/initdb" -D "$PGHOST" -U "$PGUSER" --auth=trust >/tmp/exped-postgres-init.log 2>&1
  fi
  log "subindo Postgres :$PGPORT (data dir $PGHOST)"
  as_pg "$PG_BIN/pg_ctl" -D "$PGHOST" -o "-p $PGPORT -k $PGHOST -h 127.0.0.1" \
    -l /tmp/exped-postgres.log start
  # espera aceitar conexão
  for _ in $(seq 1 30); do
    if as_pg "$PG_BIN/pg_isready" -p "$PGPORT" -h "$PGHOST" -q; then break; fi
    sleep 0.3
  done
fi

PSQL=(psql -p "$PGPORT" -h "$PGHOST" -U "$PGUSER" -v ON_ERROR_STOP=1)

# ---------------------------------------------------------------------------
# 2. Schema do banco do app
# ---------------------------------------------------------------------------
db_exists() {
  "${PSQL[@]}" -d postgres -tAc \
    "select 1 from pg_database where datname='$PGDB'" 2>/dev/null | grep -q 1
}
app_tables_present() {
  "${PSQL[@]}" -d "$PGDB" -tAc \
    "select 1 from information_schema.tables where table_schema='public' and table_name='empresas'" \
    2>/dev/null | grep -q 1
}

if [ "$RESET" = "1" ]; then
  log "--reset: recriando schema do zero (apply-schema.sh dropa e recria $PGDB)"
  PGPORT="$PGPORT" PGHOST="$PGHOST" PGUSER="$PGUSER" PGDB="$PGDB" \
    bash "$LS/apply-schema.sh"
  RELOAD_PGRST=1
elif db_exists && app_tables_present; then
  log "schema já presente em $PGDB (tabela 'empresas' existe) — não recria (use --reset)"
  RELOAD_PGRST=0
else
  log "banco/schema ausente — aplicando schema (apply-schema.sh)"
  PGPORT="$PGPORT" PGHOST="$PGHOST" PGUSER="$PGUSER" PGDB="$PGDB" \
    bash "$LS/apply-schema.sh"
  RELOAD_PGRST=1
fi

# ---------------------------------------------------------------------------
# 3. PostgREST :54331
# ---------------------------------------------------------------------------
if port_up "$REST_PORT"; then
  log "PostgREST já de pé na :$REST_PORT (ok)"
  if [ "${RELOAD_PGRST:-0}" = "1" ]; then
    pid="$(pgrep -f "$LS/bin/postgrest" || true)"
    if [ -n "$pid" ]; then
      log "schema recriado — recarregando cache do PostgREST (kill -USR1 $pid)"
      kill -USR1 $pid || true
    fi
  fi
else
  log "subindo PostgREST :$REST_PORT"
  ( cd "$ROOT" && nohup "$LS/bin/postgrest" "$LS/postgrest.conf" >/tmp/postgrest.log 2>&1 & )
  for _ in $(seq 1 30); do port_up "$REST_PORT" && break; sleep 0.3; done
fi

# ---------------------------------------------------------------------------
# 4. GoTrue (auth serve) :9999
# ---------------------------------------------------------------------------
if port_up "$AUTH_PORT"; then
  log "GoTrue já de pé na :$AUTH_PORT (ok)"
else
  log "subindo GoTrue (auth serve) :$AUTH_PORT"
  ( cd "$ROOT" && set -a && source "$LS/gotrue.env" && set +a && \
    nohup "$LS/bin/auth" serve >/tmp/gotrue.log 2>&1 & )
  for _ in $(seq 1 30); do port_up "$AUTH_PORT" && break; sleep 0.3; done
fi

# ---------------------------------------------------------------------------
# 5. Gateway 1-URL :54320
# ---------------------------------------------------------------------------
if port_up "$GATEWAY_PORT"; then
  log "Gateway já de pé na :$GATEWAY_PORT (ok)"
else
  log "subindo Gateway :$GATEWAY_PORT"
  ( cd "$ROOT" && GATEWAY_PORT="$GATEWAY_PORT" \
    nohup node "$LS/gateway.mjs" >/tmp/gateway.log 2>&1 & )
  for _ in $(seq 1 30); do port_up "$GATEWAY_PORT" && break; sleep 0.3; done
fi

# ---------------------------------------------------------------------------
# Resumo + chaves pro .env.local
# ---------------------------------------------------------------------------
KEYS="$(GOTRUE_JWT_SECRET="$JWT_SECRET" bash "$LS/make-keys.sh" all)"
ANON="$(printf '%s\n' "$KEYS" | sed -n 's/^ANON_KEY=//p')"
SERVICE="$(printf '%s\n' "$KEYS" | sed -n 's/^SERVICE_ROLE_KEY=//p')"

cat <<EOF

============================================================================
  PILHA SUPABASE LOCAL (Jeito A) — DE PÉ
----------------------------------------------------------------------------
  Postgres   : 127.0.0.1:$PGPORT   (data dir $PGHOST, db $PGDB)
  PostgREST  : 127.0.0.1:$REST_PORT
  GoTrue     : 127.0.0.1:$AUTH_PORT
  Gateway    : http://127.0.0.1:$GATEWAY_PORT   <-- URL única (use no app)

  Cole isto no .env.local:

  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$GATEWAY_PORT
  NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON
  SUPABASE_SERVICE_ROLE_KEY=$SERVICE

  Logs: /tmp/exped-postgres.log /tmp/postgrest.log /tmp/gotrue.log /tmp/gateway.log
  Derrubar: bash scripts/local-stack/down.sh   (--wipe apaga o Postgres + dados)
============================================================================
EOF
