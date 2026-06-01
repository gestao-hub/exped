/**
 * Cliente de sync do hub (peça do maestro).
 *
 * Faz push (local→nuvem) e pull (nuvem→local) contra a API de sync da nuvem
 * (`/api/sync/push` e `/api/sync/pull`, auth por token de dispositivo, escopo
 * por empresa e merge campo-a-campo central). Mantém cursores por tabela no
 * banco local (`public._sync_cursors`) e aplica os resultados no banco local.
 *
 * Garantias:
 *  - Idempotência: o cursor `push_at`/`pull_at` só avança DEPOIS do lote aplicar
 *    com sucesso; reenviar o mesmo lote não duplica nem regride.
 *  - Offline-safe: se a rede cai (pullFn/pushFn lançam), o ciclo NÃO derruba nada
 *    e os cursores NÃO avançam — o próximo tick retoma de onde parou.
 *  - Atômico por tabela: cada tabela avança seu cursor isoladamente; um 403 numa
 *    tabela não trava as demais.
 *
 * O "db" é injetável (interface mínima — ver `makePsqlDb`):
 *   ensureCursorTable()
 *   getCursor(table)                 -> { pull_at, push_at }
 *   setCursor(table, { pull_at?, push_at? })
 *   selectChanged(table, cursor, limit) -> rows (updated_at > cursor, asc)
 *   upsert(table, pk, row)
 * Nos testes usamos um fake in-memory; no hub real, `makePsqlDb(cfg)` fala com o
 * Postgres local via `psql` (MESMO padrão do bootstrap.mjs).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

import { SYNC_TABLES, TWO_WAY_TABLES } from './sync-tables.mjs';

export { SYNC_TABLES, TWO_WAY_TABLES };

const execFileAsync = promisify(execFile);

export const EPOCH = '1970-01-01T00:00:00Z';
export const SYNC_LIMIT = 500;
/** Chave do cursor de auth.users (login offline) — fora do registro public. */
export const AUTH_USERS_KEY = 'auth.users';

// --------------------------------------------------------------------------
// Estado observável (pro /status do maestro).
// --------------------------------------------------------------------------
const state = {
  lastSyncOk: null, // null = ainda não rodou
  lastError: null,
  lastSyncAt: null,
  pendingPush: 0, // aproximação: linhas two-way acima do push_at no último ciclo
};

export function getState() {
  return { ...state };
}

// --------------------------------------------------------------------------
// fetch-based pull/push (default). Injetáveis nos testes como pullFn/pushFn.
// --------------------------------------------------------------------------
function makeHttpPull({ apiBase, deviceToken, fetchImpl }) {
  return async ({ cursors }) => {
    const res = await fetchImpl(`${apiBase}/api/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ cursors }),
    });
    if (!res.ok) {
      const err = new Error(`pull HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}

function makeHttpPush({ apiBase, deviceToken, fetchImpl }) {
  return async ({ rows }) => {
    const res = await fetchImpl(`${apiBase}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ rows }),
    });
    if (!res.ok) {
      const err = new Error(`push HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}

function maxUpdatedAt(rows, fallback) {
  let max = fallback;
  for (const r of rows) {
    const u = String(r.updated_at ?? '');
    if (u > max) max = u;
  }
  return max;
}

// --------------------------------------------------------------------------
// syncOnce — um ciclo completo (push depois pull). Atômico por tabela.
// --------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {object} o.db          db local (interface mínima — ver topo)
 * @param {string} o.apiBase     base da API de sync da nuvem
 * @param {string} o.deviceToken token do dispositivo (Bearer)
 * @param {Function} [o.fetchImpl] fetch (default global)
 * @param {Function} [o.pullFn]   override pra testes
 * @param {Function} [o.pushFn]   override pra testes
 * @param {object}  [o.log]       logger { info, error }
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function syncOnce({ db, apiBase, deviceToken, fetchImpl = globalThis.fetch, pullFn, pushFn, log }) {
  const logger = log || { info: () => {}, error: () => {} };
  const doPush = pushFn || makeHttpPush({ apiBase, deviceToken, fetchImpl });
  const doPull = pullFn || makeHttpPull({ apiBase, deviceToken, fetchImpl });

  await db.ensureCursorTable();

  let ok = true;
  let firstError = null;
  let pending = 0;

  // ---- PUSH (local → nuvem), uma tabela two-way por vez --------------------
  for (const t of TWO_WAY_TABLES) {
    let cursor;
    try {
      const cur = await db.getCursor(t.name);
      cursor = cur.push_at || EPOCH;
    } catch (e) {
      ok = false;
      firstError ??= e?.message || String(e);
      logger.error(`sync push getCursor ${t.name}: ${e?.message}`);
      continue;
    }

    let rows;
    try {
      rows = await db.selectChanged(t.name, cursor, SYNC_LIMIT);
    } catch (e) {
      ok = false;
      firstError ??= e?.message || String(e);
      logger.error(`sync push selectChanged ${t.name}: ${e?.message}`);
      continue;
    }

    if (!rows || rows.length === 0) continue;
    pending += rows.length;

    let result;
    try {
      result = await doPush({ rows: { [t.name]: rows } });
    } catch (e) {
      // 403 = lote rejeitado (escopo): loga e NÃO avança o cursor desta tabela,
      // mas segue pras demais (não trava o ciclo). Outros erros (rede) → offline:
      // marca o ciclo como não-ok pra re-tentar, sem derrubar nada.
      if (e?.status === 403) {
        // Rejeição de escopo é esperada/tratada (não é falha de rede): loga, NÃO
        // avança o cursor desta tabela, mas NÃO marca o ciclo como não-ok.
        logger.error(`sync push ${t.name}: 403 rejeitado (escopo) — pulando`);
      } else {
        logger.error(`sync push ${t.name}: ${e?.message}`);
        ok = false;
        firstError ??= e?.message || String(e);
      }
      continue; // cursor NÃO avança
    }

    // Aplica as canônicas retornadas (upsert local) ANTES de avançar o cursor.
    try {
      const canon = (result && result.tables && result.tables[t.name]) || [];
      for (const row of canon) {
        await db.upsert(t.name, t.pk, row);
      }
      // Avança push_at = max(updated_at) do que FOI ENVIADO (lote confirmado).
      const next = maxUpdatedAt(rows, cursor);
      await db.setCursor(t.name, { push_at: next });
    } catch (e) {
      ok = false;
      firstError ??= e?.message || String(e);
      logger.error(`sync push apply ${t.name}: ${e?.message}`);
      // cursor NÃO avança (aplicação falhou) — re-tenta no próximo tick.
    }
  }

  // ---- PULL (nuvem → local), todas as tabelas de uma vez -------------------
  let cursorsReq;
  try {
    cursorsReq = {};
    for (const t of SYNC_TABLES) {
      const cur = await db.getCursor(t.name);
      cursorsReq[t.name] = cur.pull_at || EPOCH;
    }
  } catch (e) {
    ok = false;
    firstError ??= e?.message || String(e);
    cursorsReq = null;
  }

  if (cursorsReq) {
    // Cursor próprio de auth.users (login offline) — não está no registro public.
    try {
      const cur = await db.getCursor(AUTH_USERS_KEY);
      cursorsReq[AUTH_USERS_KEY] = cur.pull_at || EPOCH;
    } catch (e) {
      ok = false;
      firstError ??= e?.message || String(e);
    }

    // Paginação (cold start + incremental): a API devolve no máx SYNC_LIMIT/tabela
    // por request. Se um lote vem cheio, ainda há mais — repete o pull avançando os
    // cursores até todos os lotes virem < SYNC_LIMIT. `tem mais` = lote cheio (===limit).
    // Guarda contra loop infinito: se o cursor não avança num lote cheio, para.
    let hasMore = true;
    let guard = 0;
    const MAX_PAGES = 10000;
    while (hasMore && cursorsReq) {
      if (++guard > MAX_PAGES) {
        ok = false;
        firstError ??= 'sync pull: muitas páginas (loop?)';
        logger.error('sync pull: excedeu MAX_PAGES — abortando paginação');
        break;
      }
      let pulled;
      try {
        pulled = await doPull({ cursors: cursorsReq });
      } catch (e) {
        // offline / erro de rede: NÃO avança nada, re-tenta depois.
        ok = false;
        firstError ??= e?.message || String(e);
        logger.error(`sync pull: ${e?.message}`);
        pulled = null;
      }
      if (!pulled) break;

      hasMore = false;

      // Tabelas public.
      if (pulled.tables) {
        for (const t of SYNC_TABLES) {
          const rows = pulled.tables[t.name];
          if (!rows || rows.length === 0) continue;
          try {
            // Upsert por PK (sobrescrita pra tabelas down — read-only no hub; merge
            // já foi resolvido na nuvem pras two-way). Linhas com deleted_at aplicam
            // soft-delete (é só um upsert da linha já marcada — estado vem da nuvem).
            for (const row of rows) {
              await db.upsert(t.name, t.pk, row);
            }
            // Avança pull_at = nextCursor da nuvem (ou max local) — só após aplicar.
            const next =
              (pulled.nextCursors && pulled.nextCursors[t.name]) ||
              maxUpdatedAt(rows, cursorsReq[t.name]);
            cursorsReq[t.name] = next;
            await db.setCursor(t.name, { pull_at: next });
            // Lote cheio → provavelmente tem mais desta tabela; pagina de novo.
            if (rows.length >= SYNC_LIMIT) hasMore = true;
          } catch (e) {
            ok = false;
            firstError ??= e?.message || String(e);
            logger.error(`sync pull apply ${t.name}: ${e?.message}`);
            // cursor desta tabela NÃO avança.
          }
        }
      }

      // auth.users (login offline): upsert em auth.users LOCAL, cursor próprio.
      const authRows = pulled.auth_users;
      if (authRows && authRows.length > 0) {
        try {
          for (const row of authRows) {
            await db.upsertAuthUser(row);
          }
          const next =
            (pulled.nextCursors && pulled.nextCursors[AUTH_USERS_KEY]) ||
            maxUpdatedAt(authRows, cursorsReq[AUTH_USERS_KEY]);
          cursorsReq[AUTH_USERS_KEY] = next;
          await db.setCursor(AUTH_USERS_KEY, { pull_at: next });
          if (authRows.length >= SYNC_LIMIT) hasMore = true;
        } catch (e) {
          ok = false;
          firstError ??= e?.message || String(e);
          logger.error(`sync pull apply auth.users: ${e?.message}`);
        }
      }
    }
  }

  state.lastSyncOk = ok;
  state.lastError = ok ? null : firstError;
  state.lastSyncAt = new Date().toISOString();
  state.pendingPush = ok ? 0 : pending;

  return { ok, error: ok ? null : firstError };
}

// --------------------------------------------------------------------------
// start — loop periódico com setInterval. Cada tick = syncOnce em try/catch
// (offline silencia + re-tenta). Retorna stop().
// --------------------------------------------------------------------------
export function start({ db, apiBase, deviceToken, fetchImpl, intervalMs = 10000, log } = {}) {
  const logger = log || { info: () => {}, error: () => {} };
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await syncOnce({ db, apiBase, deviceToken, fetchImpl, log: logger });
    } catch (e) {
      // Salvaguarda final: nunca deixa um erro derrubar o loop.
      state.lastSyncOk = false;
      state.lastError = e?.message || String(e);
      logger.error(`sync tick: ${e?.message}`);
    } finally {
      running = false;
    }
  };

  // primeiro tick imediato (não bloqueia o caller).
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

// --------------------------------------------------------------------------
// makePsqlDb — implementação real sobre o Postgres local via `psql`.
// MESMO padrão do bootstrap.mjs (execFile do psql, -tAc, ON_ERROR_STOP).
// --------------------------------------------------------------------------
// PGCLIENTENCODING=UTF8: o SQL vem do Node em UTF-8; sem isso, no Windows o psql interpreta
// os bytes pelo codepage do console (ex.: WIN1252) e corrompe acentos (vira byte UTF-8 invalido).
const PSQL_ENV = { ...process.env, PGPASSWORD: process.env.PGPASSWORD || '', PGCLIENTENCODING: 'UTF8' };

function psqlArgs(cfg) {
  return [
    '-p', String(cfg.ports.pg),
    '-h', cfg.paths.pgHost,
    '-U', cfg.paths.user || 'postgres',
    '-d', cfg.paths.db,
  ];
}

/** roda psql -tAc (uma instrução), retorna stdout trimado */
async function psqlCmd(cfg, sql) {
  const { stdout } = await execFileAsync(
    'psql',
    [...psqlArgs(cfg), '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 32 },
  );
  return stdout;
}

/**
 * roda `sql` (um único statement de escrita) DENTRO de uma transação que liga a flag
 * `exped.sync='on'` via SET LOCAL. Assim o trigger stamp_sync/set_updated_at do
 * Postgres local NÃO recarimba updated_at/field_updated_at — os carimbos aplicados são
 * exatamente os canônicos vindos da nuvem (evita churn: linha recém-baixada não vira
 * "alterada" e volta no próximo push).
 *
 * O GUC custom `exped.sync` NÃO exige superuser (mesma abordagem do RPC da nuvem, ver
 * supabase/migrations/20260601000003_sync_guc_trigger.sql). `SET LOCAL` vale só nesta
 * transação. NOTA: efeito só no psql REAL; o db fake dos testes não tem trigger, então
 * o comportamento observável (upsert por PK) é idêntico — o bypass é transparente.
 */
async function psqlSyncWrite(cfg, sql) {
  const body = `begin; set local exped.sync = 'on'; ${sql}; commit;`;
  await execFileAsync(
    'psql',
    [...psqlArgs(cfg), '-v', 'ON_ERROR_STOP=1', '-c', body],
    { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 32 },
  );
}

/** roda uma query que retorna JSON agregado (uma linha, uma coluna) e parseia. */
async function psqlJson(cfg, sql) {
  const out = (await psqlCmd(cfg, sql)).trim();
  if (!out) return null;
  return JSON.parse(out);
}

/** escapa string p/ literal SQL ('...'); usado só em nomes/timestamps controlados. */
function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * db real sobre o Postgres local. Faz upsert via INSERT ... ON CONFLICT a partir
 * de JSON (jsonb_populate_record), evitando montar SQL coluna-a-coluna.
 */
export function makePsqlDb(cfg) {
  return {
    async ensureCursorTable() {
      await psqlCmd(
        cfg,
        "create table if not exists public._sync_cursors (" +
          "table_name text primary key, " +
          "pull_at timestamptz not null default 'epoch', " +
          "push_at timestamptz not null default 'epoch')",
      );
    },

    async getCursor(table) {
      const row = await psqlJson(
        cfg,
        "select coalesce(jsonb_build_object(" +
          "'pull_at', to_char(pull_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), " +
          "'push_at', to_char(push_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'))::text, '') " +
          `from public._sync_cursors where table_name = ${sqlStr(table)}`,
      );
      if (!row) return { pull_at: EPOCH, push_at: EPOCH };
      return { pull_at: row.pull_at || EPOCH, push_at: row.push_at || EPOCH };
    },

    async setCursor(table, patch) {
      // upsert da linha do cursor, atualizando só os campos passados.
      const sets = [];
      const ins = { pull_at: EPOCH, push_at: EPOCH };
      if (patch.pull_at != null) {
        ins.pull_at = patch.pull_at;
        sets.push(`pull_at = excluded.pull_at`);
      }
      if (patch.push_at != null) {
        ins.push_at = patch.push_at;
        sets.push(`push_at = excluded.push_at`);
      }
      if (sets.length === 0) return;
      await psqlCmd(
        cfg,
        `insert into public._sync_cursors (table_name, pull_at, push_at) values (` +
          `${sqlStr(table)}, ${sqlStr(ins.pull_at)}, ${sqlStr(ins.push_at)}) ` +
          `on conflict (table_name) do update set ${sets.join(', ')}`,
      );
    },

    async selectChanged(table, cursor, limit) {
      const rows = await psqlJson(
        cfg,
        `select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at asc), '[]'::jsonb)::text ` +
          `from (select * from public.${table} ` +
          `where updated_at > ${sqlStr(cursor)} ` +
          `order by updated_at asc limit ${Number(limit)}) t`,
      );
      return rows || [];
    },

    async upsert(table, pk, row) {
      // Insert/update via jsonb_populate_record: o JSON da linha vira um record
      // do tipo da tabela; ON CONFLICT (pk) atualiza todas as colunas.
      const json = JSON.stringify(row).replace(/'/g, "''");
      // monta a lista de colunas a partir das chaves do row (todas vêm da nuvem).
      const cols = Object.keys(row).map((c) => `"${c.replace(/"/g, '""')}"`);
      const updates = cols
        .filter((c) => c !== `"${pk}"`)
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      const colList = cols.join(', ');
      const setClause = updates ? `do update set ${updates}` : 'do nothing';
      // Escrita com a flag exped.sync ligada (bypass do trigger local — ver psqlSyncWrite).
      await psqlSyncWrite(
        cfg,
        `insert into public.${table} (${colList}) ` +
          `select ${colList} from jsonb_populate_record(null::public.${table}, '${json}'::jsonb) ` +
          `on conflict ("${pk}") ${setClause}`,
      );
    },

    async upsertAuthUser(row) {
      // Upsert em auth.users LOCAL (login offline via GoTrue local). auth.users NÃO tem
      // o trigger stamp_sync (só tabelas public têm), mas usamos transação mesmo
      // (consistência + futura-prova). PK = id.
      const json = JSON.stringify(row).replace(/'/g, "''");
      const cols = Object.keys(row).map((c) => `"${c.replace(/"/g, '""')}"`);
      const updates = cols
        .filter((c) => c !== '"id"')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      const colList = cols.join(', ');
      const setClause = updates ? `do update set ${updates}` : 'do nothing';
      await psqlSyncWrite(
        cfg,
        `insert into auth.users (${colList}) ` +
          `select ${colList} from jsonb_populate_record(null::auth.users, '${json}'::jsonb) ` +
          `on conflict ("id") ${setClause}`,
      );
    },
  };
}

export default { syncOnce, start, getState, makePsqlDb, SYNC_TABLES, TWO_WAY_TABLES };
