/**
 * Cliente de sync do hub (peça do maestro).
 *
 * Faz push (local→nuvem) e pull (nuvem→local) contra a API de sync da nuvem
 * (`/api/sync/push` e `/api/sync/pull`, auth por token de dispositivo, escopo
 * por empresa e merge campo-a-campo central). Mantém cursores por tabela no
 * banco local (`public._sync_cursors`) e aplica os resultados no banco local.
 *
 * Garantias:
 *  - Idempotência: os cursores `push_at`/`push_pk` e `pull_at`/`pull_pk` só
 *    avançam DEPOIS do lote aplicar com sucesso; reenvio não duplica nem regride.
 *  - Offline-safe: se a rede cai (pullFn/pushFn lançam), o ciclo NÃO derruba nada
 *    e os cursores NÃO avançam — o próximo tick retoma de onde parou.
 *  - Atômico por tabela: cada tabela avança seu cursor isoladamente; um 403 numa
 *    tabela não trava as demais.
 *
 * O "db" é injetável (interface mínima — ver `makePsqlDb`):
 *   ensureCursorTable()
 *   getCursor(table)                 -> { pull_at, pull_pk, push_at, push_pk }
 *   setCursor(table, { pull_at?, pull_pk?, push_at?, push_pk? })
 *   selectChanged(table, pk, { at, pk }, limit) -> rows (tuple-keyset, asc)
 *   countChanged(table, pk, { at, pk }) -> exact remaining row count
 *   upsert(table, pk, row)
 *   applyCanonicalPage(table, pk, rows, cursor) -> upserts + cursor atômicos
 *   applyPulledPage(table, pk, rows, cursor)    -> pull + cursor atômicos
 * Nos testes usamos um fake in-memory; no hub real, `makePsqlDb(cfg)` fala com o
 * Postgres local via `psql` (MESMO padrão do bootstrap.mjs).
 */

import { execFile } from 'node:child_process';
import { open, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

import {
  IDENTITY_REFERENCES,
  applyAuthUserWithIdentity,
  normalizeIdentityEmail,
  reconcilePendingIdentityAliases,
} from './identity-reconciliation.mjs';
import {
  createSyncState,
  finishAttempt,
  sanitizeSyncError,
  startAttempt,
} from './sync-state.mjs';
import { SYNC_TABLES, TWO_WAY_TABLES } from './sync-tables.mjs';

export { SYNC_TABLES, TWO_WAY_TABLES };

const execFileAsync = promisify(execFile);

// Cursor inicial ANTES de qualquer dado real. Não pode ser '1970-01-01' (epoch):
// linhas pré-migração ficam com updated_at = epoch e, com o filtro estritamente
// maior (`> cursor`), seriam excluídas do 1º pull pra sempre. '0001-01-01' garante
// que toda linha (inclusive as carimbadas em epoch) entre na sincronização inicial.
export const EPOCH = '0001-01-01T00:00:00Z';
export const SYNC_LIMIT = 500;
export const MAX_PUSH_PAGES_PER_CYCLE = 10;
export const PUSH_BUDGET_MS = 45_000;
/** Chave do cursor de auth.users (login offline) — fora do registro public. */
export const AUTH_USERS_KEY = 'auth.users';

/** Chave companheira que mantém o timestamp legado e adiciona desempate por PK. */
export function pullCursorPkKey(table) {
  return `${table}.__pk`;
}

// --------------------------------------------------------------------------
// Estado observável (pro /status do maestro).
// --------------------------------------------------------------------------
const state = createSyncState(TWO_WAY_TABLES.map((table) => table.name));
let activeSync = null;
const nextPushTableByDb = new WeakMap();

export function getState() {
  return {
    ...state,
    pendingByTable: { ...state.pendingByTable },
    lastBlockedRow: state.lastBlockedRow ? { ...state.lastBlockedRow } : null,
  };
}

// --------------------------------------------------------------------------
// fetch-based pull/push (default). Injetáveis nos testes como pullFn/pushFn.
// --------------------------------------------------------------------------
function makeHttpPull({ apiBase, deviceToken, fetchImpl }) {
  return async ({ cursors, identityOnly = false }) => {
    const res = await fetchImpl(`${apiBase}/api/sync/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({
        cursors,
        ...(identityOnly ? { identityOnly: true } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = new Error(`pull HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
}

export function makeHttpPush({ apiBase, deviceToken, fetchImpl }) {
  return async ({ rows }) => {
    const res = await fetchImpl(`${apiBase}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ rows }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const err = new Error(`push HTTP ${res.status}`);
      err.status = res.status;
      const retryAfter = res.headers?.get?.('retry-after');
      if (typeof retryAfter === 'string' && retryAfter.trim()) {
        const trimmed = retryAfter.trim();
        const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
        const absolute = seconds == null ? Date.parse(trimmed) : null;
        const retryAfterMs = seconds == null
          ? absolute - Date.now()
          : seconds * 1_000;
        if (
          Number.isSafeInteger(retryAfterMs) &&
          retryAfterMs > 0 &&
          retryAfterMs <= 15 * 60_000
        ) {
          err.retryAfterMs = retryAfterMs;
        }
      }
      const blocked = body?.blockedRow;
      const tableAllowed =
        typeof blocked?.table === 'string' &&
        TWO_WAY_TABLES.some((table) => table.name === blocked.table);
      const pkAllowed =
        typeof blocked?.pk === 'string' &&
        blocked.pk.length > 0 &&
        blocked.pk.length <= 128 &&
        /^[a-zA-Z0-9_.:/-]+$/.test(blocked.pk);
      if (tableAllowed && pkAllowed) {
        err.blockedRow = { table: blocked.table, pk: blocked.pk };
      }
      throw err;
    }
    return res.json();
  };
}

function lastPullAt(rows, fallbackAt) {
  const last = rows[rows.length - 1];
  return last ? String(last.updated_at ?? fallbackAt) : fallbackAt;
}

function nextPullCursor(nextCursors, table, rows, currentAt) {
  const fallbackAt = lastPullAt(rows, currentAt);
  const suppliedAt = nextCursors?.[table];
  const suppliedPk = nextCursors?.[pullCursorPkKey(table)];
  const at = typeof suppliedAt === 'string' && suppliedAt ? suppliedAt : fallbackAt;
  // Cloud legado nao garante ordenacao dentro do mesmo timestamp. So uma PK
  // devolvida explicitamente pelo contrato keyset pode ser persistida com seguranca.
  const cursorPk = typeof suppliedPk === 'string' ? suppliedPk : '';
  return { at, pk: cursorPk };
}

async function readPullCursors(db) {
  const cursors = {};
  for (const table of SYNC_TABLES) {
    const current = await db.getCursor(table.name);
    cursors[table.name] = current.pull_at || EPOCH;
    cursors[pullCursorPkKey(table.name)] =
      typeof current.pull_pk === 'string' ? current.pull_pk : '';
  }
  const authCurrent = await db.getCursor(AUTH_USERS_KEY);
  cursors[AUTH_USERS_KEY] = authCurrent.pull_at || EPOCH;
  cursors[pullCursorPkKey(AUTH_USERS_KEY)] =
    typeof authCurrent.pull_pk === 'string' ? authCurrent.pull_pk : '';
  return cursors;
}

function withoutIdentityRows(pulled) {
  const tables = { ...(pulled?.tables || {}) };
  delete tables.profiles;
  const nextCursors = { ...(pulled?.nextCursors || {}) };
  delete nextCursors.profiles;
  delete nextCursors[pullCursorPkKey('profiles')];
  delete nextCursors[AUTH_USERS_KEY];
  delete nextCursors[pullCursorPkKey(AUTH_USERS_KEY)];
  return {
    ...pulled,
    tables,
    auth_users: [],
    nextCursors,
  };
}

async function applyIdentityPullPage({ db, pulled, cursors }) {
  const authRows = Array.isArray(pulled?.auth_users) ? pulled.auth_users : [];
  if (authRows.length > 0) {
    const authPkKey = pullCursorPkKey(AUTH_USERS_KEY);
    const next = nextPullCursor(
      pulled.nextCursors,
      AUTH_USERS_KEY,
      authRows,
      cursors[AUTH_USERS_KEY],
    );
    assertCursorStrictlyAdvances(
      { at: cursors[AUTH_USERS_KEY], pk: cursors[authPkKey] },
      next,
      'sync identity preflight auth.users',
    );
    for (const row of authRows) await applyAuthUserWithIdentity(db, row);
    await db.setCursor(AUTH_USERS_KEY, { pull_at: next.at, pull_pk: next.pk });
    cursors[AUTH_USERS_KEY] = next.at;
    cursors[authPkKey] = next.pk;
  }

  const profileRows = Array.isArray(pulled?.tables?.profiles)
    ? pulled.tables.profiles
    : [];
  if (profileRows.length > 0) {
    const profilePkKey = pullCursorPkKey('profiles');
    const next = nextPullCursor(
      pulled.nextCursors,
      'profiles',
      profileRows,
      cursors.profiles,
    );
    assertCursorStrictlyAdvances(
      { at: cursors.profiles, pk: cursors[profilePkKey] },
      next,
      'sync identity preflight profiles',
    );
    for (const row of profileRows) {
      await db.upsert('profiles', 'id', row);
      await db.markCanonicalProfileApplied(row.id);
    }
    await db.setCursor('profiles', { pull_at: next.at, pull_pk: next.pk });
    cursors.profiles = next.at;
    cursors[profilePkKey] = next.pk;
  }

  return {
    hasMore: authRows.length >= SYNC_LIMIT || profileRows.length >= SYNC_LIMIT,
    authRows: authRows.length,
    profileRows: profileRows.length,
  };
}

async function runIdentityPreflight({ db, doPull }) {
  const cursors = await readPullCursors(db);
  let deferredLegacyPull = null;
  let guard = 0;

  while (true) {
    if (++guard > 10000) throw new Error('sync identity preflight: muitas páginas');
    const pulled = await doPull({ cursors, identityOnly: true });
    if (!pulled || typeof pulled !== 'object') {
      throw new Error('sync identity preflight: resposta inválida');
    }
    if (pulled.identityOnly !== true && deferredLegacyPull === null) {
      deferredLegacyPull = withoutIdentityRows(pulled);
    }

    const page = await applyIdentityPullPage({ db, pulled, cursors });
    if (!page.hasMore) break;
  }

  let identity = await reconcilePendingIdentityAliases(db);
  if (identity.pending > 0) {
    await recoverPendingCanonicalProfiles({ db, doPull });
    identity = await reconcilePendingIdentityAliases(db);
  }
  if (identity.pending > 0) {
    throw new Error(`sync identity preflight: ${identity.pending} pendência(s)`);
  }
  return { deferredLegacyPull };
}

async function recoverPendingCanonicalProfiles({ db, doPull }) {
  const aliases = await db.listPendingIdentityAliases();
  const pendingIds = new Set(
    aliases
      .filter((alias) => !alias.resolved_at && alias.canonical_user_id != null)
      .map((alias) => String(alias.canonical_user_id)),
  );
  if (pendingIds.size === 0) return;

  // Cursores legados podiam avançar sobre um profile que falhou. Reabre apenas
  // profiles em cursores temporários; o cursor persistido continua monotônico.
  const cursors = await readPullCursors(db);
  const profilePkKey = pullCursorPkKey('profiles');
  cursors.profiles = EPOCH;
  cursors[profilePkKey] = '';
  let guard = 0;

  while (pendingIds.size > 0) {
    if (++guard > 10000) {
      throw new Error('sync identity recovery: muitas páginas');
    }
    const pulled = await doPull({ cursors, identityOnly: true });
    if (!pulled || typeof pulled !== 'object') {
      throw new Error('sync identity recovery: resposta inválida');
    }
    const profileRows = pulled?.tables?.profiles;
    if (profileRows != null && !Array.isArray(profileRows)) {
      throw new Error('sync identity recovery: profiles inválido');
    }
    const rows = Array.isArray(profileRows) ? profileRows : [];
    const current = { at: cursors.profiles, pk: cursors[profilePkKey] };
    const next = rows.length >= SYNC_LIMIT
      ? validateRecoveryPageCursor({
          rows,
          current,
          nextCursors: pulled.nextCursors,
          table: 'profiles',
          pk: 'id',
        })
      : null;

    for (const row of rows) {
      const id = row?.id == null ? '' : String(row.id);
      if (!pendingIds.has(id)) continue;
      await db.upsert('profiles', 'id', row);
      await db.markCanonicalProfileApplied(row.id);
      pendingIds.delete(id);
    }
    if (pendingIds.size === 0 || rows.length < SYNC_LIMIT) return;

    cursors.profiles = next.at;
    cursors[profilePkKey] = next.pk;
  }
}

function safeBlockedRow(table, supplied) {
  const suppliedIsSafe =
    supplied?.table === table.name &&
    typeof supplied.pk === 'string' &&
    supplied.pk.length > 0 &&
    supplied.pk.length <= 128 &&
    /^[a-zA-Z0-9_.:/-]+$/.test(supplied.pk);
  return suppliedIsSafe ? { table: table.name, pk: supplied.pk } : null;
}

function assertKeysetDb(db) {
  if (
    typeof db?.selectChanged !== 'function' ||
    typeof db?.countChanged !== 'function'
  ) {
    throw new Error('sync db keyset contract required');
  }
  if (typeof db?.applyCanonicalPage !== 'function') {
    throw new Error('sync db atomic page contract required');
  }
}

const KEYSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const ORDERED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function timestampMicros(value) {
  if (typeof value !== 'string') return null;
  const match = ORDERED_TIMESTAMP.exec(value);
  if (!match) return null;
  const [
    , yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = '', zone, offsetSign, offsetHourText = '0', offsetMinuteText = '0',
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText);
  const offsetMinute = Number(offsetMinuteText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth[month] ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    return null;
  }

  const micros = fraction.padEnd(6, '0');
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, Number(micros.slice(0, 3)));
  let milliseconds = instant.getTime();
  if (zone !== 'Z') {
    const offset = (offsetHour * 60 + offsetMinute) * 60_000;
    milliseconds += offsetSign === '+' ? -offset : offset;
  }
  if (!Number.isFinite(milliseconds)) return null;
  return BigInt(milliseconds) * 1000n + BigInt(Number(micros.slice(3, 6)));
}

function assertCursorStrictlyAdvances(current, next, context) {
  const currentAt = timestampMicros(current?.at);
  const nextAt = timestampMicros(next?.at);
  const currentPk = current?.pk;
  const nextPk = next?.pk;
  const advances =
    currentAt != null &&
    nextAt != null &&
    typeof currentPk === 'string' &&
    typeof nextPk === 'string' &&
    (nextAt > currentAt || (nextAt === currentAt && nextPk > currentPk));
  if (!advances) throw new Error(`${context}: cursor não avançou estritamente`);
}

function rowCursor(row, pk, context) {
  const rawPk = row?.[pk];
  const cursor = {
    at: row?.updated_at,
    pk: rawPk == null ? '' : String(rawPk),
  };
  if (timestampMicros(cursor.at) == null || !cursor.pk) {
    throw new Error(`${context}: linha sem cursor válido`);
  }
  return cursor;
}

function validateRecoveryPageCursor({ rows, current, nextCursors, table, pk }) {
  const context = 'sync identity recovery';
  const cursorPkKey = pullCursorPkKey(table);
  const hasCompleteCursor =
    nextCursors &&
    typeof nextCursors === 'object' &&
    Object.prototype.hasOwnProperty.call(nextCursors, table) &&
    Object.prototype.hasOwnProperty.call(nextCursors, cursorPkKey) &&
    typeof nextCursors[table] === 'string' &&
    nextCursors[table].length > 0 &&
    typeof nextCursors[cursorPkKey] === 'string' &&
    nextCursors[cursorPkKey].length > 0;
  if (!hasCompleteCursor) {
    throw new Error(`${context}: cursor completo obrigatório`);
  }

  let previous = current;
  for (const row of rows) {
    const candidate = rowCursor(row, pk, context);
    assertCursorStrictlyAdvances(previous, candidate, context);
    previous = candidate;
  }

  const supplied = {
    at: nextCursors[table],
    pk: nextCursors[cursorPkKey],
  };
  const suppliedAt = timestampMicros(supplied.at);
  const lastAt = timestampMicros(previous.at);
  if (suppliedAt == null || suppliedAt !== lastAt || supplied.pk !== previous.pk) {
    throw new Error(`${context}: cursor divergente da última linha`);
  }
  assertCursorStrictlyAdvances(current, supplied, context);
  return supplied;
}

function validKeysetTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = KEYSET_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const milliseconds = Number(fraction.slice(0, 3).padEnd(3, '0'));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second) &&
    parsed.getUTCMilliseconds() === milliseconds
  );
}

function keysetCursor(current) {
  const hasPushAt = Object.prototype.hasOwnProperty.call(current || {}, 'push_at');
  const hasPushPk = Object.prototype.hasOwnProperty.call(current || {}, 'push_pk');
  const pushAtValid =
    hasPushAt &&
    validKeysetTimestamp(current.push_at);
  const pushPkValid = hasPushPk && typeof current.push_pk === 'string';
  if (!pushAtValid || !pushPkValid) {
    throw new Error('sync db keyset cursor required');
  }
  return { at: current.push_at, pk: current.push_pk };
}

function exactPendingCount(table, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`sync db countChanged invalid for ${table}`);
  }
  return value;
}

function pushTablesForCycle(db) {
  const start = nextPushTableByDb.get(db) || 0;
  nextPushTableByDb.set(db, (start + 1) % TWO_WAY_TABLES.length);
  return TWO_WAY_TABLES.map(
    (_, offset) => TWO_WAY_TABLES[(start + offset) % TWO_WAY_TABLES.length],
  );
}

function pushRowKey(table, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`sync push confirmação inválida para ${table.name}`);
  }
  const columns = Array.isArray(table.pk) ? table.pk : [table.pk];
  const values = columns.map((column) => {
    const value = row[column];
    if (value == null) {
      throw new Error(`sync push confirmação inválida para ${table.name}`);
    }
    return String(value);
  });
  return JSON.stringify(values);
}

function normalizedClienteDocument(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.length === 11 || digits.length === 14 ? digits : '';
}

function validatePushConfirmation(table, rows, result) {
  const tables = result?.tables;
  const hasTable =
    tables &&
    typeof tables === 'object' &&
    !Array.isArray(tables) &&
    Object.prototype.hasOwnProperty.call(tables, table.name);
  const canonical = hasTable ? tables[table.name] : null;
  if (!Array.isArray(canonical) || canonical.length !== rows.length) {
    throw new Error(`sync push confirmação inválida para ${table.name}`);
  }

  const expectedRows = new Map(rows.map((row) => [pushRowKey(table, row), row]));
  const canonicalKeys = canonical.map((row) => pushRowKey(table, row));
  if (
    expectedRows.size !== rows.length ||
    (table.name !== 'clientes' && new Set(canonicalKeys).size !== canonical.length)
  ) {
    throw new Error(`sync push confirmação inválida para ${table.name}`);
  }
  const matched = new Set();
  const aliases = [];
  const canonicalRows = new Map();
  for (let index = 0; index < canonical.length; index += 1) {
    const row = canonical[index];
    const canonicalKey = canonicalKeys[index];
    let expected = expectedRows.get(canonicalKey);
    if (expected && matched.has(expected)) expected = null;
    if (!expected && table.name === 'clientes') {
      const canonicalDocument = normalizedClienteDocument(row.cnpj_cpf);
      const candidates = rows.filter((candidate) => (
        !matched.has(candidate) &&
        canonicalDocument !== '' &&
        normalizedClienteDocument(candidate.cnpj_cpf) === canonicalDocument &&
        String(candidate.empresa_id ?? '') === String(row.empresa_id ?? '')
      ));
      if (candidates.length === 0) {
        throw new Error(`sync push confirmação inválida para ${table.name}`);
      }
      [expected] = candidates;
    }
    if (!expected || matched.has(expected)) {
      throw new Error(`sync push confirmação inválida para ${table.name}`);
    }
    matched.add(expected);
    const complete =
      timestampMicros(row.updated_at) != null &&
      Object.keys(expected).every((column) => (
        Object.prototype.hasOwnProperty.call(row, column)
      ));
    if (!complete) {
      throw new Error(`sync push confirmação inválida para ${table.name}`);
    }
    if (table.name === 'clientes' && String(expected.id) !== String(row.id)) {
      aliases.push({
        oldId: String(expected.id),
        canonicalId: String(row.id),
        empresaId: String(row.empresa_id),
        sourceUpdatedAt: String(expected.updated_at),
      });
    }

    const previous = canonicalRows.get(canonicalKey);
    if (
      !previous ||
      timestampMicros(row.updated_at) > timestampMicros(previous.updated_at)
    ) {
      canonicalRows.set(canonicalKey, row);
    }
  }
  if (matched.size !== rows.length) {
    throw new Error(`sync push confirmação inválida para ${table.name}`);
  }
  return { rows: [...canonicalRows.values()], aliases };
}

async function pushTablePages({ db, table, doPush, budget, nowFn }) {
  while (budget.pages < budget.maxPages && nowFn() <= budget.deadline) {
    let rows;
    try {
      const current = await db.getCursor(table.name);
      const cursor = keysetCursor(current);
      rows = await db.selectChanged(table.name, table.pk, cursor, SYNC_LIMIT);
    } catch (error) {
      return { ok: false, error, blockedRow: null };
    }

    if (!rows?.length) return { ok: true, error: null, blockedRow: null };

    let result;
    try {
      result = await doPush({ rows: { [table.name]: rows } });
    } catch (error) {
      return {
        ok: false,
        error,
        blockedRow: safeBlockedRow(table, error?.blockedRow),
      };
    }

    try {
      const confirmation = validatePushConfirmation(table, rows, result);
      const last = rows[rows.length - 1];
      await db.applyCanonicalPage(
        table.name,
        table.pk,
        confirmation.rows,
        {
          push_at: String(last.updated_at),
          push_pk: String(last[table.pk]),
        },
        confirmation.aliases,
      );
    } catch (error) {
      return {
        ok: false,
        error,
        blockedRow: null,
      };
    }

    budget.pages += 1;
    if (rows.length < SYNC_LIMIT) return { ok: true, error: null, blockedRow: null };
  }

  return { ok: true, error: null, blockedRow: null };
}

// --------------------------------------------------------------------------
// syncOnce — um ciclo completo (push depois pull). Atômico por tabela.
// --------------------------------------------------------------------------
async function runSyncOnce({
  db,
  apiBase,
  deviceToken,
  fetchImpl = globalThis.fetch,
  pullFn,
  pushFn,
  log,
  maxPushPages = MAX_PUSH_PAGES_PER_CYCLE,
  pushBudgetMs = PUSH_BUDGET_MS,
  nowFn = Date.now,
}) {
  const logger = log || { info: () => {}, error: () => {} };
  const doPush = pushFn || makeHttpPush({ apiBase, deviceToken, fetchImpl });
  const doPull = pullFn || makeHttpPull({ apiBase, deviceToken, fetchImpl });
  let ok = true;
  let firstError = null;
  let retryAfterMs = 0;
  let lastBlockedRow = null;

  startAttempt(state, new Date().toISOString());
  try {
    await db.ensureCursorTable();
  } catch (error) {
    finishAttempt(state, {
      ok: false,
      error: error?.message || String(error),
      pendingByTable: state.pendingByTable,
      backlogCounted: false,
      lastSkipped: 0,
      lastBlockedRow: null,
      at: new Date().toISOString(),
    });
    return { ok: false, error: error?.message || String(error) };
  }
  assertKeysetDb(db);

  let pushAllowed = true;
  let deferredLegacyPull = null;
  let identityPreflightSucceeded = false;
  try {
    const preflight = await runIdentityPreflight({ db, doPull });
    deferredLegacyPull = preflight.deferredLegacyPull;
    identityPreflightSucceeded = true;
  } catch (error) {
    pushAllowed = false;
    ok = false;
    firstError ??= error?.message || String(error);
    logger.error(`sync identity preflight: ${error?.message}`);
  }

  const budget = {
    pages: 0,
    maxPages: maxPushPages,
    deadline: nowFn() + pushBudgetMs,
  };

  if (pushAllowed) {
    for (const table of pushTablesForCycle(db)) {
      const pushed = await pushTablePages({ db, table, doPush, budget, nowFn });
      if (!pushed.ok) {
        ok = false;
        firstError ??= pushed.error?.message || String(pushed.error);
        if (Number.isSafeInteger(pushed.error?.retryAfterMs)) {
          retryAfterMs = Math.max(retryAfterMs, pushed.error.retryAfterMs);
        }
        lastBlockedRow ??= pushed.blockedRow;
        logger.error(`sync push ${table.name}: ${pushed.error?.message || pushed.error}`);
      }
    }
  }

  state.phase = 'pulling';

  // ---- PULL (nuvem → local), todas as tabelas de uma vez -------------------
  let cursorsReq;
  try {
    cursorsReq = await readPullCursors(db);
  } catch (e) {
    ok = false;
    firstError ??= e?.message || String(e);
    cursorsReq = null;
  }

  if (cursorsReq) {
    // Paginação (cold start + incremental): a API devolve no máx SYNC_LIMIT/tabela
    // por request. Se um lote vem cheio, ainda há mais — repete o pull avançando os
    // cursores até todos os lotes virem < SYNC_LIMIT. `tem mais` = lote cheio (===limit).
    // Guarda contra loop infinito: se o cursor não avança num lote cheio, para.
    let hasMore = true;
    let guard = 0;
    const MAX_PAGES = 10000;
    const failedPullTables = new Set();
    while (hasMore && cursorsReq) {
      if (++guard > MAX_PAGES) {
        ok = false;
        firstError ??= 'sync pull: muitas páginas (loop?)';
        logger.error('sync pull: excedeu MAX_PAGES — abortando paginação');
        break;
      }
      let pulled;
      try {
        if (deferredLegacyPull) {
          pulled = deferredLegacyPull;
          deferredLegacyPull = null;
        } else {
          pulled = await doPull({ cursors: cursorsReq });
        }
      } catch (e) {
        // offline / erro de rede: NÃO avança nada, re-tenta depois.
        ok = false;
        firstError ??= e?.message || String(e);
        logger.error(`sync pull: ${e?.message}`);
        pulled = null;
      }
      if (!pulled) break;

      hasMore = false;

      // auth.users PRIMEIRO: profiles.id faz FK para auth.users, então os usuários
      // precisam existir antes de qualquer tabela public que referencie profiles.
      const authRows = pulled.auth_users;
      if (authRows && authRows.length > 0) {
        try {
          for (const row of authRows) {
            await applyAuthUserWithIdentity(db, row);
          }
          const cursorPkKey = pullCursorPkKey(AUTH_USERS_KEY);
          const next = nextPullCursor(
            pulled.nextCursors,
            AUTH_USERS_KEY,
            authRows,
            cursorsReq[AUTH_USERS_KEY],
          );
          cursorsReq[AUTH_USERS_KEY] = next.at;
          cursorsReq[cursorPkKey] = next.pk;
          await db.setCursor(AUTH_USERS_KEY, { pull_at: next.at, pull_pk: next.pk });
          if (authRows.length >= SYNC_LIMIT) hasMore = true;
        } catch (e) {
          ok = false;
          firstError ??= e?.message || String(e);
          logger.error(`sync pull apply auth.users: ${e?.message}`);
        }
      }

      // Tabelas public (SYNC_TABLES já ordenadas: down antes de two-way).
      if (pulled.tables) {
        for (const t of SYNC_TABLES) {
          if (failedPullTables.has(t.name)) continue;
          const rows = pulled.tables[t.name];
          if (!rows || rows.length === 0) continue;
          const cursorPkKey = pullCursorPkKey(t.name);
          const next = nextPullCursor(
            pulled.nextCursors,
            t.name,
            rows,
            cursorsReq[t.name],
          );

          let batchApplied = false;
          if (TWO_WAY_NAMES.has(t.name) && typeof db.applyPulledPage === 'function') {
            try {
              await db.applyPulledPage(t.name, t.pk, rows, {
                pull_at: next.at,
                pull_pk: next.pk,
              });
              batchApplied = true;
            } catch {
              logger.info(`sync pull batch ${t.name}: fallback linha a linha`);
            }
          }

          // Resiliência: aplica LINHA-A-LINHA. Uma linha que falha (ex.: FK de uma
          // linha-pai ainda não aplicada, ou dado inesperado) é LOGADA com a PK e
          // PULADA quando a página atômica não está disponível ou falha inteira.
          let skipped = 0;
          let tableError = null;
          if (!batchApplied) {
            for (const row of rows) {
              try {
                // Upsert por PK (sobrescrita pra tabelas down — read-only no hub; merge
                // já foi resolvido na nuvem pras two-way). Linhas com deleted_at aplicam
                // soft-delete (é só um upsert da linha já marcada — estado vem da nuvem).
                await db.upsert(t.name, t.pk, row);
                if (t.name === 'profiles') {
                  await db.markCanonicalProfileApplied(row.id);
                }
              } catch (e) {
                skipped++;
                tableError ??= e;
                const pk = Array.isArray(t.pk) ? t.pk.map((k) => row[k]).join('/') : row[t.pk];
                logger.error(`sync pull apply ${t.name} pk=${pk}: ${e?.message} — linha pulada`);
              }
            }
          }
          if (skipped > 0) {
            state.lastSkipped = (state.lastSkipped || 0) + skipped;
            failedPullTables.add(t.name);
            ok = false;
            firstError ??= tableError?.message || String(tableError);
            continue;
          }
          try {
            // A página só é confirmada quando todas as linhas da tabela aplicaram.
            // No caminho em lote, dados e cursor já foram gravados na mesma transação.
            cursorsReq[t.name] = next.at;
            cursorsReq[cursorPkKey] = next.pk;
            if (!batchApplied) {
              await db.setCursor(t.name, { pull_at: next.at, pull_pk: next.pk });
            }
            // Lote cheio → provavelmente tem mais desta tabela; pagina de novo.
            if (rows.length >= SYNC_LIMIT) hasMore = true;
          } catch (e) {
            failedPullTables.add(t.name);
            ok = false;
            firstError ??= e?.message || String(e);
            logger.error(`sync pull cursor ${t.name}: ${e?.message}`);
          }
        }
      }

      if (
        identityPreflightSucceeded &&
        typeof db.listPendingIdentityAliases === 'function'
      ) {
        try {
          await reconcilePendingIdentityAliases(db);
        } catch (error) {
          ok = false;
          firstError ??= error?.message || String(error);
          logger.error(`sync identity: ${error?.message}`);
        }
      }
    }
  }

  let backlogCounted = true;
  let pendingByTable = {};
  try {
    for (const table of TWO_WAY_TABLES) {
      const current = await db.getCursor(table.name);
      const cursor = keysetCursor(current);
      pendingByTable[table.name] = exactPendingCount(
        table.name,
        await db.countChanged(table.name, table.pk, cursor),
      );
    }
  } catch (error) {
    backlogCounted = false;
    pendingByTable = { ...state.pendingByTable };
    ok = false;
    firstError ??= error?.message || String(error);
  }

  finishAttempt(state, {
    ok,
    error: firstError,
    pendingByTable,
    backlogCounted,
    lastSkipped: state.lastSkipped,
    lastBlockedRow,
    retryAfterMs,
    at: new Date().toISOString(),
  });

  return { ok, error: ok ? null : firstError };
}

/**
 * Runs at most one mutable sync cycle at a time. Concurrent callers join the
 * active cycle, so an older completion cannot race newer state or cursor writes.
 */
export function syncOnce(options) {
  if (activeSync) return activeSync;

  const cycle = runSyncOnce(options).catch((error) => {
    const message = error?.message || String(error);
    finishAttempt(state, {
      ok: false,
      error: message,
      pendingByTable: state.pendingByTable,
      backlogCounted: false,
      lastSkipped: state.lastSkipped,
      lastBlockedRow: state.lastBlockedRow,
      retryAfterMs: Number.isSafeInteger(error?.retryAfterMs) ? error.retryAfterMs : 0,
      at: new Date().toISOString(),
    });
    return { ok: false, error: message };
  });
  activeSync = cycle;
  cycle.then(() => {
    if (activeSync === cycle) activeSync = null;
  });
  return cycle;
}

// --------------------------------------------------------------------------
// start — loop periódico com setInterval. Cada tick = syncOnce em try/catch
// (offline silencia + re-tenta). Retorna stop().
//
// WATCHDOG (incidente 2026-06-10): um ciclo acima de `stuckMs` é reportado uma
// vez, mas continua sendo o único ciclo ativo. O timeout de cada operação psql
// é responsável por destravar I/O; iniciar trabalho mutável concorrente faria
// uma conclusão antiga poder regredir estado e cursores.
// --------------------------------------------------------------------------
export function start({
  db, apiBase, deviceToken, fetchImpl,
  intervalMs = 10000, stuckMs = 120000, log, syncOnceFn = syncOnce,
} = {}) {
  const logger = log || { info: () => {}, error: () => {} };
  let runningSince = null; // null = nenhum ciclo em andamento
  let stallReported = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const now = Date.now();
    const retryAfterUntil = Date.parse(state.retryAfterUntil || '');
    if (Number.isFinite(retryAfterUntil) && now < retryAfterUntil) return;
    if (runningSince !== null) {
      if (!stallReported && now - runningSince >= stuckMs) {
        stallReported = true;
        logger.error(`sync: ciclo travado ha ${now - runningSince}ms (watchdog)`);
      }
      return;
    }

    runningSince = now;
    state.runningSince = new Date(now).toISOString();
    stallReported = false;
    try {
      await syncOnceFn({ db, apiBase, deviceToken, fetchImpl, log: logger });
    } catch (e) {
      // Salvaguarda final: nunca deixa um erro derrubar o loop.
      const safeError = sanitizeSyncError(e?.message || String(e));
      state.lastSyncOk = false;
      state.lastError = safeError;
      state.lastSyncAt = new Date().toISOString();
      state.caughtUp = false;
      state.phase = 'error';
      state.consecutiveFailures += 1;
      logger.error(`sync tick: ${safeError}`);
    } finally {
      runningSince = null;
      state.runningSince = null;
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
// PGTZ=UTC: mantem timestamptz canonico entre Postgres local e nuvem, evitando eco de sync.
const PSQL_ENV = {
  ...process.env,
  PGPASSWORD: process.env.PGPASSWORD || '',
  PGCLIENTENCODING: 'UTF8',
  PGTZ: 'UTC',
};

// Tempo-limite de CADA chamada ao psql. Sem isso, um psql que pendura (lock, conexão
// presa, Postgres lento) faz o execFile nunca retornar → syncOnce nunca termina →
// o tick fica preso com o ciclo "em andamento" pra sempre e o sync CONGELA (foi a
// causa-raiz do congelamento de 2026-06-10). Estourado o tempo, o execFile mata o
// processo e rejeita → o ciclo falha e re-tenta no próximo tick (offline-safe).
const PSQL_TIMEOUT_MS = 30000;

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
    { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 256, timeout: PSQL_TIMEOUT_MS, killSignal: 'SIGKILL' },
  );
  return stdout;
}

/** Executa um script UTF-8 por arquivo temporário privado. */
async function psqlScript(cfg, body) {
  // Escreve em arquivo temp UTF-8 e usa -f: elimina interferência de codepage
  // do Windows quando caracteres não-ASCII são passados via argumento -c.
  // O SQL pode conter dados sensíveis (ex.: encrypted_password de auth.users), então:
  // nome aleatório imprevisível (randomBytes, não Math.random) + permissão 0600 +
  // 'wx' (falha se já existir — evita race/symlink em arquivo previsível).
  const tmpFile = join(tmpdir(), `exped-sync-${randomBytes(12).toString('hex')}.sql`);
  let fh;
  try {
    fh = await open(tmpFile, 'wx', 0o600);
    await fh.writeFile(body, 'utf8');
    await fh.close();
    fh = undefined;
    await execFileAsync(
      'psql',
      [...psqlArgs(cfg), '-v', 'ON_ERROR_STOP=1', '-f', tmpFile],
      { env: PSQL_ENV, maxBuffer: 1024 * 1024 * 256, timeout: PSQL_TIMEOUT_MS, killSignal: 'SIGKILL' },
    );
  } finally {
    if (fh) await fh.close().catch(() => {});
    await unlink(tmpFile).catch(() => {});
  }
}

/**
 * Executa uma escrita com o bypass do trigger local, preservando os carimbos
 * canônicos recebidos da nuvem e evitando churn no próximo push.
 */
async function psqlSyncWrite(cfg, sql) {
  return psqlScript(cfg, `begin; set local exped.sync = 'on'; ${sql}; commit;`);
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

const AUTH_GENERATED_COLS = new Set(['confirmed_at']);
const AUTH_TOKEN_COLS = new Set([
  'confirmation_token', 'recovery_token', 'email_change_token_new',
  'email_change', 'email_change_token_current', 'phone_change',
  'phone_change_token', 'reauthentication_token',
]);

// FK de auditoria para auth.users. Não pertence às seis referências de sync
// para profiles e, portanto, é tratada explicitamente antes do cleanup de auth.
const IDENTITY_AUDIT_REFERENCE = Object.freeze({
  table: 'provisioning_codes',
  column: 'created_by',
});

function authUserForLocal(row) {
  const filtered = Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !AUTH_GENERATED_COLS.has(key))
      .map(([key, value]) => [key, AUTH_TOKEN_COLS.has(key) && value == null ? '' : value]),
  );
  for (const column of AUTH_TOKEN_COLS) {
    if (filtered[column] == null) filtered[column] = '';
  }
  if (!filtered.id) throw new Error('auth.users sem id');
  return filtered;
}

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

const TWO_WAY_NAMES = new Set(TWO_WAY_TABLES.map((table) => table.name));

function assertTwoWaySource(table, pk) {
  if (!TWO_WAY_NAMES.has(table)) {
    throw new Error(`tabela de push não permitida: ${table}`);
  }
  const registered = TWO_WAY_TABLES.find((entry) => entry.name === table);
  if (!registered || registered.pk !== pk) {
    throw new Error(`PK de push inválida: ${table}`);
  }
}

function cursorUpsertStatement(table, patch) {
  const sets = [];
  const ins = { pull_at: EPOCH, pull_pk: '', push_at: EPOCH, push_pk: '' };
  if (patch.pull_at != null) {
    ins.pull_at = patch.pull_at;
    sets.push('pull_at = excluded.pull_at');
  }
  if (patch.pull_pk != null) {
    ins.pull_pk = patch.pull_pk;
    sets.push('pull_pk = excluded.pull_pk');
  }
  if (patch.push_at != null) {
    ins.push_at = patch.push_at;
    sets.push('push_at = excluded.push_at');
  }
  if (patch.push_pk != null) {
    ins.push_pk = patch.push_pk;
    sets.push('push_pk = excluded.push_pk');
  }
  if (sets.length === 0) return null;
  return (
    `insert into public._sync_cursors (table_name, pull_at, pull_pk, push_at, push_pk) values (` +
    `${sqlStr(table)}, ${sqlStr(ins.pull_at)}, ${sqlStr(ins.pull_pk)}, ` +
    `${sqlStr(ins.push_at)}, ${sqlStr(ins.push_pk)}) ` +
    `on conflict (table_name) do update set ${sets.join(', ')}`
  );
}

function rowUpsertStatement(table, pk, row) {
  const json = JSON.stringify(row).replace(/'/g, "''");
  const cols = Object.keys(row).map((column) => quoteIdent(column));
  const pkCols = (Array.isArray(pk) ? pk : [pk]).map((column) => quoteIdent(column));
  const pkSet = new Set(pkCols);
  const updates = cols
    .filter((column) => !pkSet.has(column))
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const colList = cols.join(', ');
  const setClause = updates ? `do update set ${updates}` : 'do nothing';
  return (
    `insert into public.${table} (${colList}) ` +
    `select ${colList} from jsonb_populate_record(null::public.${table}, '${json}'::jsonb) ` +
    `on conflict (${pkCols.join(', ')}) ${setClause}`
  );
}

function identityAdvisoryLockStatement(normalizedEmail) {
  return `select pg_advisory_xact_lock(hashtext(${sqlStr(`exped.identity:${normalizedEmail}`)}));`;
}

function authUserUpsertStatement(row) {
  const filtered = authUserForLocal(row);
  const columns = Object.keys(filtered).map(quoteIdent);
  const updates = columns
    .filter((column) => column !== '"id"')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  const columnList = columns.join(', ');
  const conflict = updates ? `do update set ${updates}` : 'do nothing';
  return (
    `insert into auth.users (${columnList}) ` +
    `select ${columnList} from jsonb_populate_record(` +
    `null::auth.users, ${sqlStr(JSON.stringify(filtered))}::jsonb) ` +
    `on conflict ("id") ${conflict}`
  );
}

/**
 * db real sobre o Postgres local. Faz upsert via INSERT ... ON CONFLICT a partir
 * de JSON (jsonb_populate_record), evitando montar SQL coluna-a-coluna.
 */
export function makePsqlDb(cfg) {
  return {
    async ensureCursorTable() {
      await psqlScript(cfg, [
        'begin;',
        "create table if not exists public._sync_cursors (" +
          "table_name text primary key, " +
          "pull_at timestamptz not null default '0001-01-01T00:00:00Z', " +
          "pull_pk text not null default '', " +
          "push_at timestamptz not null default '0001-01-01T00:00:00Z', " +
          "push_pk text not null default '');",
        "alter table public._sync_cursors " +
          "add column if not exists pull_pk text not null default '';",
        "alter table public._sync_cursors " +
          "add column if not exists push_pk text not null default '';",
        'create schema if not exists exped_internal;',
        'revoke all on schema exped_internal from public, anon, authenticated;',
        'create table if not exists exped_internal.identity_aliases (',
        '  old_user_id uuid primary key,',
        '  canonical_user_id uuid not null,',
        '  normalized_email text not null,',
        '  created_at timestamptz not null default now(),',
        '  resolved_at timestamptz,',
        '  last_error text',
        ');',
        'alter table exped_internal.identity_aliases add column if not exists ' +
          'canonical_profile_applied_at timestamptz;',
        'revoke all on exped_internal.identity_aliases from public, anon, authenticated;',
        'commit;',
      ].join('\n'));
    },

    async getCursor(table) {
      const row = await psqlJson(
        cfg,
        "select coalesce(jsonb_build_object(" +
          // AT TIME ZONE 'UTC': formata em UTC antes do "Z". Sem isso, to_char usa o
          // timezone da sessão (ex.: UTC-3) mas rotula "Z" → cursor 3h errado.
          "'pull_at', to_char(pull_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), " +
          "'pull_pk', pull_pk, " +
          "'push_at', to_char(push_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), " +
          "'push_pk', push_pk)::text, '') " +
          `from public._sync_cursors where table_name = ${sqlStr(table)}`,
      );
      if (!row) return { pull_at: EPOCH, pull_pk: '', push_at: EPOCH, push_pk: '' };
      return {
        pull_at: row.pull_at || EPOCH,
        pull_pk: row.pull_pk || '',
        push_at: row.push_at || EPOCH,
        push_pk: row.push_pk || '',
      };
    },

    async setCursor(table, patch) {
      const statement = cursorUpsertStatement(table, patch);
      if (statement) await psqlCmd(cfg, statement);
    },

    async selectChanged(table, pk, cursor, limit) {
      assertTwoWaySource(table, pk);
      const tableIdent = quoteIdent(table);
      const pkIdent = quoteIdent(pk);
      const rows = await psqlJson(
        cfg,
        `select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at, t.${pkIdent}::text), ` +
          `'[]'::jsonb)::text from (` +
          `select * from public.${tableIdent} where (updated_at, ${pkIdent}::text) > (` +
          `${sqlStr(cursor.at)}::timestamptz, ${sqlStr(cursor.pk)}::text) ` +
          `order by updated_at asc, ${pkIdent}::text asc limit ${Number(limit)}) t`,
      );
      return rows || [];
    },

    async countChanged(table, pk, cursor) {
      assertTwoWaySource(table, pk);
      const out = await psqlCmd(
        cfg,
        `select count(*) from public.${quoteIdent(table)} where (updated_at, ` +
          `${quoteIdent(pk)}::text) > (${sqlStr(cursor.at)}::timestamptz, ` +
          `${sqlStr(cursor.pk)}::text)`,
      );
      return Number(out.trim());
    },

    async upsert(table, pk, row) {
      // Escrita com a flag exped.sync ligada (bypass do trigger local — ver psqlSyncWrite).
      await psqlSyncWrite(cfg, rowUpsertStatement(table, pk, row));
    },

    async applyCanonicalPage(table, pk, rows, cursor, aliases = []) {
      assertTwoWaySource(table, pk);
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        timestampMicros(cursor?.push_at) == null ||
        typeof cursor?.push_pk !== 'string'
      ) {
        throw new Error(`página canônica inválida: ${table}`);
      }
      const cursorStatement = cursorUpsertStatement(table, cursor);
      const aliasTombstones = aliases.flatMap((alias) => {
        if (table !== 'clientes' || alias.oldId === alias.canonicalId) return [];
        const oldId = sqlStr(alias.oldId);
        const empresaId = sqlStr(alias.empresaId);
        const sourceUpdatedAt = sqlStr(alias.sourceUpdatedAt);
        return [
          `update public.clientes set deleted_at = coalesce(deleted_at, ${sourceUpdatedAt}::timestamptz), ` +
            `field_updated_at = jsonb_set(coalesce(field_updated_at, '{}'::jsonb), ` +
            `'{deleted_at}', to_jsonb(${sourceUpdatedAt}::timestamptz), true) ` +
            `where id = ${oldId}::uuid and empresa_id = ${empresaId}::uuid`,
        ];
      });
      const aliasRepoints = aliases.flatMap((alias) => {
        if (table !== 'clientes' || alias.oldId === alias.canonicalId) return [];
        const oldId = sqlStr(alias.oldId);
        const canonicalId = sqlStr(alias.canonicalId);
        const empresaId = sqlStr(alias.empresaId);
        return [
          `update public.pedidos set cliente_id = ${canonicalId}::uuid ` +
            `where cliente_id = ${oldId}::uuid and empresa_id = ${empresaId}::uuid`,
          `update public.ordens_servico set cliente_id = ${canonicalId}::uuid ` +
            `where cliente_id = ${oldId}::uuid and empresa_id = ${empresaId}::uuid`,
          `update public.cliente_enderecos endereco set is_padrao = false ` +
            `where endereco.cliente_id = ${oldId}::uuid and endereco.empresa_id = ${empresaId}::uuid ` +
            `and endereco.is_padrao = true and exists (` +
            `select 1 from public.cliente_enderecos canonico ` +
            `where canonico.cliente_id = ${canonicalId}::uuid and canonico.is_padrao = true)`,
          `update public.cliente_enderecos set cliente_id = ${canonicalId}::uuid ` +
            `where cliente_id = ${oldId}::uuid and empresa_id = ${empresaId}::uuid`,
        ];
      });
      const aliasLocks = aliases.length > 0
        ? [`select id from public.clientes where id in (${[...new Set(
          aliases.flatMap((alias) => [alias.oldId, alias.canonicalId]),
        )].map((id) => `${sqlStr(id)}::uuid`).join(', ')}) order by id for update`]
        : [];
      const statements = [
        ...aliasLocks,
        ...aliasTombstones,
        ...rows.map((row) => rowUpsertStatement(table, pk, row)),
        ...aliasRepoints,
        cursorStatement,
      ];
      await psqlSyncWrite(cfg, statements.join(';\n'));
    },

    async applyPulledPage(table, pk, rows, cursor) {
      assertTwoWaySource(table, pk);
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        timestampMicros(cursor?.pull_at) == null ||
        typeof cursor?.pull_pk !== 'string'
      ) {
        throw new Error(`pagina de pull invalida: ${table}`);
      }
      const cursorStatement = cursorUpsertStatement(table, cursor);
      const statements = [
        ...rows.map((row) => rowUpsertStatement(table, pk, row)),
        cursorStatement,
      ];
      await psqlSyncWrite(cfg, statements.join(';\n'));
    },

    async findAuthUserByNormalizedEmail(normalizedEmail) {
      return psqlJson(
        cfg,
        `select coalesce((select jsonb_build_object('id', id, 'email', email)::text ` +
          `from auth.users where lower(btrim(email)) = ${sqlStr(normalizedEmail)} ` +
          `order by id limit 1), '')`,
      );
    },

    async upsertAuthUserById(row) {
      await psqlScript(cfg, `begin; ${authUserUpsertStatement(row)}; commit;`);
    },

    async aliasAndUpsertAuthUser({
      oldUserId, canonicalUser, normalizedEmail, aliasEmail,
    }) {
      const canonicalId = String(canonicalUser.id);
      await psqlScript(cfg, [
        'begin;',
        identityAdvisoryLockStatement(normalizedEmail),
        `insert into exped_internal.identity_aliases as current_alias ` +
          `(old_user_id, canonical_user_id, normalized_email, ` +
          `canonical_profile_applied_at, resolved_at, last_error) values (` +
          `${sqlStr(oldUserId)}::uuid, ${sqlStr(canonicalId)}::uuid, ` +
          `${sqlStr(normalizedEmail)}, null, null, null) ` +
          `on conflict (old_user_id) do update set ` +
          `canonical_user_id = excluded.canonical_user_id, ` +
          `normalized_email = excluded.normalized_email, ` +
          `canonical_profile_applied_at = case ` +
          `when current_alias.canonical_user_id = excluded.canonical_user_id ` +
          `then current_alias.canonical_profile_applied_at else null end, ` +
          `resolved_at = case ` +
          `when current_alias.canonical_user_id = excluded.canonical_user_id ` +
          `then current_alias.resolved_at else null end, ` +
          `last_error = case ` +
          `when current_alias.canonical_user_id = excluded.canonical_user_id ` +
          `then current_alias.last_error else null end;`,
        `update auth.users set email = ${sqlStr(aliasEmail)}, updated_at = now() ` +
          `where id = ${sqlStr(oldUserId)}::uuid and id <> ${sqlStr(canonicalId)}::uuid;`,
        `${authUserUpsertStatement(canonicalUser)};`,
        'commit;',
      ].join('\n'));
    },

    async markCanonicalProfileApplied(userId) {
      await psqlCmd(
        cfg,
        `update exped_internal.identity_aliases set canonical_profile_applied_at = ` +
          `coalesce(canonical_profile_applied_at, now()) ` +
          `where canonical_user_id = ${sqlStr(userId)}::uuid and resolved_at is null`,
      );
    },

    async listPendingIdentityAliases() {
      return (await psqlJson(
        cfg,
        `select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at), '[]'::jsonb)::text ` +
          `from exped_internal.identity_aliases a where resolved_at is null`,
      )) || [];
    },

    async profileExists(userId) {
      return (await psqlCmd(
        cfg,
        `select exists(select 1 from public.profiles where id = ${sqlStr(userId)}::uuid)`,
      )).trim() === 't';
    },

    async repointIdentityAlias(alias) {
      const oldId = sqlStr(String(alias.old_user_id));
      const canonicalId = sqlStr(String(alias.canonical_user_id));
      const normalizedEmail = normalizeIdentityEmail(alias.normalized_email);
      if (!normalizedEmail) throw new Error('identity alias sem e-mail normalizado');
      const propagating = IDENTITY_REFERENCES
        .filter((ref) => ref.propagate)
        .map((ref) =>
          `update public.${quoteIdent(ref.table)} set ${quoteIdent(ref.column)} = ${canonicalId}::uuid ` +
          `where ${quoteIdent(ref.column)} = ${oldId}::uuid;`,
        );
      const internal = IDENTITY_REFERENCES
        .filter((ref) => !ref.propagate)
        .map((ref) =>
          `update public.${quoteIdent(ref.table)} set ${quoteIdent(ref.column)} = ${canonicalId}::uuid ` +
          `where ${quoteIdent(ref.column)} = ${oldId}::uuid;`,
        );
      const auditCleanup =
        `update public.${quoteIdent(IDENTITY_AUDIT_REFERENCE.table)} ` +
        `set ${quoteIdent(IDENTITY_AUDIT_REFERENCE.column)} = ${canonicalId}::uuid ` +
        `where ${quoteIdent(IDENTITY_AUDIT_REFERENCE.column)} = ${oldId}::uuid;`;

      await psqlScript(cfg, [
        'begin;',
        identityAdvisoryLockStatement(normalizedEmail),
        `do $exped$ begin ` +
          `perform 1 from exped_internal.identity_aliases ` +
          `where old_user_id = ${oldId}::uuid ` +
          `and canonical_user_id = ${canonicalId}::uuid ` +
          `and normalized_email = ${sqlStr(normalizedEmail)} ` +
          `and canonical_profile_applied_at is not null and resolved_at is null for update; ` +
          `if not found then raise exception 'identity alias is not eligible'; end if; ` +
          `perform p.id from public.profiles p ` +
          `where p.id in (${oldId}::uuid, ${canonicalId}::uuid) ` +
          `order by p.id for update; ` +
          `if not exists (select 1 from public.profiles where id = ${oldId}::uuid) ` +
          `then raise exception 'old profile is missing'; end if; ` +
          `if not exists (select 1 from public.profiles where id = ${canonicalId}::uuid) ` +
          `then raise exception 'canonical profile is missing'; end if; ` +
          `end $exped$;`,
        ...propagating,
        `set local exped.sync = 'on';`,
        ...internal,
        auditCleanup,
        `delete from public.profiles where id = ${oldId}::uuid;`,
        `delete from auth.users where id = ${oldId}::uuid;`,
        `update exped_internal.identity_aliases set resolved_at = now(), last_error = null ` +
          `where old_user_id = ${oldId}::uuid;`,
        'commit;',
      ].join('\n'));
    },

    async markIdentityAliasError(oldUserId, message) {
      await psqlCmd(
        cfg,
        `update exped_internal.identity_aliases set last_error = ` +
          `${sqlStr(String(message).slice(0, 500))} ` +
          `where old_user_id = ${sqlStr(oldUserId)}::uuid`,
      );
    },
  };
}

export default { syncOnce, start, getState, makePsqlDb, SYNC_TABLES, TWO_WAY_TABLES };
