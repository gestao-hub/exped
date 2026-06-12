import { describe, it, expect } from 'vitest';
import { pedidoFormSchema, itemSchema } from '../pedido';

describe('itemSchema modalidade', () => {
  const base = {
    codigo: 'A1', descricao: 'Produto', quantidade: 1, unidade: 'UN',
    preco_unitario: 10, desconto: 0, total: 10,
  };
  it.each(['imediato', 'loja', 'entrega'] as const)('aceita modalidade "%s"', (modalidade) => {
    expect(itemSchema.safeParse({ ...base, modalidade }).success).toBe(true);
  });
  it('rejeita modalidade inválida', () => {
    expect(itemSchema.safeParse({ ...base, modalidade: 'retirada' }).success).toBe(false);
  });
});
describe('pedidoFormSchema pagamento/retirada', () => {
  const base = { cliente_nome: 'X', valor_total: 0,
    pontos_retirada: [{ tipo: 'entrega', empresa_nome: '', itens: [] }] };
  it('aceita forma enum, parcelas int e tipo entrega', () => {
    const r = pedidoFormSchema.safeParse({ ...base, forma_pagamento: 'credito', parcelas: 6 });
    expect(r.success).toBe(true);
  });
  it('rejeita forma fora do enum e parcelas > 12', () => {
    expect(pedidoFormSchema.safeParse({ ...base, forma_pagamento: 'cheque' }).success).toBe(false);
    expect(pedidoFormSchema.safeParse({ ...base, parcelas: 99 }).success).toBe(false);
  });
});

describe('pedidoFormSchema multi-ponto (modalidade por item)', () => {
  const item = {
    codigo: 'A1', descricao: 'Produto', quantidade: 1, unidade: 'UN',
    preco_unitario: 10, desconto: 0, total: 10, modalidade: 'loja' as const,
  };
  // A regra antiga "cada ponto precisa ter >=1 item" foi removida: a modalidade vive por
  // item, e um ponto é só um destino — pode existir sem itens aninhados.
  it('aceita multi-ponto com um ponto sem itens', () => {
    const r = pedidoFormSchema.safeParse({
      cliente_nome: 'X', valor_total: 10,
      pontos_retirada: [
        { tipo: 'loja', empresa_nome: 'Loja', itens: [item] },
        { tipo: 'entrega', empresa_nome: 'Cliente', itens: [] },
      ],
    });
    expect(r.success).toBe(true);
  });
  it('aceita híbrido com itens nos dois pontos', () => {
    const r = pedidoFormSchema.safeParse({
      cliente_nome: 'X', valor_total: 20,
      pontos_retirada: [
        { tipo: 'loja', empresa_nome: 'Loja', itens: [item] },
        { tipo: 'entrega', empresa_nome: 'Cliente', itens: [{ ...item, modalidade: 'entrega' as const }] },
      ],
    });
    expect(r.success).toBe(true);
  });
});
