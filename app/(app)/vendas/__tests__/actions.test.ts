import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }));

import { puxarDoHiperAction } from '../actions';

describe('puxarDoHiperAction', () => {
  const previousAgentUrl = process.env.AGENT_SYNC_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AGENT_SYNC_URL = 'http://127.0.0.1:5005';
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'vendedor-1' } } }),
      },
    });

    const eq = vi.fn().mockResolvedValue({ data: [{ hiper_usuario_id: 42 }] });
    mocks.createAdminClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq }),
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousAgentUrl === undefined) delete process.env.AGENT_SYNC_URL;
    else process.env.AGENT_SYNC_URL = previousAgentUrl;
  });

  it('mostra a falha do agente quando o endpoint responde HTTP não-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'Falha simulada no agente.' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(puxarDoHiperAction()).resolves.toEqual({
      ok: false,
      message: 'Falha simulada no agente.',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('recusa sucesso HTTP quando o corpo declara falha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'Sincronização recusada.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(puxarDoHiperAction()).resolves.toEqual({
      ok: false,
      message: 'Sincronização recusada.',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('informa pedidos processados sem afirmar que todos são novos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, synced: 55 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(puxarDoHiperAction()).resolves.toEqual({
      ok: true,
      synced: 55,
      message: '55 pedido(s) processado(s) na sincronização com o Hiper.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/vendas');
  });
});
