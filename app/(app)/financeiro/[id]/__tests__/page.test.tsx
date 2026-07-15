import { beforeEach, describe, expect, it, vi } from 'vitest';

type PedidoFixture = {
  id: string;
  numero_mapa: number;
  cliente_nome: string;
  status: string;
  vendedor_id: null;
  empresa_id: string;
  valor_total: number;
};

const mocks = vi.hoisted(() => ({
  pedidoCalls: [] as unknown[][],
  tableCalls: [] as string[],
  events: [] as string[],
  pedidoData: null as PedidoFixture | null,
  notFound: vi.fn(),
}));

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }));
vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/mapa-carregamento', () => ({ MapaCarregamento: () => null }));
vi.mock('@/components/imprimir-pedido-button', () => ({ ImprimirPedidoButton: () => null }));
vi.mock('@/components/pedido-comentarios', () => ({ PedidoComentarios: () => null }));
vi.mock('../financeiro-form', () => ({ FinanceiroForm: () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const pedido = {
      select: () => pedido,
      eq: (...args: unknown[]) => (mocks.pedidoCalls.push(['eq', ...args]), pedido),
      is: (...args: unknown[]) => (mocks.pedidoCalls.push(['is', ...args]), pedido),
      single: () =>
        Promise.resolve().then(() => {
          mocks.events.push('pedido:resolved');
          return { data: mocks.pedidoData };
        }),
    };
    const pontos = {
      select: () => pontos,
      eq: () => pontos,
      is: () => pontos,
      order: async () => ({ data: [] }),
    };
    const comentarios = {
      select: () => comentarios,
      eq: () => comentarios,
      order: async () => ({ data: [] }),
    };
    const empresa = {
      select: () => empresa,
      eq: () => empresa,
      maybeSingle: async () => ({ data: null }),
    };

    return {
      auth: { getUser: async () => ({ data: { user: null } }) },
      from: (table: string) => {
        mocks.tableCalls.push(table);
        mocks.events.push(`from:${table}`);
        if (table === 'pedidos') return pedido;
        if (table === 'pedido_pontos_retirada') return pontos;
        if (table === 'pedido_comentarios') return comentarios;
        return empresa;
      },
    };
  },
}));

import FinanceiroDetailPage from '../page';

describe('FinanceiroDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pedidoCalls.length = 0;
    mocks.tableCalls.length = 0;
    mocks.events.length = 0;
    mocks.pedidoData = {
      id: 'pedido-1',
      numero_mapa: 4079,
      cliente_nome: 'Cliente',
      status: 'em_financeiro',
      vendedor_id: null,
      empresa_id: 'empresa-1',
      valor_total: 125,
    };
    mocks.notFound.mockImplementation(() => {
      throw new Error('NEXT_NOT_FOUND');
    });
  });

  it('consulta somente um pedido ativo', async () => {
    await FinanceiroDetailPage({ params: Promise.resolve({ id: 'pedido-1' }) });

    expect(mocks.pedidoCalls).toContainEqual(['eq', 'id', 'pedido-1']);
    expect(mocks.pedidoCalls).toContainEqual(['is', 'deleted_at', null]);
  });

  it('só inicia as consultas de filhos depois de confirmar o pedido ativo', async () => {
    await FinanceiroDetailPage({ params: Promise.resolve({ id: 'pedido-1' }) });

    const pedidoResolvido = mocks.events.indexOf('pedido:resolved');
    const primeiroFilho = Math.min(
      mocks.events.indexOf('from:pedido_pontos_retirada'),
      mocks.events.indexOf('from:pedido_comentarios'),
    );
    expect(pedidoResolvido).toBeGreaterThanOrEqual(0);
    expect(primeiroFilho).toBeGreaterThan(pedidoResolvido);
  });

  it('não consulta pontos nem comentários quando o pedido não está ativo', async () => {
    mocks.pedidoData = null;

    await expect(
      FinanceiroDetailPage({ params: Promise.resolve({ id: 'pedido-removido' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mocks.tableCalls).not.toContain('pedido_pontos_retirada');
    expect(mocks.tableCalls).not.toContain('pedido_comentarios');
  });
});
