/**
 * Lógica pura de pull/push de sync, com um "db" injetável (`SyncDb`).
 *
 * Mantida separada dos route handlers pra ser testável sem o supabase-js fluente:
 * as rotas (`app/api/sync/{pull,push}/route.ts`) constroem um `SyncDb` em cima do
 * `createAdminClient()` (service_role) e delegam aqui. A nuvem é a autoridade de
 * merge e o escopo por empresa é SEMPRE aplicado aqui (nunca confiando no payload).
 */

import {
  SYNC_TABLES,
  getSyncTable,
  hasDirectEmpresaId,
  pullCursorColumn,
  type TwoWaySyncTable,
} from './tables';

export const EPOCH = '1970-01-01T00:00:00Z';
export const PULL_LIMIT = 500;
export const PUSH_LIMIT = 500;
export const PUSH_CONCURRENCY = 8;

export type Row = Record<string, unknown>;

/**
 * Abstração mínima de acesso a dados, escopada por empresa.
 * Implementada sobre o supabase-js (rota) ou sobre um mapa em memória (testes).
 */
export type SyncDb = {
  /**
   * Linhas de `table` depois de `(updated_at, cursorPk)`, escopadas à empresa
   * (direto por `empresa_id` ou via subquery pelo pai pras filhas), ordenadas pelo
   * mesmo keyset e limitadas a `limit`. Sem `cursorPk`, preserva o contrato legado
   * `updated_at > cursor`. Inclui linhas com `deleted_at` (remoções).
   */
  selectChanges(
    table: string,
    empresaId: string,
    cursor: string,
    limit: number,
    cursorPk?: string,
  ): Promise<Row[]>;
  /** Busca a linha canônica por PK, já garantindo que pertence à empresa. */
  findCanonical(table: TwoWaySyncTable, empresaId: string, pk: unknown): Promise<Row | null>;
  /**
   * Busca a linha por PK SEM filtro de empresa (checagem global de existência).
   * Usado pra detectar colisão de PK cross-tenant antes de decidir INSERT.
   */
  findCanonicalGlobal(table: TwoWaySyncTable, pk: unknown): Promise<Row | null>;
  /** Verifica se um id de pai pertence à empresa (validação de filhas no push). */
  parentBelongsToEmpresa(parentTable: string, parentId: unknown, empresaId: string): Promise<boolean>;
  /** Canônicas por PK (em lote), escopadas à empresa. Mesmo critério do findCanonical. */
  findCanonicalMany(table: TwoWaySyncTable, empresaId: string, pks: unknown[]): Promise<Map<string, Row>>;
  /** Subconjunto de parentIds que pertencem à empresa (checagem de pais em lote). */
  parentsInEmpresa(parentTable: string, parentIds: unknown[], empresaId: string): Promise<Set<string>>;
  /**
   * Serializa por PK e executa validacao de tenant, leitura canonica, merge por
   * field_updated_at e upsert na mesma transacao. O tenant vem da autenticacao,
   * nunca do payload. Retorna null quando a PK/pai pertence a outra empresa.
   */
  mergeAndUpsert(
    table: TwoWaySyncTable,
    empresaId: string,
    row: Row,
  ): Promise<Row | null>;
  /**
   * Grava (insert/update) a linha exatamente como passada (sem trigger sobrescrever).
   * Retorna `null` quando o ON CONFLICT não afetou linha alguma (guarda de empresa no
   * RPC bloqueou um takeover cross-tenant) — o engine traduz isso em 403.
   */
  upsertRaw(table: string, row: Row): Promise<Row | null>;
  /** Liga/desliga o trigger de stamp pra escrever field_updated_at/updated_at mergeados. */
  setSyncReplica(on: boolean): Promise<void>;
  /**
   * Linhas de `auth.users` (login offline) cujos `id` estão em `profiles` da empresa
   * (`profiles.empresa_id = empresaId`), ordenadas por `(updated_at, id)` e limitadas
   * a `limit`. Escopo por empresa SEMPRE server-side. Só as colunas que o GoTrue
   * local precisa pra autenticar (id, email, encrypted_password, etc.).
   * `cursorPk` habilita desempate por `id`; ausente mantém o filtro legado.
   */
  selectAuthUsers(
    empresaId: string,
    cursor: string,
    limit: number,
    cursorPk?: string,
  ): Promise<Row[]>;
};

export type PullResult = {
  tables: Record<string, Row[]>;
  nextCursors: Record<string, string>;
  /** Linhas de auth.users escopadas à empresa (login offline). */
  auth_users: Row[];
  /** Confirma que a cloud aplicou o modo de preflight em vez de ignorar a flag. */
  identityOnly?: true;
};

export type PullOptions = {
  /** Restringe o pull a profiles + auth.users para reconciliar identidade antes do push. */
  identityOnly?: boolean;
};

/** Chave do cursor de auth.users (fora do registro de tabelas public). */
export const AUTH_USERS_KEY = 'auth.users';

/** Chave companheira compatível com o mapa legado de cursores timestamp. */
export function pullCursorPkKey(table: string): string {
  return `${table}.__pk`;
}

function lastPullCursor(
  rows: Row[],
  fallbackAt: string,
  fallbackPk: string,
  pkColumn: string,
): { at: string; pk: string } {
  const last = rows[rows.length - 1];
  if (!last) return { at: fallbackAt, pk: fallbackPk };
  return {
    at: String(last.updated_at ?? fallbackAt),
    pk: String(last[pkColumn] ?? fallbackPk),
  };
}

export async function runPull(
  db: SyncDb,
  empresaId: string,
  cursors: Record<string, string>,
  options: PullOptions = {},
): Promise<PullResult> {
  const tables: Record<string, Row[]> = {};
  const nextCursors: Record<string, string> = {};
  const pullTables = options.identityOnly
    ? SYNC_TABLES.filter((table) => table.name === 'profiles')
    : SYNC_TABLES;

  for (const t of pullTables) {
    const cursor = cursors[t.name] ?? EPOCH;
    const cursorPkKey = pullCursorPkKey(t.name);
    const hasCursorPk = Object.prototype.hasOwnProperty.call(cursors, cursorPkKey);
    const cursorPk = hasCursorPk ? cursors[cursorPkKey] : undefined;
    const rows = cursorPk === undefined
      ? await db.selectChanges(t.name, empresaId, cursor, PULL_LIMIT)
      : await db.selectChanges(t.name, empresaId, cursor, PULL_LIMIT, cursorPk);
    tables[t.name] = rows;
    const next = lastPullCursor(rows, cursor, cursorPk ?? '', pullCursorColumn(t));
    nextCursors[t.name] = next.at;
    nextCursors[cursorPkKey] = next.pk;
  }

  // auth.users (login offline): escopado por empresa via profiles, cursor próprio.
  const authCursor = cursors[AUTH_USERS_KEY] ?? EPOCH;
  const authCursorPkKey = pullCursorPkKey(AUTH_USERS_KEY);
  const hasAuthCursorPk = Object.prototype.hasOwnProperty.call(cursors, authCursorPkKey);
  const authCursorPk = hasAuthCursorPk ? cursors[authCursorPkKey] : undefined;
  const authUsers = authCursorPk === undefined
    ? await db.selectAuthUsers(empresaId, authCursor, PULL_LIMIT)
    : await db.selectAuthUsers(empresaId, authCursor, PULL_LIMIT, authCursorPk);
  const authNext = lastPullCursor(authUsers, authCursor, authCursorPk ?? '', 'id');
  nextCursors[AUTH_USERS_KEY] = authNext.at;
  nextCursors[authCursorPkKey] = authNext.pk;

  return {
    tables,
    nextCursors,
    auth_users: authUsers,
    ...(options.identityOnly ? { identityOnly: true as const } : {}),
  };
}

export type PushResult = {
  tables: Record<string, Row[]>;
};

export type BlockedRow = { table: string; pk: string };

export class PushError extends Error {
  constructor(
    public status: number,
    message: string,
    public blockedRow?: BlockedRow,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class SyncSchemaUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyncSchemaUnavailableError';
  }
}

function blockedRowFor(table: TwoWaySyncTable, row: Row): BlockedRow {
  const raw = String(row[table.pk] ?? 'desconhecida');
  const sanitized = raw.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 128);
  return { table: table.name, pk: sanitized || 'desconhecida' };
}

async function mergeRowForPush(
  db: SyncDb,
  table: TwoWaySyncTable,
  empresaId: string,
  row: Row,
): Promise<Row> {
  let saved: Row | null;
  try {
    saved = await db.mergeAndUpsert(table, empresaId, row);
  } catch (cause) {
    if (cause instanceof SyncSchemaUnavailableError) {
      throw new PushError(
        503,
        'Sincronizacao aguardando atualizacao do banco',
        blockedRowFor(table, row),
        { cause },
      );
    }
    throw new PushError(
      500,
      'Falha ao gravar linha de sync',
      blockedRowFor(table, row),
      { cause },
    );
  }

  if (saved == null) {
    throw new PushError(
      403,
      `${table.name}: PK ${String(row[table.pk])} fora do escopo`,
      blockedRowFor(table, row),
    );
  }
  return saved;
}

async function mergeRowsWithConcurrency(
  db: SyncDb,
  table: TwoWaySyncTable,
  empresaId: string,
  rows: Row[],
): Promise<Row[]> {
  const result = new Array<Row>(rows.length);
  for (let offset = 0; offset < rows.length; offset += PUSH_CONCURRENCY) {
    const wave = rows.slice(offset, offset + PUSH_CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((row) => mergeRowForPush(db, table, empresaId, row)),
    );
    const failedIndex = settled.findIndex((entry) => entry.status === 'rejected');
    if (failedIndex >= 0) {
      throw (settled[failedIndex] as PromiseRejectedResult).reason;
    }
    settled.forEach((entry, index) => {
      result[offset + index] = (entry as PromiseFulfilledResult<Row>).value;
    });
  }
  return result;
}

export async function runPush(
  db: SyncDb,
  empresaId: string,
  incoming: Record<string, Row[]>,
): Promise<PushResult> {
  // Valida shape/direção/limites ANTES de mexer no banco.
  for (const [name, rows] of Object.entries(incoming)) {
    const table = getSyncTable(name);
    if (!table) throw new PushError(422, `Tabela desconhecida: ${name}`);
    if (table.dir !== 'two-way') throw new PushError(403, `Tabela read-only (down): ${name}`);
    const pk = table.pk;
    if (rows.length > PUSH_LIMIT) throw new PushError(413, `Lote acima de ${PUSH_LIMIT} linhas: ${name}`);
    // PK duplicada no MESMO lote torna a ordem do resultado parte do contrato. O hub
    // legitimo nunca emite isso (PK unica na origem); rejeita payload forjado/buggy.
    const seenPk = new Set<string>();
    for (const r of rows) {
      const pkValue = r[pk];
      if (pkValue == null) continue;
      const k = String(pkValue);
      if (seenPk.has(k)) throw new PushError(422, `${name}: PK duplicada no lote: ${k}`);
      seenPk.add(k);
    }
  }

  const tables: Record<string, Row[]> = {};

  // Desabilita o trigger stamp_sync nesta sessão pra gravar field_updated_at/updated_at
  // EXATAMENTE como o merge calculou. Reabilita no fim (mesmo em erro).
  await db.setSyncReplica(true);
  try {
    for (const [name, rows] of Object.entries(incoming)) {
      const table = getSyncTable(name);
      if (!table) throw new PushError(422, `Tabela desconhecida: ${name}`);
      if (table.dir !== 'two-way') throw new PushError(403, `Tabela read-only (down): ${name}`);
      const scopedRows = rows.map((raw) => {
        const row: Row = { ...raw };

        // Escopo por empresa: server-side, sempre.
        if (hasDirectEmpresaId(table.name)) {
          row.empresa_id = empresaId; // força o escopo, ignora o que veio no payload.
        } else if (table.parent) {
          // A RPC revalida e trava o ancestral na mesma transacao da escrita. Aqui
          // validamos apenas o shape para devolver 422 em vez de um erro de banco.
          const parentId = row[table.parent.fk];
          if (parentId == null) {
            throw new PushError(422, `${name}.${table.parent.fk} ausente`);
          }
        }
        return row;
      });

      tables[name] = await mergeRowsWithConcurrency(
        db,
        table,
        empresaId,
        scopedRows,
      );
    }
  } finally {
    await db.setSyncReplica(false);
  }

  return { tables };
}
