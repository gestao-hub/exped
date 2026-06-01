// lib/provisioning/__tests__/agent-config-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;
let empresaRow: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(t: string) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },           // dispositivos (resolveDevice)
        async single() { return { data: t === 'empresas' ? empresaRow : null }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
  }),
}));

import { GET } from '../../../app/api/agent/config/route';

function req(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://127.0.0.1:3000/api/agent/config', { headers });
}

beforeEach(() => {
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
  empresaRow = { agente_situacoes_venda: '3,9', agente_sync_os: true, agente_situacoes_os: '10,20', agente_poll_segundos: 15 };
});

describe('/api/agent/config', () => {
  it('sem token → 401', async () => {
    const res = await GET(req() as never);
    expect(res.status).toBe(401);
  });

  it('com token → devolve a config da empresa', async () => {
    const res = await GET(req('hpr_abc') as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ situacoesVenda: '3,9', syncOs: true, situacoesOs: '10,20', pollSegundos: 15 });
  });

  it('empresa sem colunas → defaults', async () => {
    empresaRow = {};
    const res = await GET(req('hpr_abc') as never);
    const j = await res.json();
    expect(j).toEqual({ situacoesVenda: '2,5,7', syncOs: false, situacoesOs: '', pollSegundos: 30 });
  });
});
