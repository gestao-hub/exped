// lib/provisioning/__tests__/redeem-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ rpc: (fn: string, args: Record<string, unknown>) => rpcImpl(fn, args) }),
}));

import { POST } from '../../../app/api/provision/redeem/route';

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://x/api/provision/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  rpcImpl = async (fn) => {
    if (fn === 'provision_note_attempt') return { data: 1, error: null };
    if (fn === 'redeem_provisioning_code')
      return { data: [{ empresa_id: 'E1', empresa_nome: 'Acme' }], error: null };
    return { data: null, error: null };
  };
});

describe('/api/provision/redeem', () => {
  it('resgata e devolve token + url + empresa', async () => {
    const res = await POST(req({ code: 'EXPED-7K4P-2QXM' }) as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.deviceToken).toMatch(/^hpr_/);
    expect(j.empresaId).toBe('E1');
    expect(j.empresaNome).toBe('Acme');
    expect(typeof j.cloudApiUrl).toBe('string');
  });

  it('código inválido → 400 genérico com requestId', async () => {
    rpcImpl = async (fn) =>
      fn === 'provision_note_attempt' ? { data: 1, error: null } : { data: null, error: { message: 'codigo inexistente' } };
    const res = await POST(req({ code: 'EXPED-XXXX-XXXX' }) as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe('codigo invalido ou expirado');
    expect(j.requestId).toBeTruthy();
  });

  it('excesso de tentativas → 429', async () => {
    rpcImpl = async (fn) => (fn === 'provision_note_attempt' ? { data: 99, error: null } : { data: null, error: null });
    const res = await POST(req({ code: 'EXPED-7K4P-2QXM' }) as never);
    expect(res.status).toBe(429);
  });

  it('payload inválido → 422', async () => {
    const res = await POST(req({ nope: true }) as never);
    expect(res.status).toBe(422);
  });
});
