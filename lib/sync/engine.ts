/**
 * Lógica pura de pull/push de sync, com um "db" injetável (`SyncDb`).
 *
 * Mantida separada dos route handlers pra ser testável sem o supabase-js fluente:
 * as rotas (`app/api/sync/{pull,push}/route.ts`) constroem um `SyncDb` em cima do
 * `createAdminClient()` (service_role) e delegam aqui. A nuvem é a autoridade de
 * merge e o escopo por empresa é SEMPRE aplicado aqui (nunca confiando no payload).
 */

import { mergeRow, type SyncRow } from './merge';
import { SYNC_TABLES, hasDirectEmpresaId, type SyncTable } from './tables';

export const EPOCH = '1970-01-01T00:00:00Z';
export const PULL_LIMIT = 500;
export const PUSH_LIMIT = 500;

export type Row = Record<string, unknown>;

/**
 * Abstração mínima de acesso a dados, escopada por empresa.
 * Implementada sobre o supabase-js (rota) ou sobre um mapa em memória (testes).
 */
export type SyncDb = {
  /**
   * Linhas de `table` cuja `updated_at > cursor`, escopadas à empresa (direto por
   * `empresa_id` ou via subquery pelo pai pras filhas), ordenadas por `updated_at`
   * asc, limitadas a `limit`. Inclui linhas com `deleted_at` (remoções).
   */
  selectChanges(table: string, empresaId: string, cursor: string, limit: number): Promise<Row[]>;
  /** Busca a linha canônica por PK, já garantindo que pertence à empresa. */
  findCanonical(table: SyncTable, empresaId: string, pk: unknown): Promise<Row | null>;
  /** Verifica se um id de pai pertence à empresa (validação de filhas no push). */
  parentBelongsToEmpresa(parentTable: string, parentId: unknown, empresaId: string): Promise<boolean>;
  /** Grava (insert/update) a linha exatamente como passada (sem trigger sobrescrever). */
  upsertRaw(table: string, row: Row): Promise<Row>;
  /** Liga/desliga o trigger de stamp pra escrever field_updated_at/updated_at mergeados. */
  setSyncReplica(on: boolean): Promise<void>;
};

export type PullResult = {
  tables: Record<string, Row[]>;
  nextCursors: Record<string, string>;
};

export async function runPull(
  db: SyncDb,
  empresaId: string,
  cursors: Record<string, string>,
): Promise<PullResult> {
  const tables: Record<string, Row[]> = {};
  const nextCursors: Record<string, string> = {};

  for (const t of SYNC_TABLES) {
    const cursor = cursors[t.name] ?? EPOCH;
    const rows = await db.selectChanges(t.name, empresaId, cursor, PULL_LIMIT);
    tables[t.name] = rows;
    // nextCursor = maior updated_at do lote (ou mantém o cursor atual se vazio).
    let max = cursor;
    for (const r of rows) {
      const u = String(r.updated_at ?? '');
      if (u > max) max = u;
    }
    nextCursors[t.name] = max;
  }

  return { tables, nextCursors };
}

export type PushResult = {
  tables: Record<string, Row[]>;
};

export class PushError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function maxTimestamp(fua: Record<string, string> | undefined): string {
  if (!fua) return EPOCH;
  let max = EPOCH;
  for (const v of Object.values(fua)) {
    if (typeof v === 'string' && v > max) max = v;
  }
  return max;
}

export async function runPush(
  db: SyncDb,
  empresaId: string,
  incoming: Record<string, Row[]>,
): Promise<PushResult> {
  // Valida shape/direção/limites ANTES de mexer no banco.
  for (const [name, rows] of Object.entries(incoming)) {
    const t = SYNC_TABLES.find((x) => x.name === name);
    if (!t) throw new PushError(422, `Tabela desconhecida: ${name}`);
    if (t.dir === 'down') throw new PushError(403, `Tabela read-only (down): ${name}`);
    if (rows.length > PUSH_LIMIT) throw new PushError(413, `Lote acima de ${PUSH_LIMIT} linhas: ${name}`);
  }

  const tables: Record<string, Row[]> = {};

  // Desabilita o trigger stamp_sync nesta sessão pra gravar field_updated_at/updated_at
  // EXATAMENTE como o merge calculou. Reabilita no fim (mesmo em erro).
  await db.setSyncReplica(true);
  try {
    for (const [name, rows] of Object.entries(incoming)) {
      const t = SYNC_TABLES.find((x) => x.name === name)!;
      const result: Row[] = [];

      for (const raw of rows) {
        const row: Row = { ...raw };

        // Escopo por empresa: server-side, sempre.
        if (hasDirectEmpresaId(t.name)) {
          row.empresa_id = empresaId; // força o escopo, ignora o que veio no payload.
        } else if (t.parent) {
          // Filha: valida que o pai pertence à empresa (cadeia até o ancestral com empresa_id).
          const parentId = row[t.parent.fk];
          if (parentId == null) {
            throw new PushError(422, `${name}.${t.parent.fk} ausente`);
          }
          const ok = await db.parentBelongsToEmpresa(t.parent.table, parentId, empresaId);
          if (!ok) {
            throw new PushError(403, `${name}: pai ${t.parent.fk}=${String(parentId)} fora do escopo da empresa`);
          }
        }

        const pkVal = row[t.pk];
        const canonica = pkVal != null ? await db.findCanonical(t, empresaId, pkVal) : null;

        let toWrite: Row;
        if (canonica) {
          // incoming = "local"/novo; canonica = "remote". Merge campo-a-campo.
          const merged = mergeRow(row as SyncRow, canonica as SyncRow);
          // empresa_id nunca migra de empresa via merge.
          if (hasDirectEmpresaId(t.name)) merged.empresa_id = empresaId;
          merged.updated_at = maxTimestamp(merged.field_updated_at as Record<string, string>);
          toWrite = merged as Row;
        } else {
          // INSERT: respeita os carimbos vindos do hub; deriva updated_at do field_updated_at.
          row.updated_at = maxTimestamp(row.field_updated_at as Record<string, string>);
          toWrite = row;
        }

        const saved = await db.upsertRaw(t.name, toWrite);
        result.push(saved);
      }

      tables[name] = result;
    }
  } finally {
    await db.setSyncReplica(false);
  }

  return { tables };
}
