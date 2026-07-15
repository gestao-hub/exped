import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryCall = { method: string; args: unknown[] };
type QueryRecord = { table: string; calls: QueryCall[] };

const mocks = vi.hoisted(() => ({
  queries: [] as QueryRecord[],
}));

vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/layout/content-card', () => ({ ContentCard: () => null }));
vi.mock('@/components/admin-charts', () => ({
  PedidosPorDia: () => null,
  TopClientes: () => null,
  TopBairros: () => null,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from(table: string) {
      const record: QueryRecord = { table, calls: [] };
      mocks.queries.push(record);
      const query = {
        select(...args: unknown[]) {
          record.calls.push({ method: 'select', args });
          return query;
        },
        eq(...args: unknown[]) {
          record.calls.push({ method: 'eq', args });
          return query;
        },
        is(...args: unknown[]) {
          record.calls.push({ method: 'is', args });
          return query;
        },
        gte(...args: unknown[]) {
          record.calls.push({ method: 'gte', args });
          return query;
        },
        then(resolve: (value: { data: unknown[]; count: number }) => unknown) {
          return Promise.resolve({ data: [], count: 0 }).then(resolve);
        },
      };
      return query;
    },
    rpc: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import AdminDashboard from '../page';

describe('AdminDashboard', () => {
  beforeEach(() => {
    mocks.queries.length = 0;
  });

  it('exclui tombstones de todos os contadores e da série diária', async () => {
    await AdminDashboard();

    const pedidosQueries = mocks.queries.filter(({ table }) => table === 'pedidos');
    expect(pedidosQueries).toHaveLength(8);
    for (const query of pedidosQueries) {
      expect(query.calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    }

    const clientesQueries = mocks.queries.filter(({ table }) => table === 'clientes');
    expect(clientesQueries).toHaveLength(1);
    expect(clientesQueries[0].calls).toContainEqual({
      method: 'is',
      args: ['deleted_at', null],
    });
  });
});
