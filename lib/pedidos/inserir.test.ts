import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inserirPedido } from './inserir';

const source = readFileSync(new URL('./inserir.ts', import.meta.url), 'utf8');

describe('reimportacao de filhos do pedido', () => {
  it('delega o re-sync completo para uma unica RPC transacional', () => {
    expect(source).toMatch(/rpc\(\s*'resync_pedido_ingest'/);
    expect(source).not.toMatch(/from\('pedido_itens'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_itens'\)[\s\S]*?update\(\{ deleted_at:/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)[\s\S]*?update\(\{ deleted_at:/);
  });

  it('reutiliza o cliente ja vinculado ao pedido durante o reprocessamento', () => {
    expect(source).toMatch(/select\('id, numero_mapa, status, cliente_id'\)/);
    expect(source).toMatch(/cliente_id:\s*existing\.cliente_id/);
  });

  it('nao tenta criar cliente para pedido existente que nao pode ser atualizado', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '30000000-0000-4000-8000-000000000001',
          numero_mapa: 4079,
          status: 'finalizado',
          cliente_id: null,
        },
        error: null,
      }),
    };
    const rpc = vi.fn();
    const supabase = {
      from: vi.fn().mockReturnValue(query),
      rpc,
    } as unknown as Parameters<typeof inserirPedido>[0];
    const pedido = {
      documento_erp: 'L001000000282',
      cliente_nome: 'Cliente existente',
      cliente_cnpj_cpf: null,
      valor_total: 125,
      pontos_retirada: [],
    } as Parameters<typeof inserirPedido>[1];

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      duplicate: true,
      existing_id: '30000000-0000-4000-8000-000000000001',
      existing_numero: 4079,
    });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('resolve e vincula dentro da mesma transacao o cliente que chegou depois', async () => {
    const clienteId = '30000000-0000-4000-8000-000000000003';
    const existingQuery = {
      select: vi.fn(() => existingQuery),
      eq: vi.fn(() => existingQuery),
      neq: vi.fn(() => existingQuery),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '30000000-0000-4000-8000-000000000004',
          numero_mapa: 4080,
          status: 'rascunho',
          cliente_id: null,
        },
        error: null,
      }),
    };
    const rpc = vi.fn().mockResolvedValue({
      data: {
        updated: true,
        id: '30000000-0000-4000-8000-000000000004',
        numero: 4080,
        cliente_id: clienteId,
      },
      error: null,
    });
    const supabase = {
      rpc,
      from: vi.fn(() => existingQuery),
    } as unknown as Parameters<typeof inserirPedido>[0];
    const pedido = {
      documento_erp: 'L001000000283',
      cliente_codigo: '1000373',
      cliente_nome: 'Cliente resolvido depois',
      cliente_cnpj_cpf: '067.203.989-38',
      valor_total: 125,
      pontos_retirada: [],
    } as Parameters<typeof inserirPedido>[1];

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      id: '30000000-0000-4000-8000-000000000004',
      numero: 4080,
      updated: true,
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      'resync_pedido_ingest',
      expect.objectContaining({
        p_pedido_id: '30000000-0000-4000-8000-000000000004',
        p_empresa: '00000000-0000-0000-0000-0000000f0001',
        p_cliente: expect.objectContaining({ codigo_erp: '1000373' }),
      }),
    );
  });

  it('trata como duplicado quando a RPC detecta alteracao concorrente', async () => {
    const existingQuery = {
      select: vi.fn(() => existingQuery),
      eq: vi.fn(() => existingQuery),
      neq: vi.fn(() => existingQuery),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '30000000-0000-4000-8000-000000000005',
          numero_mapa: 4081,
          status: 'rascunho',
          cliente_id: null,
        },
        error: null,
      }),
    };
    const rpc = vi.fn().mockResolvedValue({
      data: { updated: false, reason: 'protected', id: '30000000-0000-4000-8000-000000000005', numero: 4081 },
      error: null,
    });
    const supabase = {
      rpc,
      from: vi.fn(() => existingQuery),
    } as unknown as Parameters<typeof inserirPedido>[0];
    const pedido = {
      documento_erp: 'L001000000284',
      cliente_nome: 'Cliente protegido durante o re-sync',
      cliente_codigo: '1000374',
      valor_total: 125,
      pontos_retirada: [],
    } as Parameters<typeof inserirPedido>[1];

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      duplicate: true,
      existing_id: '30000000-0000-4000-8000-000000000005',
      existing_numero: 4081,
    });
  });
});
