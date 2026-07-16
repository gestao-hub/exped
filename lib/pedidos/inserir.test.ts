import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { calcularHashSnapshotIngest, inserirPedido } from './inserir';

const source = readFileSync(new URL('./inserir.ts', import.meta.url), 'utf8');

describe('reimportacao de filhos do pedido', () => {
  it('gera hash estavel sem ids transitorios, PDF ou saldo de estoque', () => {
    const base = {
      documento_erp: 'L001000000282',
      cliente_nome: 'Cliente existente',
      valor_total: 125,
      storage_pdf_path: 'hiper-sync/primeiro.pdf',
      pontos_retirada: [{
        id: '30000000-0000-4000-8000-000000000010',
        tipo: 'loja' as const,
        empresa_nome: 'Loja',
        itens: [{
          id: '30000000-0000-4000-8000-000000000011',
          codigo: '1284',
          descricao: 'Cimento',
          quantidade: 3,
          unidade: 'UN',
          preco_unitario: 41.6667,
          desconto: 0,
          total: 125,
          modalidade: 'loja' as const,
          saldo_estoque: 40,
        }],
      }],
    };
    const replay = {
      ...base,
      storage_pdf_path: 'hiper-sync/segundo.pdf',
      pontos_retirada: [{
        ...base.pontos_retirada[0],
        id: '30000000-0000-4000-8000-000000000020',
        itens: [{
          ...base.pontos_retirada[0].itens[0],
          id: '30000000-0000-4000-8000-000000000021',
          saldo_estoque: 12,
        }],
      }],
    };

    expect(calcularHashSnapshotIngest(base, null)).toBe(calcularHashSnapshotIngest(replay, null));
    expect(calcularHashSnapshotIngest(base, null)).not.toBe(
      calcularHashSnapshotIngest({ ...replay, valor_total: 126 }, null),
    );
  });

  it('delega o re-sync completo para uma unica RPC transacional', () => {
    expect(source).toMatch(/rpc\(\s*'resync_pedido_ingest'/);
    expect(source).not.toMatch(/from\('pedido_itens'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)\.delete\(\)/);
    expect(source).not.toMatch(/from\('pedido_itens'\)[\s\S]*?update\(\{ deleted_at:/);
    expect(source).not.toMatch(/from\('pedido_pontos_retirada'\)[\s\S]*?update\(\{ deleted_at:/);
  });

  it('reutiliza o cliente ja vinculado ao pedido durante o reprocessamento', () => {
    expect(source).toMatch(
      /select\('id, numero_mapa, status, cliente_id, ingest_pdf_snapshot_hash, ingest_snapshot_hash, storage_pdf_path'\)/,
    );
    expect(source).toMatch(/cliente_id:\s*existing\.cliente_id/);
  });

  it('nao chama a RPC quando o backfill repete exatamente o mesmo snapshot', async () => {
    const pedido = {
      documento_erp: 'L001000000282',
      cliente_nome: 'Cliente existente',
      cliente_cnpj_cpf: null,
      valor_total: 125,
      pontos_retirada: [{
        tipo: 'loja' as const,
        empresa_nome: 'Loja',
        itens: [{
          codigo: '1284', descricao: 'Cimento', quantidade: 3, unidade: 'UN',
          preco_unitario: 41.6667, desconto: 0, total: 125, modalidade: 'loja' as const,
        }],
      }],
    };
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '30000000-0000-4000-8000-000000000001',
          numero_mapa: 4079,
          status: 'rascunho',
          cliente_id: null,
          ingest_pdf_snapshot_hash: 'f'.repeat(64),
          storage_pdf_path: 'hiper-sync/pdf-do-snapshot-antigo.pdf',
          ingest_snapshot_hash: calcularHashSnapshotIngest(pedido, null),
        },
        error: null,
      }),
    };
    const rpc = vi.fn();
    const supabase: Parameters<typeof inserirPedido>[0] = {
      from: vi.fn().mockReturnValue(query),
      rpc,
    } as never;

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      duplicate: true,
      existing_id: '30000000-0000-4000-8000-000000000001',
      existing_numero: 4079,
      existingPdfPath: 'hiper-sync/pdf-do-snapshot-antigo.pdf',
      pdfRecoveryHash: calcularHashSnapshotIngest(pedido, null),
    });

    expect(rpc).not.toHaveBeenCalled();
  });

  it('repete apenas a resolucao quando o snapshot e igual mas o cliente segue sem vinculo', async () => {
    const pedido = {
      documento_erp: 'L001000000285',
      cliente_codigo: '1000375',
      cliente_nome: 'Cliente ainda sem vinculo',
      valor_total: 125,
      pontos_retirada: [],
    } as Parameters<typeof inserirPedido>[1];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          id: '30000000-0000-4000-8000-000000000006',
          numero_mapa: 4082,
          status: 'rascunho',
          cliente_id: null,
          storage_pdf_path: null,
          ingest_snapshot_hash: calcularHashSnapshotIngest(pedido, null),
        },
        error: null,
      }),
    };
    const rpc = vi.fn().mockResolvedValue({
      data: {
        updated: true,
        reason: 'client_resolved',
        snapshot_changed: false,
        id: '30000000-0000-4000-8000-000000000006',
        numero: 4082,
      },
      error: null,
    });
    const supabase: Parameters<typeof inserirPedido>[0] = {
      from: vi.fn().mockReturnValue(query),
      rpc,
    } as never;

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toMatchObject({
      id: '30000000-0000-4000-8000-000000000006',
      updated: true,
      snapshotChanged: false,
      previousPdfPath: null,
    });

    expect(rpc).toHaveBeenCalledOnce();
  });

  it('cria um pedido novo do ingest em uma unica RPC transacional', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'create_pedido_ingest') {
        return {
          data: {
            created: true,
            id: '30000000-0000-4000-8000-000000000007',
            numero: 4083,
          },
          error: null,
        };
      }
      return { data: null, error: { message: `RPC inesperada: ${name}` } };
    });
    const from = vi.fn().mockReturnValue(query);
    const supabase = { rpc, from } as unknown as Parameters<typeof inserirPedido>[0];
    const pedido = {
      documento_erp: 'L001000000286',
      cliente_codigo: '1000376',
      cliente_nome: 'Cliente atomico',
      valor_total: 40,
      pontos_retirada: [{
        tipo: 'loja' as const,
        empresa_nome: 'Loja',
        itens: [{
          codigo: 'ATOM', descricao: 'Item atomico', quantidade: 1, unidade: 'UN',
          preco_unitario: 40, desconto: 0, total: 40, modalidade: 'loja' as const,
        }],
      }],
    } as Parameters<typeof inserirPedido>[1];
    const expectedHash = calcularHashSnapshotIngest(pedido, null);

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      id: '30000000-0000-4000-8000-000000000007',
      numero: 4083,
      previousPdfPath: null,
      pdfRecoveryHash: expectedHash,
    });

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('create_pedido_ingest', expect.objectContaining({
      p_empresa: '00000000-0000-0000-0000-0000000f0001',
      p_header: expect.objectContaining({ ingest_snapshot_hash: expectedHash }),
      p_pontos: pedido.pontos_retirada,
    }));
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('trata como duplicado a corrida detectada pela RPC de criacao', async () => {
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      neq: vi.fn(() => query),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'create_pedido_ingest') {
        return {
          data: {
            created: false,
            duplicate: true,
            id: '30000000-0000-4000-8000-000000000008',
            numero: 4084,
            storage_pdf_path: null,
            pdf_recovery_allowed: true,
          },
          error: null,
        };
      }
      return { data: null, error: { message: `RPC inesperada: ${name}` } };
    });
    const supabase = {
      rpc,
      from: vi.fn().mockReturnValue(query),
    } as unknown as Parameters<typeof inserirPedido>[0];
    const pedido = {
      documento_erp: 'L001000000287',
      cliente_codigo: '1000377',
      cliente_nome: 'Cliente concorrente',
      valor_total: 50,
      pontos_retirada: [],
    } as Parameters<typeof inserirPedido>[1];
    const expectedHash = calcularHashSnapshotIngest(pedido, null);

    await expect(inserirPedido(supabase, pedido, {
      vendedorId: null,
      status: 'rascunho',
      empresaId: '00000000-0000-0000-0000-0000000f0001',
      upsertOnDuplicate: true,
    })).resolves.toEqual({
      duplicate: true,
      existing_id: '30000000-0000-4000-8000-000000000008',
      existing_numero: 4084,
      existingPdfPath: null,
      pdfRecoveryHash: expectedHash,
    });

    expect(rpc).toHaveBeenCalledOnce();
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
      pdfRecoveryHash: calcularHashSnapshotIngest(pedido, null),
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
