import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { inserirPedido } from './inserir';

const source = readFileSync(new URL('./inserir.ts', import.meta.url), 'utf8');

describe('reimportacao de filhos do pedido', () => {
  it('preserva historico com tombstones em vez de hard delete', () => {
    expect(source).not.toMatch(/from\('pedido_itens'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)\.delete\(\)/);
    expect(source).toMatch(/from\('pedido_itens'\)[\s\S]*?update\(\{ deleted_at: now \}\)/);
    expect(source).toMatch(/from\('pedido_pontos_retirada'\)[\s\S]*?update\(\{ deleted_at: now \}\)/);
  });

  it('reutiliza o cliente ja vinculado ao pedido durante o reprocessamento', () => {
    expect(source).toMatch(/select\('id, numero_mapa, status, cliente_id'\)/);
    expect(source).toMatch(/cliente_id[^=]*=\s*existing\?\.cliente_id\s*\?\?/);
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
});
