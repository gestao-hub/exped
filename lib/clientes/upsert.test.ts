import { describe, expect, it, vi } from 'vitest';
import { upsertCliente } from './upsert';

describe('upsertCliente', () => {
  it('reutiliza somente cliente ativo ao buscar por CNPJ', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query = {
      select(...args: unknown[]) {
        calls.push({ method: 'select', args });
        return query;
      },
      eq(...args: unknown[]) {
        calls.push({ method: 'eq', args });
        return query;
      },
      is(...args: unknown[]) {
        calls.push({ method: 'is', args });
        return query;
      },
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: '20000000-0000-4000-8000-000000000001' },
        error: null,
      }),
    };
    const supabase = {
      from: vi.fn().mockReturnValue(query),
    } as unknown as Parameters<typeof upsertCliente>[0];

    await expect(
      upsertCliente(
        supabase,
        { nome: 'Cliente ativo', cnpj_cpf: '12.345.678/0001-90' },
      ),
    ).resolves.toEqual({ id: '20000000-0000-4000-8000-000000000001', criou: false });

    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });

  it('resolve o cliente do ingest de forma atomica por documento normalizado ou codigo ERP', async () => {
    const canonicalId = '20000000-0000-4000-8000-000000000002';
    const rpc = vi.fn().mockResolvedValue({
      data: { id: canonicalId, criou: false },
      error: null,
    });
    const insertResult = {
      select: () => ({
        single: vi.fn().mockResolvedValue({
          data: { id: '20000000-0000-4000-8000-000000000099' },
          error: null,
        }),
      }),
    };
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockReturnValue(insertResult),
    };
    const supabase = {
      rpc,
      from: vi.fn().mockReturnValue(query),
    } as unknown as Parameters<typeof upsertCliente>[0];

    await expect(
      upsertCliente(
        supabase,
        {
          nome: 'Cliente Hiper',
          cnpj_cpf: '067.203.989-38',
          codigo_erp: '1000373',
        },
        '20000000-0000-4000-8000-000000000010',
      ),
    ).resolves.toEqual({ id: canonicalId, criou: false });

    expect(rpc).toHaveBeenCalledWith('resolve_cliente_ingest', {
      p_empresa: '20000000-0000-4000-8000-000000000010',
      p_cliente: expect.objectContaining({
        cnpj_cpf: '067.203.989-38',
        codigo_erp: '1000373',
        nome: 'Cliente Hiper',
      }),
    });
  });
});
