import { describe, it, expect, vi, beforeEach } from 'vitest';

let deviceRow: { id: string; empresa_id: string; ativo: boolean } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: deviceRow }; },
        update() { return { eq: async () => ({ data: null }) }; },
      };
    },
  }),
}));

const atualizarNfPedido = vi.fn();
vi.mock('@/lib/pedidos/atualizar-nf', () => ({
  atualizarNfPedido: (...args: unknown[]) => atualizarNfPedido(...args),
}));

import { POST } from '../route';

function req(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://127.0.0.1:3000/api/ingest/pedido/nf', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  deviceRow = { id: 'D1', empresa_id: 'E1', ativo: true };
  atualizarNfPedido.mockReset();
});

describe('POST /api/ingest/pedido/nf', () => {
  it('sem token → 401', async () => {
    const res = await POST(req({ documento_erp: 'DOC1' }) as never);
    expect(res.status).toBe(401);
  });

  it('documento_erp ausente → 422', async () => {
    const res = await POST(req({ nf_numero: '1' }, 'tok') as never);
    expect(res.status).toBe(422);
  });

  it('happy path → 200 e chama atualizarNfPedido com a empresa do device', async () => {
    atualizarNfPedido.mockResolvedValue({ updated: true, id: 'P1' });
    const res = await POST(req({ documento_erp: 'DOC1', nf_numero: '616', forma_pagamento: 'Pix' }, 'tok') as never);
    expect(res.status).toBe(200);
    expect(atualizarNfPedido).toHaveBeenCalledOnce();
    const arg = atualizarNfPedido.mock.calls[0][1];
    expect(arg.empresaId).toBe('E1');
    expect(arg.documentoErp).toBe('DOC1');
  });

  it('pedido inexistente → 404', async () => {
    atualizarNfPedido.mockResolvedValue({ notfound: true });
    const res = await POST(req({ documento_erp: 'DOCX', nf_numero: '1' }, 'tok') as never);
    expect(res.status).toBe(404);
  });
});
