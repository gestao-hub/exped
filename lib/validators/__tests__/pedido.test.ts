import { describe, it, expect } from 'vitest';
import { pedidoFormSchema } from '../pedido';
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

describe('pedidoFormSchema >=1 item por ponto (multi-ponto)', () => {
  const item = {
    codigo: 'A1', descricao: 'Produto', quantidade: 1, unidade: 'UN',
    preco_unitario: 10, desconto: 0, total: 10,
  };
  it('rejeita híbrido com bloco de entrega vazio', () => {
    const r = pedidoFormSchema.safeParse({
      cliente_nome: 'X', valor_total: 10,
      pontos_retirada: [
        { tipo: 'loja', empresa_nome: 'Loja', itens: [item] },
        { tipo: 'entrega', empresa_nome: 'Cliente', itens: [] },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'pontos_retirada.1.itens')).toBe(true);
    }
  });
  it('aceita híbrido com itens nos dois pontos', () => {
    const r = pedidoFormSchema.safeParse({
      cliente_nome: 'X', valor_total: 20,
      pontos_retirada: [
        { tipo: 'loja', empresa_nome: 'Loja', itens: [item] },
        { tipo: 'entrega', empresa_nome: 'Cliente', itens: [item] },
      ],
    });
    expect(r.success).toBe(true);
  });
});
