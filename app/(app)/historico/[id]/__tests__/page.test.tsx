import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('next/navigation', () => ({ notFound: vi.fn() }));
vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/mapa-carregamento', () => ({ MapaCarregamento: () => null }));
vi.mock('@/components/imprimir-pedido-button', () => ({ ImprimirPedidoButton: () => null }));
vi.mock('@/components/pedido-comentarios', () => ({ PedidoComentarios: () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const pedido = {
      select: () => pedido,
      eq: (...args: unknown[]) => (mocks.calls.push(['eq', ...args]), pedido),
      is: (...args: unknown[]) => (mocks.calls.push(['is', ...args]), pedido),
      single: async () => ({
        data: {
          id: 'p1',
          numero_mapa: 1,
          cliente_nome: 'Cliente',
          status: 'em_separacao',
          vendedor_id: null,
          empresa_id: 'e1',
        },
      }),
    };
    const points = {
      select: () => points,
      eq: () => points,
      is: () => points,
      order: async () => ({ data: [] }),
    };
    const logistics = { select: () => logistics, eq: () => logistics, maybeSingle: async () => ({ data: null }) };
    const comments = { select: () => comments, eq: () => comments, order: async () => ({ data: [] }) };
    const empresa = { select: () => empresa, eq: () => empresa, maybeSingle: async () => ({ data: null }) };

    return {
      auth: { getUser: async () => ({ data: { user: null } }) },
      from: (table: string) => {
        if (table === 'pedidos') return pedido;
        if (table === 'pedido_pontos_retirada') return points;
        if (table === 'pedido_logistica') return logistics;
        if (table === 'pedido_comentarios') return comments;
        return empresa;
      },
    };
  },
}));

import HistoricoDetail from '../page';

describe('HistoricoDetail', () => {
  it('exclui pedido removido na consulta de detalhe', async () => {
    mocks.calls.length = 0;

    await HistoricoDetail({ params: Promise.resolve({ id: 'p1' }) });

    expect(mocks.calls).toContainEqual(['eq', 'id', 'p1']);
    expect(mocks.calls).toContainEqual(['is', 'deleted_at', null]);
  });
});
