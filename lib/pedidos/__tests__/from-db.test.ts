import { describe, it, expect } from 'vitest';
import { pedidoRowsToFormInput } from '@/lib/pedidos/from-db';

// Fixtures mínimas no formato das linhas do banco (PedidoRow / PontoRow / ItemRow).
function pedidoRow(over: Record<string, unknown> = {}) {
  return {
    documento_erp: 'L1', data_emissao: null, data_entrega: null,
    cliente_codigo: null, cliente_nome: 'Cliente', cliente_cnpj_cpf: null,
    cliente_endereco: null, cliente_bairro: null, cliente_cidade: null,
    cliente_uf: null, cliente_cep: null, cliente_telefone: null,
    cliente_endereco_id: null, forma_pagamento: null, parcelas: null,
    receber_na_entrega: false, valor_total: 60, valor_frete: 15,
    observacoes: null, storage_pdf_path: null,
    ...over,
  } as Parameters<typeof pedidoRowsToFormInput>[0];
}

function ponto(tipo: string, itens: Record<string, unknown>[], ordem = 0) {
  return {
    id: `p-${tipo}`, tipo, empresa_nome: '', endereco: null, ordem,
    itens: itens.map((it, i) => ({
      id: `it-${i}`, codigo: `C${i}`, descricao: `Item ${i}`, quantidade: 1,
      unidade: 'UN', preco_unitario: 10, desconto: 0, total: 10,
      modalidade: 'loja', referencia: null, saldo_estoque: null, ordem: i,
      ...it,
    })),
  } as Parameters<typeof pedidoRowsToFormInput>[1][number];
}

describe('pedidoRowsToFormInput', () => {
  it('mapeia valor_frete do banco para o form (não some na edição → evita NaN no re-save)', () => {
    const form = pedidoRowsToFormInput(pedidoRow({ valor_frete: 15 }), []);
    expect(form.valor_frete).toBe(15);
  });

  it('valor_frete null do banco é preservado como null (campo opcional)', () => {
    const form = pedidoRowsToFormInput(pedidoRow({ valor_frete: null }), []);
    expect(form.valor_frete).toBeNull();
  });

  it('preserva a modalidade de cada item no round-trip do banco', () => {
    const form = pedidoRowsToFormInput(pedidoRow(), [
      ponto('loja', [{ modalidade: 'loja' }], 0),
      ponto('entrega', [{ modalidade: 'entrega' }], 1),
      ponto('imediato', [{ modalidade: 'imediato' }], 2),
    ]);
    const modalidades = form.pontos_retirada.flatMap((p) => p.itens.map((i) => i.modalidade));
    expect(modalidades.sort()).toEqual(['entrega', 'imediato', 'loja']);
  });
});
