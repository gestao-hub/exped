import { Children, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/pedidos-list', () => ({ PedidosList: () => null }));
vi.mock('@/components/puxar-button', () => ({ PuxarButton: () => null }));

import VendasPage from '../page';
import { PuxarButton } from '@/components/puxar-button';

afterEach(() => vi.unstubAllEnvs());

describe('VendasPage', () => {
  it('renderiza Sincronizar quando o agente local está disponível', () => {
    vi.stubEnv('AGENT_SYNC_URL', 'http://127.0.0.1:5005');
    const page = VendasPage();
    const children = Children.toArray(page.props.children) as ReactElement[];

    expect(children).toHaveLength(3);
    expect((children[1].props as { children: ReactElement }).children.type).toBe(PuxarButton);
  });

  it('não renderiza Sincronizar na nuvem ou quando o agente está desativado', () => {
    vi.stubEnv('AGENT_SYNC_URL', '');
    const page = VendasPage();
    const children = Children.toArray(page.props.children) as ReactElement[];

    expect(children).toHaveLength(2);
  });
});
