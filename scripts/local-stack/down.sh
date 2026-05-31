#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# down.sh — derruba a pilha Supabase LOCAL nativa (Jeito A).
#
# Mata SÓ os processos desta pilha (casa por porta + linha de comando), nunca
# processos não relacionados. Por padrão NÃO toca no Postgres nem nos dados.
#
# Uso:
#   bash scripts/local-stack/down.sh           # para gateway, GoTrue, PostgREST
#   bash scripts/local-stack/down.sh --wipe     # + para Postgres E apaga /tmp/exped-pg
#
# Envs (defaults do spike):
#   PGPORT=54329  PGHOST=/tmp/exped-pg  REST_PORT=54331  AUTH_PORT=9999  GATEWAY_PORT=54320
# ============================================================================

PGPORT="${PGPORT:-54329}"
PGHOST="${PGHOST:-/tmp/exped-pg}"
REST_PORT="${REST_PORT:-54331}"
AUTH_PORT="${AUTH_PORT:-9999}"
GATEWAY_PORT="${GATEWAY_PORT:-54320}"

WIPE=0
for arg in "$@"; do
  case "$arg" in
    --wipe) WIPE=1 ;;
    *) echo "arg desconhecido: $arg (use --wipe)" >&2; exit 2 ;;
  esac
done

LS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_BIN="/usr/lib/postgresql/16/bin"
log() { printf '>> %s\n' "$*"; }

# Mata processo cujo comando casa com o pattern. Não usa porta sozinha pra
# evitar matar algo alheio que reaproveitou a porta.
kill_by_pattern() {
  local name="$1" pattern="$2"
  local pids
  pids="$(pgrep -f "$pattern" || true)"
  if [ -n "$pids" ]; then
    log "parando $name (pids: $pids)"
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids="$(pgrep -f "$pattern" || true)"
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  else
    log "$name não estava rodando"
  fi
}

# Gateway -> GoTrue -> PostgREST (ordem inversa do up)
kill_by_pattern "Gateway"   "gateway\.mjs"
kill_by_pattern "GoTrue"    "$LS/bin/auth"
kill_by_pattern "PostgREST" "$LS/bin/postgrest"

if [ "$WIPE" = "1" ]; then
  PG_OWNER="$(stat -c '%U' "$PGHOST" 2>/dev/null || echo postgres)"
  as_pg() {
    if [ "$(id -un)" = "$PG_OWNER" ]; then "$@"; else sudo -u "$PG_OWNER" "$@"; fi
  }
  if [ -s "$PGHOST/PG_VERSION" ]; then
    log "--wipe: parando Postgres :$PGPORT (pg_ctl stop)"
    as_pg "$PG_BIN/pg_ctl" -D "$PGHOST" -m fast stop || true
    sleep 1
    # fallback: garante que ninguém ficou no data dir
    pkill -f "postgres -D $PGHOST" 2>/dev/null || true
    log "--wipe: apagando data dir $PGHOST"
    as_pg rm -rf "$PGHOST"
  else
    log "--wipe: nenhum cluster Postgres em $PGHOST"
  fi
else
  log "Postgres mantido de pé (use --wipe para parar e apagar os dados)"
fi

log "pilha derrubada."
