import { Children, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ single: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: () => ({ single: mocks.single }) }),
}));
vi.mock('@/components/pedidos-list', () => ({ PedidosList: () => null }));

import HistoricoPage from '../page';

beforeEach(() => {
  mocks.single.mockResolvedValue({
    data: { pedidos_finalizados: 7, valor_faturado: 125, clientes_unicos: 1 },
  });
});

describe('HistoricoPage', () => {
  it('abre a lista em todos e deixa explicita a exportacao de finalizados', async () => {
    const page = await HistoricoPage();
    const children = Children.toArray(page.props.children) as ReactElement[];
    const header = children[0] as ReactElement<{
      description: string;
      actions: ReactElement<{ href: string; children: ReactNode }>;
    }>;
    const list = children[2] as ReactElement<{ initialStatus: string; mode: string }>;

    expect(header.props.description).toContain('todos os status');
    expect(header.props.actions.props.href).toBe('/historico/export?status=finalizado');
    const actionText = Children.toArray(header.props.actions.props.children)
      .filter((child): child is string => typeof child === 'string')
      .join('')
      .trim();
    expect(actionText).toBe('Exportar finalizados');
    expect(list.props).toMatchObject({ mode: 'historico', initialStatus: 'todos' });
  });
});
