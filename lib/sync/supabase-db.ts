import type { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/types/database';
import { SyncSchemaUnavailableError, type SyncDb, type Row } from './engine';
import {
  getSyncTable,
  hasDirectEmpresaId,
  pullCursorColumn,
  scopeColumn,
  type TwoWaySyncTable,
} from './tables';

type Admin = ReturnType<typeof createAdminClient>;

function isMissingAtomicMergeRpc(error: { code?: string; message?: string }): boolean {
  return ['PGRST202', '42883'].includes(error.code ?? '')
    && (error.message ?? '').includes('sync_merge_upsert');
}

/**
 * Implementação de SyncDb sobre o supabase-js (service_role).
 *
 * Escopo por empresa:
 *  - selectChanges: tabelas com empresa_id direto filtram por coluna; filhas
 *    (sem empresa_id) usam RPC com JOIN até o ancestral que possui empresa_id.
 *  - findCanonical/parentBelongsToEmpresa: idem.
 *
 * Escrita via `sync_merge_upsert`: tenant, lock, leitura canonica, merge e upsert
 * ficam na MESMA transacao. O RPC tambem seta `exped.sync = 'on'` para preservar
 * field_updated_at/updated_at sem depender da sessao do pool PostgREST.
 * `setSyncReplica` aqui é no-op porque o toggle é por-transação dentro do RPC
 * (REST/pool não mantém sessão entre requests).
 */

export function makeSupabaseSyncDb(supabase: Admin): SyncDb {
  return {
    async selectChanges(table, empresaId, cursor, limit, cursorPk) {
      // Filhas (sem empresa_id direto): escopo via RPC com JOIN no banco — evita carregar
      // todos os IDs da empresa em memória + .in() gigante.
      if (!hasDirectEmpresaId(table)) {
        const params = cursorPk === undefined
          ? { p_table: table, p_empresa: empresaId, p_cursor: cursor, p_limit: limit }
          : {
              p_table: table,
              p_empresa: empresaId,
              p_cursor: cursor,
              p_cursor_pk: cursorPk,
              p_limit: limit,
            };
        // Overload keyset ainda não consta nos tipos gerados; o nome/shape é coberto
        // pelo contrato pgTAP da migration que o introduz.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc('sync_children_changed', params);
        if (error) throw error;
        return (data ?? []) as unknown as Row[];
      }

      const syncTable = getSyncTable(table);
      if (!syncTable) throw new Error(`Tabela de pull desconhecida: ${table}`);
      const pkColumn = pullCursorColumn(syncTable);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const baseQuery = () => (supabase as any)
        .from(table)
        .select('*')
        .eq(scopeColumn(table), empresaId);

      if (cursorPk !== undefined) {
        // Uma RPC = um statement/snapshot para o predicado de tupla. Fazer a
        // parte empatada e a parte posterior em requests separados poderia
        // perder ou duplicar linhas entre snapshots.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc('sync_direct_changed', {
          p_table: table,
          p_empresa: empresaId,
          p_cursor: cursor,
          p_cursor_pk: cursorPk,
          p_limit: limit,
        });
        if (error) throw error;
        return (data ?? []) as Row[];
      }

      const { data, error } = await baseQuery()
        .gt('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .order(pkColumn, { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as Row[];
    },

    async findCanonical(table: TwoWaySyncTable, empresaId, pk) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase as any).from(table.name).select('*').eq(table.pk, pk);
      if (hasDirectEmpresaId(table.name)) q = q.eq(scopeColumn(table.name), empresaId);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // Filha: confere o ancestral.
      if (!hasDirectEmpresaId(table.name) && table.parent) {
        const ok = await this.parentBelongsToEmpresa(
          table.parent.table,
          (data as Row)[table.parent.fk],
          empresaId,
        );
        if (!ok) return null;
      }
      return data as Row;
    },

    async findCanonicalGlobal(table: TwoWaySyncTable, pk) {
      // Existência GLOBAL por PK, SEM filtro de empresa (detecção de colisão
      // cross-tenant). service_role ignora RLS, então enxerga linhas de qualquer
      // empresa de propósito aqui.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from(table.name)
        .select('*')
        .eq(table.pk, pk)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },

    async parentBelongsToEmpresa(parentTable, parentId, empresaId) {
      const { data, error } = await supabase.rpc('sync_parent_in_empresa', {
        p_table: parentTable,
        p_id: parentId as string,
        p_empresa: empresaId,
      });
      if (error) throw error;
      return data === true;
    },

    async parentsInEmpresa(parentTable, parentIds, empresaId) {
      const set = new Set<string>();
      const ids = [...new Set(parentIds.map((x) => x as string).filter(Boolean))];
      if (ids.length === 0) return set;
      const { data, error } = await supabase.rpc('sync_parents_in_empresa', {
        p_table: parentTable,
        p_ids: ids,
        p_empresa: empresaId,
      });
      if (error) throw error;
      for (const id of (data ?? []) as string[]) set.add(String(id));
      return set;
    },

    async findCanonicalMany(table, empresaId, pks) {
      const map = new Map<string, Row>();
      const ids = [...new Set(pks.map((x) => x as string).filter(Boolean))];
      if (ids.length === 0) return map;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase as any).from(table.name).select('*').in(table.pk, ids);
      if (hasDirectEmpresaId(table.name)) q = q.eq(scopeColumn(table.name), empresaId);
      const { data, error } = await q;
      if (error) throw error;
      let rows = (data ?? []) as Row[];
      if (!hasDirectEmpresaId(table.name) && table.parent) {
        const parentIds = rows.map((r) => r[table.parent!.fk]);
        const valid = await this.parentsInEmpresa(table.parent.table, parentIds, empresaId);
        rows = rows.filter((r) => valid.has(String(r[table.parent!.fk])));
      }
      for (const r of rows) map.set(String(r[table.pk]), r);
      return map;
    },

    async mergeAndUpsert(table, empresaId, row) {
      const transientCodes = new Set(['40001', '40P01']);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // A migration nova ainda nao consta nos tipos gerados deste branch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase as any).rpc('sync_merge_upsert', {
          p_table: table.name,
          p_empresa: empresaId,
          p_row: row as Json,
        });
        if (!error) return (data ?? null) as unknown as Row | null;
        if (isMissingAtomicMergeRpc(error)) {
          throw new SyncSchemaUnavailableError(
            'A migration sync_merge_upsert ainda nao esta disponivel',
            { cause: error },
          );
        }
        if (!transientCodes.has(error.code ?? '') || attempt === 2) throw error;
      }
      throw new Error('retry de merge atomico esgotado');
    },

    async upsertRaw(table, row) {
      const { data, error } = await supabase.rpc('sync_push_upsert', {
        p_table: table,
        p_row: row as Json,
      });
      if (error) throw error;
      // RETURNING vazio (null) = guarda `where empresa_id` no RPC bloqueou um UPDATE
      // de linha de outra empresa (takeover cross-tenant). O engine traduz em 403.
      return (data ?? null) as Row | null;
    },

    async setSyncReplica() {
      // No-op: o toggle do trigger (GUC exped.sync) é feito por-transação DENTRO do
      // RPC sync_push_upsert. (PostgREST usa pool de conexões; um SET fora da
      // transação do upsert não persistiria.)
    },

    async selectAuthUsers(empresaId, cursor, limit, cursorPk) {
      // PostgREST da nuvem NÃO expõe o schema `auth` (e expô-lo vazaria hashes de senha).
      // Usamos a RPC SECURITY DEFINER public.sync_auth_users, que lê auth.users por dentro,
      // escopada na empresa server-side, e devolve só as colunas do GoTrue (incl. hash).
      const params = cursorPk === undefined
        ? { p_empresa: empresaId, p_cursor: cursor, p_limit: limit }
        : {
            p_empresa: empresaId,
            p_cursor: cursor,
            p_cursor_pk: cursorPk,
            p_limit: limit,
          };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('sync_auth_users', params);
      if (error) throw error;
      return ((data ?? []) as unknown[]).map((r) => r as Row);
    },
  };
}
