import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  revalidatePath: vi.fn(),
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { liberarParaLogisticaAction, salvarFinanceiroAction } from '../actions';

function pedidoUpdateQuery() {
  const query = {
    update(...args: unknown[]) {
      mocks.calls.push({ method: 'update', args });
      return query;
    },
    eq(...args: unknown[]) {
      mocks.calls.push({ method: 'eq', args });
      return query;
    },
    is(...args: unknown[]) {
      mocks.calls.push({ method: 'is', args });
      return query;
    },
    select(...args: unknown[]) {
      mocks.calls.push({ method: 'select', args });
      return query;
    },
    single: vi.fn().mockResolvedValue({ data: { id: 'pedido-1' }, error: null }),
  };
  return query;
}

const validInput = {
  valor_total: 125,
  valor_frete: 0,
  receber_na_entrega: true,
  exige_emissao: false,
};

describe('ações do financeiro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.createClient.mockResolvedValue({
      from: vi.fn().mockImplementation((table: string) => {
        expect(table).toBe('pedidos');
        return pedidoUpdateQuery();
      }),
    });
  });

  it.each([
    ['salvar', salvarFinanceiroAction],
    ['liberar para logística', liberarParaLogisticaAction],
  ])('não altera tombstone ao %s', async (_label, action) => {
    await expect(action('pedido-1', validInput)).resolves.toEqual({ ok: true });

    expect(mocks.calls).toContainEqual({ method: 'eq', args: ['id', 'pedido-1'] });
    expect(mocks.calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });
});
