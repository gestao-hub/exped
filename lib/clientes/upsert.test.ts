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
        '20000000-0000-4000-8000-000000000010',
      ),
    ).resolves.toEqual({ id: '20000000-0000-4000-8000-000000000001', criou: false });

    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });
});
