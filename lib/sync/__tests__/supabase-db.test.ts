import { describe, expect, it, vi } from 'vitest';
import { SyncSchemaUnavailableError } from '../engine';
import { makeSupabaseSyncDb } from '../supabase-db';

describe('makeSupabaseSyncDb.selectChanges', () => {
  it('usa uma única RPC tenant-scoped para keyset de tabela direta', async () => {
    const rows = [
      { id: 'c2', empresa_id: 'E1', updated_at: '2026-07-14T12:00:00.123456Z' },
    ];
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const from = vi.fn(() => {
      throw new Error('keyset direto não pode abrir duas consultas PostgREST');
    });
    const db = makeSupabaseSyncDb({ rpc, from } as never);

    const result = await db.selectChanges(
      'clientes',
      'E1',
      '2026-07-14T12:00:00.123456Z',
      500,
      'c1',
    );

    expect(result).toEqual(rows);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('sync_direct_changed', {
      p_table: 'clientes',
      p_empresa: 'E1',
      p_cursor: '2026-07-14T12:00:00.123456Z',
      p_cursor_pk: 'c1',
      p_limit: 500,
    });
    expect(from).not.toHaveBeenCalled();
  });
});

describe('makeSupabaseSyncDb.mergeAndUpsert', () => {
  it('envia linha original e tenant autenticado para uma unica RPC atomica', async () => {
    const incoming = {
      id: 'c1',
      empresa_id: 'HACK',
      endereco_padrao: 'Rua nova',
      field_updated_at: { endereco_padrao: '2026-07-14T12:00:00Z' },
    };
    const canonical = {
      ...incoming,
      empresa_id: 'E1',
      updated_at: '2026-07-14T12:00:00Z',
    };
    const rpc = vi.fn(async () => ({ data: canonical, error: null }));
    const from = vi.fn(() => {
      throw new Error('merge atomico nao pode fazer leitura PostgREST separada');
    });
    const db = makeSupabaseSyncDb({ rpc, from } as never);

    const result = await (db as typeof db & {
      mergeAndUpsert: (
        table: { name: string; pk: string; dir: 'two-way' },
        empresaId: string,
        row: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null>;
    }).mergeAndUpsert(
      { name: 'clientes', pk: 'id', dir: 'two-way' },
      'E1',
      incoming,
    );

    expect(result).toEqual(canonical);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('sync_merge_upsert', {
      p_table: 'clientes',
      p_empresa: 'E1',
      p_row: incoming,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('repete a RPC quando o Postgres sinaliza conflito transitorio', async () => {
    const canonical = { id: 'c1', empresa_id: 'E1', field_updated_at: {} };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'retry' } })
      .mockResolvedValueOnce({ data: canonical, error: null });
    const db = makeSupabaseSyncDb({ rpc, from: vi.fn() } as never);
    const atomicDb = db as typeof db & {
      mergeAndUpsert: (
        table: { name: string; pk: string; dir: 'two-way' },
        empresaId: string,
        row: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null>;
    };

    await expect(atomicDb.mergeAndUpsert(
      { name: 'clientes', pk: 'id', dir: 'two-way' },
      'E1',
      canonical,
    )).resolves.toEqual(canonical);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('traduz RPC ausente em erro de schema recuperavel', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.sync_merge_upsert',
      },
    }));
    const db = makeSupabaseSyncDb({ rpc, from: vi.fn() } as never);

    await expect(db.mergeAndUpsert(
      { name: 'clientes', pk: 'id', dir: 'two-way' },
      'E1',
      { id: 'c1', field_updated_at: {} },
    )).rejects.toBeInstanceOf(SyncSchemaUnavailableError);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
