import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));

import { GET } from '../route';

type RecordedQuery = {
  select: (...args: unknown[]) => RecordedQuery;
  is: (...args: unknown[]) => RecordedQuery;
  order: (...args: unknown[]) => RecordedQuery;
  range: (...args: unknown[]) => RecordedQuery;
  eq: (...args: unknown[]) => RecordedQuery;
  gte: (...args: unknown[]) => RecordedQuery;
  lte: (...args: unknown[]) => RecordedQuery;
  then: (
    resolve: (value: { data: never[]; error: null }) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

function pedidosQuery(calls: unknown[][]): RecordedQuery {
  const query = {} as RecordedQuery;
  query.select = (...args) => (calls.push(['select', ...args]), query);
  query.is = (...args) => (calls.push(['is', ...args]), query);
  query.order = (...args) => (calls.push(['order', ...args]), query);
  query.range = (...args) => (calls.push(['range', ...args]), query);
  query.eq = (...args) => (calls.push(['eq', ...args]), query);
  query.gte = (...args) => (calls.push(['gte', ...args]), query);
  query.lte = (...args) => (calls.push(['lte', ...args]), query);
  query.then = (resolve, reject) =>
    Promise.resolve({ data: [] as never[], error: null }).then(resolve, reject);
  return query;
}

function mockClient(calls: unknown[][]) {
  type ProfileQuery = {
    select: () => ProfileQuery;
    eq: () => ProfileQuery;
    single: () => Promise<{ data: { empresa_id: string } }>;
  };
  const profile = {} as ProfileQuery;
  profile.select = () => profile;
  profile.eq = () => profile;
  profile.single = async () => ({ data: { empresa_id: 'e1' } });
  mocks.createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: (table: string) => (table === 'profiles' ? profile : pedidosQuery(calls)),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('GET /historico/export', () => {
  it('retorna 401 sem consultar pedidos quando não há sessão', async () => {
    const from = vi.fn();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
      from,
    });

    const response = await GET(
      new NextRequest('http://localhost/historico/export') as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Não autenticado' });
    expect(from).not.toHaveBeenCalled();
  });

  it.each(['', '?status=finalizado'])(
    'exporta apenas finalizados para %s',
    async (search) => {
      const calls: unknown[][] = [];
      mockClient(calls);

      const response = await GET(
        new NextRequest(`http://localhost/historico/export${search}`) as never,
      );
      await response.text();

      expect(calls).toContainEqual(['is', 'deleted_at', null]);
      expect(calls).toContainEqual(['eq', 'status', 'finalizado']);
    },
  );

  it('rejeita tentativa de exportar status nao finalizado', async () => {
    const calls: unknown[][] = [];
    mockClient(calls);

    const response = await GET(
      new NextRequest('http://localhost/historico/export?status=cancelado') as never,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
